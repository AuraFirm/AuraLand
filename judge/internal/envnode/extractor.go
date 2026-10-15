package envnode

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/AuraFirm/AuraLand/judge/internal/tier2"
)

// Extractor unpacks a downloaded archive (already checked against its pinned SHA-256) into an empty directory.
type Extractor interface {
	Extract(ctx context.Context, archivePath, into string) error
}

// InProcessExtractor unpacks in the node agent's own process: hardened and tested, but it parses an archive outside any sandbox,
// which the repository rule forbids for untrusted input. It remains for nodes that cannot spare the memory for the sandboxed way,
// and is chosen explicitly (--tier2-extract=in-process), never by default.
type InProcessExtractor struct{ Limits ExtractLimits }

func (e InProcessExtractor) Extract(_ context.Context, archivePath, into string) error {
	archive, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer archive.Close()
	return Extract(archive, into, e.Limits)
}

// SandboxExtractor unpacks inside a gVisor sandbox (cutlist F70). The sandbox holds one program, the node's own binary run as
// `extract-archive`, and nothing else: no network, no host paths except the archive (read-only) and the output directory, which is a
// memory file system of exactly the size limit. A hostile archive can therefore break the extractor's rules and the extractor can
// still do no harm outside that box. The output is copied back without following links, as for any workspace.
type SandboxExtractor struct {
	Runtime tier2.Runtime
	// Rootfs is a directory holding only the helper binary; NewSandboxExtractor makes it.
	Rootfs string
	// LimitMiB bounds the unpacked size. The output lives in memory while it is unpacked, so this is also what one unpack costs a node.
	LimitMiB int
}

const (
	helperName        = "extract"
	extractWallSecond = 600
	extractMemoryMiB  = 256
	// The sandbox's own helper processes count against this limit, so a low number stops it from starting at all.
	extractPIDs      = 64
	extractOutputKiB = 16
	nobody           = 1000
)

// NewSandboxExtractor builds the helper's root file system (a copy of the node's binary, which must be statically linked) and runs
// it once on an empty archive: a node whose sandbox cannot run the helper refuses to start rather than fail on a customer's run.
func NewSandboxExtractor(ctx context.Context, rt tier2.Runtime, helperBinary, rootfs string, limitMiB int) (*SandboxExtractor, error) {
	if limitMiB < 1 {
		return nil, fmt.Errorf("extract limit must be at least 1 MiB")
	}
	if err := os.RemoveAll(rootfs); err != nil {
		return nil, err
	}
	// The mount points (ours and the sandbox's own /proc, /dev and /sys) must exist in the read-only root file system.
	for _, dir := range []string{"work", "in", "tmp", "proc", "dev", "sys"} {
		if err := os.MkdirAll(filepath.Join(rootfs, dir), 0o755); err != nil {
			return nil, err
		}
	}
	if err := copyExecutable(helperBinary, filepath.Join(rootfs, helperName)); err != nil {
		return nil, err
	}
	e := &SandboxExtractor{Runtime: rt, Rootfs: rootfs, LimitMiB: limitMiB}
	probe, err := os.MkdirTemp(filepath.Dir(rootfs), "extract-probe-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(probe)
	empty := filepath.Join(probe, "empty.tar")
	if err := os.WriteFile(empty, make([]byte, 1024), 0o600); err != nil { // two zero blocks: a valid, empty tar
		return nil, err
	}
	if err := e.Extract(ctx, empty, filepath.Join(probe, "out")); err != nil {
		return nil, fmt.Errorf("the sandboxed extractor does not run (is the node binary built with CGO_ENABLED=0?): %w", err)
	}
	return e, nil
}

func copyExecutable(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func (e *SandboxExtractor) Extract(ctx context.Context, archivePath, into string) error {
	if err := os.MkdirAll(into, 0o755); err != nil {
		return err
	}
	// The sandbox sees a directory with this one archive in it, never the run directory that holds the other archives.
	inDir := into + ".in"
	if err := os.MkdirAll(inDir, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(inDir)
	// The sandbox runs as another user and must be able to read the archive (read-only: it is mounted that way).
	if err := os.Chmod(archivePath, 0o644); err != nil {
		return err
	}
	base := "archive.tar"
	if err := os.Link(archivePath, filepath.Join(inDir, base)); err != nil {
		return fmt.Errorf("staging the archive: %w", err)
	}
	result, err := e.Runtime.Run(ctx, tier2.Env{
		Rootfs: e.Rootfs, Workspace: into, WorkDir: "/work", UID: nobody, GID: nobody,
		Argv:   []string{"/" + helperName, "extract-archive", "--archive", "/in/" + base, "--into", "/work", "--limit-mib", fmt.Sprint(e.LimitMiB)},
		Mounts: []tier2.Mount{{Host: inDir, Dest: "/in"}},
		Limits: tier2.Limits{WallSeconds: extractWallSecond, MemoryMiB: extractMemoryMiB, PIDs: extractPIDs, DiskMiB: e.LimitMiB, OutputKiB: extractOutputKiB},
	})
	if err != nil {
		return fmt.Errorf("extractor: %w", err)
	}
	if result.Verdict != "OK" || result.ExitCode != 0 {
		return fmt.Errorf("extractor: %s (exit %d): %s %s", result.Verdict, result.ExitCode, printable(result.Stdout), printable([]byte(result.Diagnostics)))
	}
	return nil
}

// printable keeps what the helper said readable and short: it may contain names from a hostile archive.
func printable(raw []byte) string {
	var b strings.Builder
	for _, r := range string(raw) {
		if b.Len() >= 200 {
			break
		}
		if r >= 0x20 && r < 0x7f {
			b.WriteRune(r)
		} else {
			b.WriteByte('?')
		}
	}
	return strings.TrimSpace(b.String())
}
