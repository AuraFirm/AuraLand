//go:build linux && gvisor

package tier2

import (
	"context"
	"os"
	"runtime"
	"sort"
	"sync"
	"testing"
	"time"
)

// Measurements for the build-versus-managed ADR (Stage 8 slice 10). They are numbers from ONE development VM
// (see the log line with its CPU count) and are not a cost model: they say how long a trivial run takes end to end
// (workspace in, sandbox, workspace out, teardown), how many finish per second at a few concurrency levels, and how much
// memory a run holds. Run with -v and read the logged lines; the assertions only insist that every run was fine.
const (
	measureWarmRuns   = 20 // enough for a stable median, few enough to finish in seconds
	measureBatchRuns  = 40
	measureTouchedMiB = 64
)

func oneTrivialRun(g *GVisor, rootfs, script string, limits Limits) (time.Duration, Result, error) {
	ws, err := os.MkdirTemp("", "measure-ws-")
	if err != nil {
		return 0, Result{}, err
	}
	defer os.RemoveAll(ws)
	started := time.Now()
	r, err := g.Run(context.Background(), Env{Rootfs: rootfs, Workspace: ws, WorkDir: "/work",
		Argv: []string{"/bin/sh", "-c", script}, UID: 1000, GID: 1000, Limits: limits})
	return time.Since(started), r, err
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	return sorted[int(float64(len(sorted)-1)*p)]
}

func TestMeasureStartAndThroughput(t *testing.T) {
	g, rootfs := driver(t)
	t.Logf("machine: %d CPUs, %s/%s", runtime.NumCPU(), runtime.GOOS, runtime.GOARCH)
	limits := Limits{WallSeconds: 20, MemoryMiB: 128, PIDs: 64, DiskMiB: 16, OutputKiB: 16}
	cold, r, err := oneTrivialRun(g, rootfs, "true", limits)
	if err != nil || r.Verdict != "OK" {
		t.Fatalf("cold run: %v %+v", err, r)
	}
	var warm []time.Duration
	for i := 0; i < measureWarmRuns; i++ {
		d, r, err := oneTrivialRun(g, rootfs, "true", limits)
		if err != nil || r.Verdict != "OK" {
			t.Fatalf("warm run %d: %v %+v", i, err, r)
		}
		warm = append(warm, d)
	}
	sort.Slice(warm, func(i, j int) bool { return warm[i] < warm[j] })
	t.Logf("first run %v; sequential x%d: p50 %v p95 %v max %v", cold, measureWarmRuns,
		percentile(warm, 0.5), percentile(warm, 0.95), warm[len(warm)-1])
	for _, workers := range []int{1, 2, 4, 8} {
		started := time.Now()
		var wg sync.WaitGroup
		jobs := make(chan struct{}, measureBatchRuns)
		for i := 0; i < measureBatchRuns; i++ {
			jobs <- struct{}{}
		}
		close(jobs)
		var failed int
		var mu sync.Mutex
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range jobs {
					if _, r, err := oneTrivialRun(g, rootfs, "true", limits); err != nil || r.Verdict != "OK" {
						mu.Lock()
						failed++
						mu.Unlock()
					}
				}
			}()
		}
		wg.Wait()
		elapsed := time.Since(started)
		t.Logf("%d workers: %d runs in %v = %.1f runs/s (%d failed)", workers, measureBatchRuns,
			elapsed.Round(time.Millisecond), float64(measureBatchRuns)/elapsed.Seconds(), failed)
		if failed != 0 {
			t.Errorf("%d runs failed at %d workers", failed, workers)
		}
	}
}

func TestMeasureMemoryPerRun(t *testing.T) {
	g, rootfs := driver(t)
	limits := Limits{WallSeconds: 20, MemoryMiB: 256, PIDs: 64, DiskMiB: 16, OutputKiB: 16}
	idle, r, err := oneTrivialRun(g, rootfs, "sleep 1", limits)
	if err != nil || r.Verdict != "OK" {
		t.Fatalf("idle: %v %+v", err, r)
	}
	t.Logf("a sandbox that only sleeps: peak %d MiB (cgroup), %v end to end", r.PeakMemoryMiB, idle)
	// The workspace is a memory file system made by the node, so its bytes are charged to the node and not to the
	// sandbox's cgroup: the cgroup figure below is NOT the host memory a run costs. Host memory per run is the cgroup
	// peak plus the workspace limit; that sum is what the ADR uses.
	_, r, err = oneTrivialRun(g, rootfs,
		"dd if=/dev/zero of=/work/blob bs=1M count=64 2>/dev/null; sleep 1", limits)
	if err != nil || r.Verdict != "OK" {
		t.Fatalf("touching memory: %v %+v", err, r)
	}
	t.Logf("a sandbox that holds %d MiB in its workspace: peak %d MiB (cgroup, workspace bytes not included)", measureTouchedMiB, r.PeakMemoryMiB)
}
