//go:build linux

package tier2

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// GVisor runs environments in gVisor's runsc. Written and run for the first time on 2026-10-15 on an Ubuntu 24.04
// VM (aarch64, cgroup v2, runsc release-20261005.0, systrap platform; this VM has no KVM). It is NOT the production
// node and has had no external review. gVisor exposes far less of the host kernel than a container but more than a
// microVM, so every result carries Isolation = "gvisor" and the control plane limits what such a result may support.
type GVisor struct {
	// Binary is the absolute path of runsc.
	Binary string
	// Elevate is the command prefix that gives runsc the privileges it needs (for example {"sudo", "-n"}); a node that
	// delegates cgroups to the agent's user can leave it empty.
	Elevate []string
	// BaseDir holds the per-run state; it must be on a file system with room for the bundle.
	BaseDir string

	counter atomic.Int64
}

const (
	stderrBytesMax = 16 << 10
	cgroupRoot     = "/sys/fs/cgroup/aura"
	adminTimeout   = 10 * time.Second
)

// capped keeps at most limit bytes and remembers that it was offered more.
type capped struct {
	buf      bytes.Buffer
	limit    int
	exceeded atomic.Bool
}

func (c *capped) Write(p []byte) (int, error) {
	room := c.limit - c.buf.Len()
	if room > 0 {
		c.buf.Write(p[:min(len(p), room)])
	}
	if len(p) > room {
		c.exceeded.Store(true)
	}
	return len(p), nil
}

func (g *GVisor) runsc(ctx context.Context, state string, args ...string) *exec.Cmd {
	full := append(append([]string{}, g.Elevate...), g.Binary, "--root", state, "--platform", "systrap", "--network", "none")
	full = append(full, args...)
	return exec.CommandContext(ctx, full[0], full[1:]...)
}

// Run executes one environment to completion or to its first limit. Everything it creates is under BaseDir and is
// removed before it returns. The container is created, started and waited for in separate steps so that its cgroup
// still exists when its counters are read.
func (g *GVisor) Run(ctx context.Context, env Env) (Result, error) {
	id := fmt.Sprintf("aura-%d-%d", os.Getpid(), g.counter.Add(1))
	env.CgroupName = id
	if err := env.Validate(); err != nil {
		return Result{}, err
	}
	dir := filepath.Join(g.BaseDir, id)
	state := filepath.Join(dir, "state")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Result{}, err
	}
	hostWorkspace := env.Workspace
	// The agent writes into a memory file system of exactly the disk limit, not into the host's disk: a per-file size
	// limit alone lets many files fill whatever the workspace lives on (the escape suite's disk_fill probe found this).
	scratch := filepath.Join(dir, "work")
	defer func() {
		// runsc leaves its empty network namespace bind-mounted in the state directory; unmount it first.
		g.unmount(filepath.Join(state, "null-netns"))
		g.unmount(scratch)
		_ = os.RemoveAll(dir)
	}()
	if err := g.prepareWorkspace(scratch, hostWorkspace, env); err != nil {
		return Result{Verdict: "SE", Isolation: IsolationGVisor}, err
	}
	env.Workspace = scratch
	config, err := Spec(env)
	if err != nil {
		return Result{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), config, 0o600); err != nil {
		return Result{}, err
	}
	started := time.Now()
	stdout := &capped{limit: env.Limits.OutputKiB << 10}
	stderr := &capped{limit: stderrBytesMax}
	cmd := g.runsc(context.WithoutCancel(ctx), state, "run", "--bundle", dir, id)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	watcher := newCgroupWatcher(id)
	if err := cmd.Start(); err != nil {
		return Result{Verdict: "SE", Isolation: IsolationGVisor}, err
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	defer g.delete(state, id)
	exit, timedOut, outputKilled := g.supervise(ctx, env, state, id, stdout, watcher, waited)
	if err := g.collectWorkspace(scratch, hostWorkspace); err != nil {
		return Result{Verdict: "SE", Isolation: IsolationGVisor}, err
	}
	result := classify(exit, timedOut, outputKilled || stdout.exceeded.Load(), stdout.buf.Bytes(), time.Since(started), stderr.buf.String())
	watcher.apply(&result, env.Limits)
	return result, nil
}

// supervise waits for the run to end, enforcing the wall limit and the output cap as it goes, and samples the cgroup
// while the sandbox is alive (the kernel removes it the moment the sandbox ends).
func (g *GVisor) supervise(ctx context.Context, env Env, state, id string, stdout *capped, w *cgroupWatcher, waited chan error) (exit int, timedOut, outputKilled bool) {
	wall := time.NewTimer(time.Duration(env.Limits.WallSeconds) * time.Second)
	defer wall.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-waited:
			return exitStatus(err), timedOut, outputKilled
		case <-wall.C:
			timedOut = true
			g.kill(state, id)
		case <-ctx.Done():
			timedOut = true
			g.kill(state, id)
		case <-tick.C:
			w.sample()
			if stdout.exceeded.Load() && !outputKilled {
				outputKilled = true
				g.kill(state, id)
			}
		}
	}
}

func exitStatus(err error) int {
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	return -1
}

// elevated runs a helper command (mount, cp, find) with the node's privilege prefix.
func (g *GVisor) elevated(name string, args ...string) error {
	full := append(append(append([]string{}, g.Elevate...), name), args...)
	if out, err := exec.Command(full[0], full[1:]...).CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// prepareWorkspace makes a size-limited memory file system owned by the agent's user and copies the workspace into it.
func (g *GVisor) prepareWorkspace(scratch, workspace string, env Env) error {
	if err := os.MkdirAll(scratch, 0o700); err != nil {
		return err
	}
	options := fmt.Sprintf("size=%dm,uid=%d,gid=%d,mode=0700,nosuid,nodev,strictatime", env.Limits.DiskMiB, env.UID, env.GID)
	if err := g.elevated("mount", "-t", "tmpfs", "-o", options, "tmpfs", scratch); err != nil {
		return err
	}
	if err := g.elevated("cp", "-a", "--no-dereference", workspace+"/.", scratch); err != nil {
		return err
	}
	// The host copy belongs to the node's user, which cannot chown it to anyone else; the in-memory copy is ours to give.
	if err := g.elevated("chown", "-R", "-h", fmt.Sprintf("%d:%d", env.UID, env.GID), scratch); err != nil {
		return err
	}
	// Access times start at the epoch, so that any later read by the agent (the file system records access times
	// strictly) is visible as a time after it; copying the files in must not look like a read.
	return g.elevated("find", scratch, "-type", "f", "-exec", "touch", "-a", "-d", "@0", "{}", "+")
}

// collectWorkspace replaces the host workspace's contents with what the agent left. Links are copied as links and never
// followed; nothing here reads a file the agent wrote.
func (g *GVisor) collectWorkspace(scratch, workspace string) error {
	if err := g.elevated("find", workspace, "-mindepth", "1", "-delete"); err != nil {
		return err
	}
	if err := g.elevated("cp", "-a", "--no-dereference", scratch+"/.", workspace); err != nil {
		return err
	}
	// Back to the node's own user, so that hashing, snapshots and cleanup need no privilege.
	return g.elevated("chown", "-R", "-h", fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid()), workspace)
}

func (g *GVisor) unmount(path string) {
	full := append(append([]string{}, g.Elevate...), "umount", "-l", path)
	_ = exec.Command(full[0], full[1:]...).Run()
}

func (g *GVisor) kill(state, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_ = g.runsc(ctx, state, "kill", id, "KILL").Run()
}

func (g *GVisor) delete(state, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_ = g.runsc(ctx, state, "delete", "--force", id).Run()
}

// cgroupWatcher remembers the largest counters it saw while the sandbox was alive: peak memory, memory-limit kills and
// whether the process limit was reached. They are evidence for the verdict, sampled every few milliseconds.
type cgroupWatcher struct {
	dir     string
	peak    int64
	oom     int64
	pidsMax int64
	pidsTop int64
}

func newCgroupWatcher(id string) *cgroupWatcher {
	return &cgroupWatcher{dir: filepath.Join(cgroupRoot, id)}
}

func (w *cgroupWatcher) sample() {
	if peak, ok := readInt(filepath.Join(w.dir, "memory.peak")); ok {
		w.peak = max(w.peak, peak)
	}
	w.oom = max(w.oom, eventCount(filepath.Join(w.dir, "memory.events"), "oom_kill"))
	w.pidsMax = max(w.pidsMax, eventCount(filepath.Join(w.dir, "pids.events"), "max"))
	if top, ok := readInt(filepath.Join(w.dir, "pids.peak")); ok {
		w.pidsTop = max(w.pidsTop, top)
	}
}

// apply adds the counters to a result and upgrades a kill to MLE when the kernel counted a memory-limit kill, or when
// the sandbox was killed having come within a tenth of its limit.
func (w *cgroupWatcher) apply(r *Result, limits Limits) {
	r.PeakMemoryMiB = int(w.peak >> 20)
	r.OOMKills = int(w.oom)
	r.PidsLimitHit = w.pidsMax > 0
	r.PidsPeak = int(w.pidsTop)
	nearLimit := w.peak >= int64(limits.MemoryMiB)<<20*9/10
	if r.Verdict == "RTE" && r.Signaled && (w.oom > 0 || nearLimit) {
		r.Verdict = "MLE"
	}
}

func readInt(path string) (int64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	return n, err == nil
}

func eventCount(path, key string) int64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if name, value, ok := strings.Cut(line, " "); ok && name == key {
			n, _ := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
			return n
		}
	}
	return 0
}

// classify turns how the process ended into the sandbox's own verdict. A program that ends by itself with a status,
// even a failing one, is the agent finishing its phase: the verifier decides whether that was a success. Only a kill is
// a runtime error; readCgroup upgrades a kill to MLE when the kernel counted a memory-limit kill.
func classify(exit int, timedOut, outputOver bool, stdout []byte, wall time.Duration, stderr string) Result {
	r := Result{Verdict: "OK", ExitCode: exit, Diagnostics: stderr, Stdout: append([]byte{}, stdout...), WallMS: int(wall.Milliseconds()), Isolation: IsolationGVisor}
	switch {
	case timedOut:
		r.Verdict = "TLE"
	case outputOver:
		r.Verdict = "OLE"
	case exit < 0:
		r.Verdict = "SE"
	case exit > 128:
		r.Signaled = true
		r.Verdict = "RTE"
	}
	return r
}
