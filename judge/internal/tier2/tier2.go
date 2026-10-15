// Package tier2 runs an agent's environment: a long-lived command in a prepared root file system with a
// writable workspace, under limits and with no network unless the recipe allows it. It is the Tier-2
// counterpart of package sandbox (docs/kit/07 section 5) and, like it, the only way this agent executes
// hostile code.
//
// The one implementation is gVisor (runsc). A Firecracker driver is NOT written: no KVM host has been
// available to run one, and a driver nobody has run is a claim without observation (ADR 0034, cutlist F68).
// Every Result says which isolation produced it, because the control plane limits what a gVisor result may
// be used for.
package tier2

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Isolation names what contained a run. Only "gvisor" exists today.
const IsolationGVisor = "gvisor"

// Limits are the resources one run may use. A zero value is never valid.
type Limits struct {
	WallSeconds int
	MemoryMiB   int
	PIDs        int
	DiskMiB     int
	OutputKiB   int
}

// Env describes one run. Rootfs is a directory holding the image's file system (read-only inside the
// sandbox). Workspace is a directory on the host that appears writable at WorkDir; what the agent leaves
// there is what the verifier later receives. The Env never names a host path other than these two.
// Mount is a host directory shown read-only inside the sandbox. Only the verifier uses it; the workspace is the only
// writable host path an Env can name.
type Mount struct {
	Host string
	Dest string
}

type Env struct {
	Rootfs    string
	Workspace string
	WorkDir   string // absolute, inside the sandbox
	Argv      []string
	Env       []string // KEY=VALUE pairs; nothing else from the host is passed
	UID, GID  int
	Limits    Limits
	// CgroupName, when set, places the sandbox in /aura/<name> so its memory and process counters can be read after it ends.
	CgroupName string
	// Mounts are read-only host directories (the verifier's hidden material); never writable, never the workspace.
	Mounts []Mount
}

// Result is what the sandbox itself observed. Whether the agent succeeded at its task is decided elsewhere.
type Result struct {
	// Verdict: "OK" (exited by itself), "TLE" (wall limit), "MLE" (memory limit), "OLE" (output limit),
	// "RTE" (killed by a signal or failed to start) or "SE" (the sandbox itself failed).
	Verdict   string
	ExitCode  int
	Signaled  bool
	WallMS    int
	Stdout    []byte // capped at Limits.OutputKiB
	Isolation string
	// Diagnostics is what the sandbox itself said (bounded); for logs and tests, never shown to a candidate or customer.
	Diagnostics string
	// PeakMemoryMiB, OOMKills and PidsLimitHit come from the sandbox's cgroup when the driver could read it; they are
	// evidence for the verdict (and for integrity flags), not part of it.
	PeakMemoryMiB int
	OOMKills      int
	PidsLimitHit  bool
	PidsPeak      int
}

// Runtime is the interface the agent and the tests use.
type Runtime interface {
	Run(ctx context.Context, env Env) (Result, error)
}

// Validate refuses an Env that could not be run safely or sensibly. It is called by every Runtime before it touches
// the host.
func (e Env) Validate() error {
	var problems []string
	if e.Rootfs == "" || !strings.HasPrefix(e.Rootfs, "/") {
		problems = append(problems, "rootfs must be an absolute path")
	}
	if e.Workspace == "" || !strings.HasPrefix(e.Workspace, "/") {
		problems = append(problems, "workspace must be an absolute host path")
	}
	if !strings.HasPrefix(e.WorkDir, "/") || strings.Contains(e.WorkDir, "..") || e.WorkDir == "/" {
		problems = append(problems, "work dir must be an absolute path inside the sandbox, not the root")
	}
	if len(e.Argv) == 0 || e.Argv[0] == "" {
		problems = append(problems, "a command is needed")
	}
	for _, a := range e.Argv {
		if strings.ContainsRune(a, 0) {
			problems = append(problems, "no NUL byte in an argument")
		}
	}
	for _, kv := range e.Env {
		if !strings.Contains(kv, "=") || strings.ContainsRune(kv, 0) {
			problems = append(problems, "environment entries are KEY=VALUE")
		}
	}
	for _, m := range e.Mounts {
		if !strings.HasPrefix(m.Host, "/") || m.Host == "/" || !strings.HasPrefix(m.Dest, "/") || strings.Contains(m.Dest, "..") ||
			m.Dest == "/" || m.Dest == e.WorkDir || strings.HasPrefix(m.Dest, "/proc") || strings.HasPrefix(m.Dest, "/tmp") {
			problems = append(problems, "a mount names an absolute host directory and a destination that is not the root, the work dir, /proc or /tmp")
		}
	}
	l := e.Limits
	if l.WallSeconds < 1 || l.MemoryMiB < 16 || l.PIDs < 1 || l.DiskMiB < 1 || l.OutputKiB < 1 {
		problems = append(problems, "every limit must be set")
	}
	if e.UID <= 0 || e.GID <= 0 {
		problems = append(problems, "the agent never runs as root inside the sandbox")
	}
	if len(problems) > 0 {
		return errors.New(fmt.Sprint("invalid environment: ", strings.Join(problems, "; ")))
	}
	return nil
}
