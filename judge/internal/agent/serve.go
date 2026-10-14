package agent

import (
	"context"
	"sync/atomic"
	"time"
)

// Serve runs the node until ctx ends. A separate goroutine reports health on a timer (a long job must
// not make the node look dead) and publishes the state the control plane answers with; the loop here
// leases work only while that state is "active", so a draining or revoked node finishes what it holds
// and takes nothing new. Until the first answer arrives the node takes nothing.
func (a *Agent) Serve(ctx context.Context, beatEvery, idleWait time.Duration) {
	var state atomic.Value
	state.Store("")
	var running atomic.Int32
	beatsDone := make(chan struct{})
	go func() {
		defer close(beatsDone)
		a.beatLoop(ctx, beatEvery, &state, &running)
	}()
	// unbounded: the node's main loop runs until it is told to stop.
	for ctx.Err() == nil {
		if state.Load() != "active" {
			sleep(ctx, idleWait)
			continue
		}
		running.Store(1)
		ran, err := a.RunOnce(ctx)
		running.Store(0)
		if err != nil {
			a.Logf("lease: %v", err)
		}
		if !ran {
			sleep(ctx, idleWait)
		}
	}
	<-beatsDone
}

func (a *Agent) beatLoop(ctx context.Context, every time.Duration, state *atomic.Value, running *atomic.Int32) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		answer, err := a.Beat(ctx, int(running.Load()))
		if err != nil {
			// Unknown is not "active": a node that cannot reach the control plane takes no new work.
			a.Logf("heartbeat: %v", err)
			answer = ""
		}
		state.Store(answer)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
