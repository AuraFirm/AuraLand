package agent

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/client"
	"github.com/AuraFirm/AuraLand/judge/internal/judge"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

type plane struct {
	mu          sync.Mutex
	jobs        []*wire.LeasedJob
	completed   []wire.Result
	failed      []string
	failRetry   []bool
	heartbeats  int
	staleBeats  bool
	completeErr error
	canary      []bool
}

func (p *plane) Heartbeat(_ context.Context, r wire.HeartbeatRequest) (wire.HeartbeatResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.canary = append(p.canary, r.CanaryOK)
	return wire.HeartbeatResponse{State: "active"}, nil
}

func (p *plane) Lease(context.Context, int) (*wire.LeasedJob, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.jobs) == 0 {
		return nil, nil
	}
	job := p.jobs[0]
	p.jobs = p.jobs[1:]
	return job, nil
}

func (p *plane) JobHeartbeat(context.Context, string, int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.heartbeats++
	if p.staleBeats {
		return client.ErrStaleLease
	}
	return nil
}

func (p *plane) Complete(_ context.Context, _ string, _ int, r wire.Result) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.completed = append(p.completed, r)
	return p.completeErr
}

func (p *plane) Fail(_ context.Context, _ string, _ int, reason string, retryable bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failed = append(p.failed, reason)
	p.failRetry = append(p.failRetry, retryable)
	return nil
}

type data struct{}

func (data) Test(_ context.Context, id string) ([]byte, []byte, error) {
	return []byte(id), []byte(id), nil
}

type bundles struct {
	err      error
	released int
}

func (b *bundles) Open(context.Context, wire.LeasedJob) (judge.TestData, func(), error) {
	if b.err != nil {
		return nil, nil, b.err
	}
	return data{}, func() { b.released++ }, nil
}

func sampleJob(ttl int) *wire.LeasedJob {
	return &wire.LeasedJob{
		JobID: "job_1", LeaseEpoch: 3, LeaseTTLS: ttl,
		Submission: wire.Submission{Language: "cpp", Source: "x"},
		Task: wire.Task{Spec: wire.Spec{
			TimeLimitMS: 1000, MemoryLimitKiB: 1, OutputLimitKiB: 1,
			Scoring: wire.Scoring{Type: "binary"}, Checker: wire.Checker{Type: "exact"},
			Tests: []wire.TestSpec{{ID: "1"}, {ID: "2"}},
		}},
	}
}

func newAgent(p *plane, box sandbox.Sandbox, b *bundles) *Agent {
	return &Agent{Plane: p, Box: box, Bundles: b, Version: "test", Logf: func(string, ...any) {}}
}

func TestAnEmptyQueueIsNotAnError(t *testing.T) {
	ran, err := newAgent(&plane{}, &sandbox.Fake{}, &bundles{}).RunOnce(context.Background())
	if ran || err != nil {
		t.Fatalf("ran=%v err=%v", ran, err)
	}
}

func TestAJobIsJudgedAndItsResultReported(t *testing.T) {
	p := &plane{jobs: []*wire.LeasedJob{sampleJob(30)}}
	b := &bundles{}
	ran, err := newAgent(p, &sandbox.Fake{}, b).RunOnce(context.Background())
	if !ran || err != nil {
		t.Fatalf("ran=%v err=%v", ran, err)
	}
	if len(p.completed) != 1 || len(p.completed[0].Tests) != 2 || len(p.failed) != 0 {
		t.Fatalf("completed %+v failed %v", p.completed, p.failed)
	}
	if b.released != 1 {
		t.Fatal("the bundle must be released after judging")
	}
}

func TestSystemFailuresAreReportedAsRetryableFailuresNeverAsResults(t *testing.T) {
	cases := map[string]struct {
		b   *bundles
		box sandbox.Sandbox
	}{
		"bundle":  {&bundles{err: errors.New("hash mismatch")}, &sandbox.Fake{}},
		"sandbox": {&bundles{}, &sandbox.Fake{RunFunc: func([]byte) sandbox.RunResult { return sandbox.RunResult{Verdict: "SE"} }}},
	}
	for name, c := range cases {
		p := &plane{jobs: []*wire.LeasedJob{sampleJob(30)}}
		newAgent(p, c.box, c.b).RunOnce(context.Background())
		if len(p.completed) != 0 || len(p.failed) != 1 || !p.failRetry[0] {
			t.Errorf("%s: completed %d failed %v retry %v", name, len(p.completed), p.failed, p.failRetry)
		}
	}
}

func TestAnUnsupportedTaskGoesBackForAnotherNode(t *testing.T) {
	job := sampleJob(30)
	job.Task.Spec.Checker.Type = "custom"
	p := &plane{jobs: []*wire.LeasedJob{job}}
	newAgent(p, &sandbox.Fake{}, &bundles{}).RunOnce(context.Background())
	if len(p.failed) != 1 || !p.failRetry[0] || len(p.completed) != 0 {
		t.Fatalf("failed %v completed %v", p.failed, p.completed)
	}
}

func TestALostLeaseStopsTheWorkAndDiscardsTheResult(t *testing.T) {
	p := &plane{jobs: []*wire.LeasedJob{sampleJob(0)}, staleBeats: true} // ttl 0 -> heartbeat every second
	slow := &sandbox.Fake{RunFunc: func([]byte) sandbox.RunResult {
		time.Sleep(1500 * time.Millisecond)
		return sandbox.RunResult{Verdict: "OK"}
	}}
	newAgent(p, slow, &bundles{}).RunOnce(context.Background())
	if len(p.completed) != 0 || len(p.failed) != 0 {
		t.Fatalf("a result after a lost lease must be discarded: completed %d failed %v", len(p.completed), p.failed)
	}
	if p.heartbeats == 0 {
		t.Fatal("the agent should have sent a heartbeat")
	}
}

func TestTheSelfTestResultIsReported(t *testing.T) {
	p := &plane{}
	a := newAgent(p, &sandbox.Fake{}, &bundles{})
	a.SelfTest = func(context.Context) bool { return false }
	if _, err := a.Beat(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	a.SelfTest = nil
	if _, err := a.Beat(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if len(p.canary) != 2 || p.canary[0] || !p.canary[1] {
		t.Fatalf("canary reports %v", p.canary)
	}
}
