//go:build linux

package isolate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

// Box implements sandbox.Sandbox with the isolate binary. Run for the first time on 2026-10-12 on an
// Ubuntu 24.04 VM (aarch64, cgroup v2, isolate v2.1.1), where the escape suite in
// internal/isolate/escape_test.go (build tag `isolate`) passed after the fixes in this file. That VM is
// not the production node and nothing here has had the external review (cutlist F32).
type Box struct {
	// Binary is the absolute path of the isolate executable (setuid or with cgroup delegation).
	Binary string
	// ids hands out box ids; its capacity is the number of concurrent boxes.
	ids chan int
}

// New creates a Box with `concurrency` boxes (at most BoxIDMax+1).
func New(binary string, concurrency int) (*Box, error) {
	if !filepath.IsAbs(binary) {
		return nil, errors.New("the isolate binary must be an absolute path")
	}
	if concurrency < 1 || concurrency > BoxIDMax+1 {
		return nil, fmt.Errorf("concurrency %d out of range", concurrency)
	}
	ids := make(chan int, concurrency)
	for id := 0; id < concurrency; id++ {
		ids <- id
	}
	return &Box{Binary: binary, ids: ids}, nil
}

type program struct {
	box      *Box
	profile  Profile
	artifact []byte // the compiled file, or the source of an interpreted language
}

func (p *program) Release() { p.artifact = nil }

// boxDir is one initialised box: its working directory is <root>/box.
type boxDir struct {
	box  *Box
	id   int
	root string
	// metaDir holds isolate's report outside the box: <root> belongs to root and the box directory is
	// the sandboxed program's, so neither is a place the agent can write a report the program cannot touch.
	metaDir string
	once    sync.Once
}

func (b *Box) acquire(ctx context.Context) (*boxDir, error) {
	var id int
	select {
	case id = <-b.ids:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	out, err := b.isolate(ctx, InitArgs(id)...)
	if err != nil {
		b.ids <- id
		return nil, fmt.Errorf("init box %d: %w", id, err)
	}
	metaDir, err := os.MkdirTemp("", "aura-meta-")
	if err != nil {
		_, _ = b.isolate(context.Background(), CleanupArgs(id)...)
		b.ids <- id
		return nil, fmt.Errorf("meta directory for box %d: %w", id, err)
	}
	return &boxDir{box: b, id: id, root: strings.TrimSpace(string(out)), metaDir: metaDir}, nil
}

// release always cleans the box and gives its id back, whatever happened.
func (d *boxDir) release() {
	d.once.Do(func() {
		_, _ = d.box.isolate(context.Background(), CleanupArgs(d.id)...)
		_ = os.RemoveAll(d.metaDir)
		d.box.ids <- d.id
	})
}

func (d *boxDir) path(name string) string { return filepath.Join(d.root, "box", name) }

func (b *Box) isolate(ctx context.Context, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, b.Binary, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	out, err := command.Output()
	if err != nil {
		return out, fmt.Errorf("%w: %s", err, truncateText(stderr.String(), 300))
	}
	return out, nil
}

func truncateText(text string, max int) string {
	if len(text) > max {
		return text[:max]
	}
	return text
}

type stepKind int

const (
	stepCompile stepKind = iota
	stepRun
)

// compileMessageBytesMax bounds the compiler diagnostics kept for a compile error.
const compileMessageBytesMax = 4096

// execute runs one command in an acquired box and returns isolate's report and the capped output.
func (d *boxDir) execute(ctx context.Context, profile Profile, limits sandbox.Limits, step stepKind, command []string, stdin []byte) (Meta, []byte, error) {
	if err := os.WriteFile(d.path("stdin"), stdin, 0o644); err != nil {
		return Meta{}, nil, err
	}
	metaFile := filepath.Join(d.metaDir, "meta")
	fileKiB, processes, stderrFile, outputCapBytes := limits.OutputKiB, profile.RunProcesses, "stderr", limits.OutputKiB*1024+1
	if step == stepCompile {
		// Compiler diagnostics are the participant's compile error: merge them and keep only a bounded part.
		fileKiB, processes, stderrFile, outputCapBytes = CompileFileKiBMax, profile.CompileProcesses, "", compileMessageBytesMax
	}
	args, err := RunArgs(d.id, limits, fileKiB, processes, metaFile, "stdin", "stdout", stderrFile, profile.Environment, profile.Directories, command)
	if err != nil {
		return Meta{}, nil, err
	}
	// isolate exits non-zero when the program fails; that is not our error. Its meta file tells.
	_, runErr := d.box.isolate(ctx, args...)
	metaText, readErr := os.ReadFile(metaFile)
	if readErr != nil {
		return Meta{}, nil, fmt.Errorf("no meta file (isolate said: %v)", runErr)
	}
	meta, err := ParseMeta(string(metaText))
	if err != nil {
		return Meta{}, nil, err
	}
	output, err := readCapped(d.path("stdout"), outputCapBytes)
	return meta, output, err
}

func readCapped(path string, max int) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, int64(max)))
}

// Compile builds the submission in its own box. Interpreted languages skip the compiler.
func (b *Box) Compile(ctx context.Context, language, source string, limits sandbox.Limits) (sandbox.CompileResult, error) {
	profile, err := ProfileFor(language)
	if err != nil {
		return sandbox.CompileResult{}, err
	}
	if profile.Compile == nil {
		return sandbox.CompileResult{OK: true, Program: &program{box: b, profile: profile, artifact: []byte(source)}}, nil
	}
	dir, err := b.acquire(ctx)
	if err != nil {
		return sandbox.CompileResult{}, err
	}
	defer dir.release()
	if err := os.WriteFile(dir.path(profile.SourceName), []byte(source), 0o644); err != nil {
		return sandbox.CompileResult{}, err
	}
	meta, output, err := dir.execute(ctx, profile, limits, stepCompile, profile.Compile, nil)
	if err != nil {
		return sandbox.CompileResult{}, err
	}
	switch Verdict(meta, limits, len(output)) {
	case "SE":
		return sandbox.CompileResult{}, errors.New("sandbox failure while compiling")
	case "OK":
		binary, err := os.ReadFile(dir.path("main"))
		if err != nil {
			return sandbox.CompileResult{OK: false, Message: "the compiler produced no program"}, nil
		}
		return sandbox.CompileResult{OK: true, Program: &program{box: b, profile: profile, artifact: binary}}, nil
	default:
		return sandbox.CompileResult{OK: false, Message: sanitize(output)}, nil
	}
}

// sanitize bounds compiler output and removes control characters: it is data from hostile code.
func sanitize(output []byte) string {
	if len(output) > 2048 {
		output = output[:2048]
	}
	cleaned := make([]rune, 0, len(output))
	for _, r := range string(output) {
		if r < 0x20 && r != '\n' && r != '\t' || r == 0x7f {
			r = ' '
		}
		cleaned = append(cleaned, r)
	}
	return string(cleaned)
}

// Run runs the program on one input in a fresh box that holds nothing but the program.
func (b *Box) Run(ctx context.Context, p sandbox.Program, stdin []byte, limits sandbox.Limits) (sandbox.RunResult, error) {
	prog, ok := p.(*program)
	if !ok || prog.artifact == nil {
		return sandbox.RunResult{}, errors.New("not a program of this sandbox, or already released")
	}
	dir, err := b.acquire(ctx)
	if err != nil {
		return sandbox.RunResult{}, err
	}
	defer dir.release()
	name := prog.profile.SourceName
	if prog.profile.Compile != nil {
		name = "main"
	}
	if err := os.WriteFile(dir.path(name), prog.artifact, 0o755); err != nil {
		return sandbox.RunResult{}, err
	}
	held, command := prog.profile.forRun(limits)
	meta, output, err := dir.execute(ctx, prog.profile, held, stepRun, command, stdin)
	if err != nil {
		return sandbox.RunResult{}, err
	}
	return sandbox.RunResult{
		Verdict:   Verdict(meta, held, len(output)),
		CPUMS:     int(meta.CPUSeconds * 1000),
		WallMS:    int(meta.WallSeconds * 1000),
		MemoryKiB: meta.CgMemKiB,
		Stdout:    output,
		ExitCode:  meta.ExitCode,
		Signaled:  meta.HasExitSignal,
	}, nil
}

var _ sandbox.Sandbox = (*Box)(nil)
