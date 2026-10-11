// Package agent is the node's main loop: report health, lease a job, judge it while keeping the lease
// alive, and report the result. It never runs code itself (that is the Sandbox) and never decides a
// verdict (that is the control plane).
package agent

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/client"
	"github.com/AuraFirm/AuraLand/judge/internal/judge"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// ControlPlane is what the agent needs from the server; *client.Client implements it.
type ControlPlane interface {
	Heartbeat(ctx context.Context, request wire.HeartbeatRequest) (wire.HeartbeatResponse, error)
	Lease(ctx context.Context, waitMS int) (*wire.LeasedJob, error)
	JobHeartbeat(ctx context.Context, jobID string, epoch int) error
	Complete(ctx context.Context, jobID string, epoch int, result wire.Result) error
	Fail(ctx context.Context, jobID string, epoch int, reason string, retryable bool) error
}

// Bundles opens the tests of a task. The implementation downloads the bundle by hash, checks the hash,
// and unpacks it with strict limits; the agent only sees the tests.
type Bundles interface {
	Open(ctx context.Context, job wire.LeasedJob) (data judge.TestData, release func(), err error)
}

type Agent struct {
	Plane   ControlPlane
	Box     sandbox.Sandbox
	Bundles Bundles
	Version string
	Logf    func(format string, args ...any)
	// SelfTest runs the node's canary (escape suite, timing calibration). A failing node drains.
	SelfTest func(ctx context.Context) bool
	// LeaseWaitMS is how long a lease request may wait for work; 0 polls.
	LeaseWaitMS int
}

// Beat tells the control plane the node is alive and how its self-test went.
func (a *Agent) Beat(ctx context.Context, running int) (string, error) {
	ok := a.SelfTest == nil || a.SelfTest(ctx)
	out, err := a.Plane.Heartbeat(ctx, wire.HeartbeatRequest{AgentVersion: a.Version, CanaryOK: ok, RunningJobs: running})
	return out.State, err
}

// RunOnce leases at most one job and finishes it. It returns whether there was one.
func (a *Agent) RunOnce(ctx context.Context) (bool, error) {
	job, err := a.Plane.Lease(ctx, a.LeaseWaitMS)
	if err != nil || job == nil {
		return false, err
	}
	a.process(ctx, *job)
	return true, nil
}

func (a *Agent) process(ctx context.Context, job wire.LeasedJob) {
	// The job's own context ends when the lease is lost, so a node stops working for nobody.
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var lost sync.Once
	stop := a.keepAlive(jobCtx, job, func() { lost.Do(cancel) })
	defer stop()

	result, err := a.judge(jobCtx, job)
	if jobCtx.Err() != nil && ctx.Err() == nil {
		a.Logf("job %s: lease lost, result discarded", job.JobID)
		return
	}
	if err != nil {
		a.report(ctx, job, err)
		return
	}
	if err := a.Plane.Complete(ctx, job.JobID, job.LeaseEpoch, result); err != nil {
		a.Logf("job %s: result not accepted: %v", job.JobID, err)
	}
}

func (a *Agent) judge(ctx context.Context, job wire.LeasedJob) (wire.Result, error) {
	data, release, err := a.Bundles.Open(ctx, job)
	if err != nil {
		return wire.Result{}, fmt.Errorf("bundle: %w", err)
	}
	defer release()
	return judge.Run(ctx, a.Box, data, job)
}

// report sends a system error back. Every such failure is retryable: another node may do better, and
// attempts are bounded by the control plane.
func (a *Agent) report(ctx context.Context, job wire.LeasedJob, cause error) {
	reason := cause.Error()
	if errors.Is(cause, judge.ErrUnsupported) {
		reason = "unsupported on this node: " + reason
	}
	if err := a.Plane.Fail(ctx, job.JobID, job.LeaseEpoch, reason, true); err != nil && !errors.Is(err, client.ErrStaleLease) {
		a.Logf("job %s: could not report failure: %v", job.JobID, err)
	}
}

// keepAlive sends a job heartbeat every third of the lease and calls lost() if the control plane says
// the lease is no longer ours. The returned function stops it.
func (a *Agent) keepAlive(ctx context.Context, job wire.LeasedJob, lost func()) func() {
	interval := time.Duration(job.LeaseTTLS) * time.Second / 3
	if interval <= 0 {
		interval = time.Second
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.Plane.JobHeartbeat(ctx, job.JobID, job.LeaseEpoch); errors.Is(err, client.ErrStaleLease) {
					lost()
					return
				}
			}
		}
	}()
	return func() {
		close(done)
		<-finished
	}
}
