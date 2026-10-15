package envnode

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/AuraFirm/AuraLand/judge/internal/sign"
	"github.com/AuraFirm/AuraLand/judge/internal/tier2"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

const (
	agentUID = 1000
	agentGID = 1000
	// downloadBytesMax bounds what a presigned URL may make the node write to disk.
	downloadBytesMax = 4 << 30
)

// Runner implements agent.EnvRunner for a Tier-2 node.
type Runner struct {
	Runtime tier2.Runtime
	Key     ed25519.PrivateKey
	HTTP    *http.Client
	// WorkDir holds the per-run files (downloads, root file system, workspace); it must have room.
	WorkDir string
	// Extractor unpacks the downloaded archives; nil means in the agent's own process (see InProcessExtractor for why that is not the default of the command line).
	Extractor Extractor
	Logf      func(format string, args ...any)
}

// Run executes one leased environment run and returns the canonical trace and the node's signature of it.
func (r *Runner) Run(ctx context.Context, job wire.EnvJob) (string, string, error) {
	spec, err := ParseSpec(job.Environment.Spec)
	if err != nil {
		return "", "", err
	}
	root, err := os.MkdirTemp(r.WorkDir, "envrun-")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(root)
	layout, err := r.prepare(ctx, job, spec, root)
	if err != nil {
		return "", "", err
	}
	trace, err := r.execute(ctx, spec, layout)
	if err != nil {
		return "", "", err
	}
	canonical, err := trace.Canonical()
	if err != nil {
		return "", "", err
	}
	return string(canonical), sign.SignTrace(r.Key, canonical), nil
}

type layout struct{ rootfs, workspace, hidden, pristine, scratch string }

// prepare downloads and checks the two archives and lays the run out. The image is pinned by the digest in the spec, the
// hidden material by the hash the control plane stored; either mismatch ends the run before anything executes.
func (r *Runner) prepare(ctx context.Context, job wire.EnvJob, spec Spec, root string) (layout, error) {
	l := layout{rootfs: filepath.Join(root, "rootfs"), workspace: filepath.Join(root, "workspace"), hidden: filepath.Join(root, "hidden"),
		pristine: filepath.Join(root, "pristine"), scratch: filepath.Join(root, "scratch")}
	for _, dir := range []string{l.rootfs, l.workspace, l.hidden, l.pristine, l.scratch} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return l, err
		}
	}
	if err := r.fetchAndExtract(ctx, job.Environment.ImageDownloadURL, strings.TrimPrefix(spec.Image.Digest, "sha256:"), l.rootfs, root+"/image.tar"); err != nil {
		return l, fmt.Errorf("image: %w", err)
	}
	if err := r.fetchAndExtract(ctx, job.Environment.HiddenDownloadURL, job.Environment.HiddenSHA256, l.hidden, root+"/hidden.tar"); err != nil {
		return l, fmt.Errorf("hidden material: %w", err)
	}
	// The starting workspace is the image's own /work directory.
	seed := filepath.Join(l.rootfs, strings.TrimPrefix(spec.Agent.Workspace, "/"))
	if _, err := tier2.Snapshot(seed, l.workspace, int64(spec.Agent.DiskLimitMiB)<<20); err != nil {
		return l, fmt.Errorf("workspace: %w", err)
	}
	if _, err := tier2.Snapshot(l.workspace, l.pristine, int64(spec.Agent.DiskLimitMiB)<<20); err != nil {
		return l, err
	}
	return l, nil
}

func (r *Runner) fetchAndExtract(ctx context.Context, url, wantSHA256, into, tmp string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := r.HTTP.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download answered %d", response.StatusCode)
	}
	file, err := os.Create(tmp)
	if err != nil {
		return err
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, downloadBytesMax+1))
	file.Close()
	if err != nil {
		return err
	}
	if n > downloadBytesMax {
		return fmt.Errorf("larger than %d bytes", downloadBytesMax)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != wantSHA256 {
		return fmt.Errorf("its SHA-256 is %s, not the pinned %s", got, wantSHA256)
	}
	extractor := r.Extractor
	if extractor == nil {
		extractor = InProcessExtractor{Limits: DefaultLimits}
	}
	return extractor.Extract(ctx, tmp, into)
}

// execute runs the session, the integrity observation and the verifier, and builds the trace.
func (r *Runner) execute(ctx context.Context, spec Spec, l layout) (tier2.Trace, error) {
	watch, err := watchFor(spec)
	if err != nil {
		return tier2.Trace{}, err
	}
	canaries := make([]string, spec.Verifier.Canaries)
	var verifierEnv []string
	for i := range canaries {
		canaries[i] = tier2.Marker("CANARY")
		verifierEnv = append(verifierEnv, fmt.Sprintf("AURA_CANARY_%d=%s", i+1, canaries[i]))
	}
	watch.Canaries = canaries
	before, err := tier2.Observe(l.workspace, watch)
	if err != nil {
		return tier2.Trace{}, err
	}
	session := tier2.SessionSpec{
		Rootfs: l.rootfs, Workspace: l.workspace, WorkDir: spec.Agent.Workspace, UID: agentUID, GID: agentGID,
		Setup: spec.Setup, Agent: spec.Agent.Command,
		Limits: tier2.Limits{WallSeconds: spec.Agent.TimeLimitS, MemoryMiB: spec.Agent.MemoryLimitMiB, PIDs: spec.Agent.PidsLimit, DiskMiB: spec.Agent.DiskLimitMiB, OutputKiB: spec.Agent.OutputLimitKiB},
	}
	result, err := session.Run(ctx, r.Runtime)
	if err != nil {
		return tier2.Trace{}, err
	}
	if result.Outcome != "completed" {
		return tier2.BuildTrace(result, nil, nil)
	}
	after, err := tier2.Observe(l.workspace, watch)
	if err != nil {
		return tier2.Trace{}, err
	}
	verified := r.verify(ctx, spec, l, watch, verifierEnv)
	flags, err := tier2.Detect(watch, tier2.Evidence{Before: before, After: after, Stdout: result.Steps[len(result.Steps)-1].Result.Stdout, Dropped: verified.Snapshot.Dropped, Workspace: l.workspace})
	if err != nil {
		return tier2.Trace{}, err
	}
	return tier2.BuildTrace(result, flags, &verified)
}

// verify runs the verifier. A verifier that does not finish, or that prints something that is not a result, scores the run
// zero with the reason: an agent that makes the verifier fail must not escape a score by doing so.
func (r *Runner) verify(ctx context.Context, spec Spec, l layout, watch tier2.Watch, env []string) tier2.VerifierResult {
	v := tier2.VerifierSpec{
		Rootfs: l.rootfs, Hidden: l.hidden, Argv: spec.Verifier.Command, Env: env, UID: agentUID, GID: agentGID,
		Limits:   tier2.Limits{WallSeconds: spec.Verifier.TimeLimitS, MemoryMiB: spec.Verifier.MemoryLimitMiB, PIDs: spec.Agent.PidsLimit, DiskMiB: spec.Agent.DiskLimitMiB, OutputKiB: spec.Agent.OutputLimitKiB},
		Pristine: l.pristine, Restore: watch.Protected,
	}
	result, err := v.Verify(ctx, r.Runtime, l.workspace, l.scratch)
	if err != nil {
		return tier2.VerifierResult{Score: 0, Detail: truncate("the verifier gave no result: "+err.Error(), 1000), Snapshot: result.Snapshot}
	}
	return result
}

func watchFor(spec Spec) (tier2.Watch, error) {
	var w tier2.Watch
	for _, p := range spec.Integrity.ProtectedPaths {
		rel, err := relative(spec.Agent.Workspace, p)
		if err != nil {
			return w, err
		}
		w.Protected = append(w.Protected, rel)
	}
	for _, p := range spec.Integrity.Honeypots {
		rel, err := relative(spec.Agent.Workspace, p)
		if err != nil {
			return w, err
		}
		w.Honeypots = append(w.Honeypots, rel)
	}
	return w, nil
}

func truncate(text string, max int) string {
	text = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, text)
	if len(text) > max {
		return text[:max]
	}
	return text
}
