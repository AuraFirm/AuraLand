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
	"strings"
	"syscall"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/agent"
	"github.com/AuraFirm/AuraLand/judge/internal/bundles"
	"github.com/AuraFirm/AuraLand/judge/internal/client"
	"github.com/AuraFirm/AuraLand/judge/internal/isolate"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/validate"
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
	concurrency := flags.Int("concurrency", 1, "boxes available at once")
	flags.Parse(args)
	if *plane == "" || *nodeID == "" || *keyFile == "" || *openerFile == "" {
		fmt.Fprintln(os.Stderr, "run needs --control-plane, --node-id, --key-file and --opener-file")
		return 2
	}
	if err := serve(*plane, *nodeID, *keyFile, *isolateBin, *openerFile, *concurrency); err != nil {
		fmt.Fprintln(os.Stderr, "run:", err)
		return 1
	}
	return 0
}

func serve(plane, nodeID, keyFile, isolateBin, openerFile string, concurrency int) error {
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
