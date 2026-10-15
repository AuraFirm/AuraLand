//go:build linux

package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/agent"
	"github.com/AuraFirm/AuraLand/judge/internal/bundles"
	"github.com/AuraFirm/AuraLand/judge/internal/client"
	"github.com/AuraFirm/AuraLand/judge/internal/envnode"
	"github.com/AuraFirm/AuraLand/judge/internal/isolate"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/tier2"
	"github.com/AuraFirm/AuraLand/judge/internal/validate"
	"github.com/AuraFirm/AuraLand/judge/internal/watermark"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// Timings of the node's loop. A beat every 15 s keeps last_seen fresh without load; long polling for
// work waits at most 5 s so a drain or a stop is noticed quickly.
const (
	beatEvery   = 15 * time.Second
	idleWait    = 2 * time.Second
	leaseWaitMS = 5_000
	httpTimeout = 60 * time.Second
)

func run(args []string) int {
	flags := flag.NewFlagSet("run", flag.ExitOnError)
	plane := flags.String("control-plane", "", "control plane address ending in /api/judge/v1")
	nodeID := flags.String("node-id", "", "node id printed by enroll")
	keyFile := flags.String("key-file", "", "the node's private key file")
	isolateBin := flags.String("isolate-bin", "/usr/local/bin/isolate", "absolute path of the isolate binary")
	openerFile := flags.String("opener-file", "", "the built bundle opener (packages/bundle/dist/open-bundle.cjs)")
	rewriterFile := flags.String("rewriter-file", "", "the built delivery rewriter (packages/bundle/dist/rewrite-bundle.cjs); without it the node takes no watermark jobs")
	concurrency := flags.Int("concurrency", 1, "boxes available at once")
	runsc := flags.String("tier2-runsc", "", "absolute path of runsc; with it the node takes Tier-2 environment runs (gVisor, lower assurance: see ADR 0034)")
	tier2Dir := flags.String("tier2-dir", "/var/lib/aura/tier2", "directory for Tier-2 run files; needs room for images")
	elevate := flags.String("tier2-elevate", "", "command prefix that gives runsc its privileges, for example 'sudo -n'")
	extract := flags.String("tier2-extract", "sandbox", "where image and hidden-material archives are unpacked: 'sandbox' (a gVisor sandbox, the default) or 'in-process' (the agent's own process; the repository rule forbids this for untrusted archives, so use it only knowingly)")
	extractMiB := flags.Int("tier2-extract-mib", 1024, "most MiB one archive may unpack to; a sandboxed unpack holds this in memory")
	flags.Parse(args)
	if *plane == "" || *nodeID == "" || *keyFile == "" || *openerFile == "" {
		fmt.Fprintln(os.Stderr, "run needs --control-plane, --node-id, --key-file and --opener-file")
		return 2
	}
	tier2Config := tier2Settings{runsc: *runsc, dir: *tier2Dir, elevate: strings.Fields(*elevate), extract: *extract, extractMiB: *extractMiB}
	if err := serve(*plane, *nodeID, *keyFile, *isolateBin, *openerFile, *rewriterFile, *concurrency, tier2Config); err != nil {
		fmt.Fprintln(os.Stderr, "run:", err)
		return 1
	}
	return 0
}

type tier2Settings struct {
	runsc, dir string
	elevate    []string
	extract    string
	extractMiB int
}

func serve(plane, nodeID, keyFile, isolateBin, openerFile, rewriterFile string, concurrency int, tier2Config tier2Settings) error {
	key, err := readKey(keyFile)
	if err != nil {
		return err
	}
	script, err := os.ReadFile(openerFile)
	if err != nil {
		return fmt.Errorf("opener file: %w", err)
	}
	box, err := isolate.New(isolateBin, concurrency)
	if err != nil {
		return err
	}
	control, err := client.New(plane, nodeID, key, &http.Client{Timeout: httpTimeout}, time.Now)
	if err != nil {
		return err
	}
	opener := &bundles.Opener{
		Box:    box,
		Script: string(script),
		Fetch: func(ctx context.Context, jobID string, bundle wire.Bundle) ([]byte, error) {
			return control.FetchBundle(ctx, jobID, bundle)
		},
	}
	node := &agent.Agent{
		Plane: control, Box: box, Bundles: opener, Validator: &validate.Runner{Box: box, Open: opener}, Version: version, LeaseWaitMS: leaseWaitMS,
		Logf:     func(format string, args ...any) { fmt.Fprintf(os.Stderr, "aura-judge: "+format+"\n", args...) },
		SelfTest: smokeTest(box),
	}
	if rewriterFile != "" {
		watermarker, err := newWatermarker(control, box, rewriterFile, string(script))
		if err != nil {
			return err
		}
		node.Watermarker = watermarker
	}
	if tier2Config.runsc != "" {
		if err := os.MkdirAll(tier2Config.dir, 0o755); err != nil {
			return err
		}
		runtime := &tier2.GVisor{Binary: tier2Config.runsc, Elevate: tier2Config.elevate, BaseDir: tier2Config.dir}
		// What a node that died left behind is cleaned up before this one takes work (cutlist F71).
		swept, err := runtime.SweepStale()
		if err != nil {
			return fmt.Errorf("sweeping stale sandboxes: %w", err)
		}
		if swept > 0 {
			node.Logf("removed %d stale sandbox(es) left by a node that is gone", swept)
		}
		extractor, err := makeExtractor(runtime, tier2Config)
		if err != nil {
			return err
		}
		node.EnvRunner = &envnode.Runner{
			Runtime: runtime, Extractor: extractor,
			Key: key, HTTP: &http.Client{Timeout: 10 * time.Minute}, WorkDir: tier2Config.dir,
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	node.Logf("serving as %s", nodeID)
	node.Serve(ctx, beatEvery, idleWait)
	return nil
}

// readKey reads the seed that `enroll` wrote and refuses a key file other users can read.
func readKey(path string) (ed25519.PrivateKey, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("key file: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("key file %s must be readable by its owner only", path)
	}
	text, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(text)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("key file %s is not a node key", path)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// smokeTest is the node's canary until the escape suite runs as part of start-up: it only proves that
// the box can compile and run a trivial program. It is NOT a security check; the escape suite
// (judge/node/README.md section 4) must be run by the operator before enrolling. The answer is cached:
// a compile per heartbeat would cost more than it tells.
func smokeTest(box sandbox.Sandbox) func(context.Context) bool {
	var done, ok bool
	return func(ctx context.Context) bool {
		if done {
			return ok
		}
		limits := sandbox.Limits{CPUMS: 10_000, WallMS: 30_000, MemoryKiB: 512 * 1024, OutputKiB: 64}
		compiled, err := box.Compile(ctx, "cpp", "int main(){return 0;}\n", limits)
		if err == nil && compiled.OK {
			var run sandbox.RunResult
			run, err = box.Run(ctx, compiled.Program, nil, limits)
			compiled.Program.Release()
			ok = err == nil && run.Verdict == "OK"
		}
		done = ctx.Err() == nil
		return ok
	}
}

// newWatermarker builds the delivery watermark runner: the rewriter box, the download of the original, the
// upload of the rewrite, and a validation harness for any bundle's bytes.
func newWatermarker(control *client.Client, box sandbox.Sandbox, rewriterFile, openerScript string) (*watermark.Runner, error) {
	script, err := os.ReadFile(rewriterFile)
	if err != nil {
		return nil, fmt.Errorf("rewriter file: %w", err)
	}
	return &watermark.Runner{
		Rewriter: &bundles.Rewriter{Box: box, Script: string(script)},
		Fetch: func(ctx context.Context, jobID string, bundle wire.Bundle) ([]byte, error) {
			return control.FetchBundle(ctx, jobID, bundle)
		},
		Upload: func(ctx context.Context, job wire.WatermarkJob, data []byte) (string, error) {
			target, err := control.WatermarkUploadTarget(ctx, job.JobID, job.LeaseEpoch, len(data))
			if err != nil {
				return "", err
			}
			if err := control.PutBundle(ctx, target.URL, data); err != nil {
				return "", err
			}
			return target.UploadID, nil
		},
		Harness: func(packed []byte) *validate.Runner {
			// An opener that serves these very bytes: the harness must see this bundle, not the job's.
			fetch := func(context.Context, string, wire.Bundle) ([]byte, error) { return packed, nil }
			return &validate.Runner{Box: box, Open: &bundles.Opener{Box: box, Script: openerScript, Fetch: fetch}}
		},
	}, nil
}

// makeExtractor chooses where archives are unpacked. The sandboxed way runs this very binary inside a gVisor sandbox, so the binary must
// be statically linked (CGO_ENABLED=0); the node proves it can before it takes work.
func makeExtractor(runtime *tier2.GVisor, config tier2Settings) (envnode.Extractor, error) {
	switch config.extract {
	case "in-process":
		return envnode.InProcessExtractor{Limits: envnode.DefaultLimits}, nil
	case "sandbox":
		self, err := os.Executable()
		if err != nil {
			return nil, err
		}
		return envnode.NewSandboxExtractor(context.Background(), runtime, self, filepath.Join(config.dir, "extractor-rootfs"), config.extractMiB)
	default:
		return nil, fmt.Errorf("--tier2-extract must be 'sandbox' or 'in-process', not %q", config.extract)
	}
}
