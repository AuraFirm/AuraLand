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
	validations []*wire.ValidationJob
	validated   []wire.ValidationResult
	watermarks  []*wire.WatermarkJob
	watermarked []any
	completed   []wire.Result
	failed      []string
	failRetry   []bool
	heartbeats  int
	staleBeats  bool
	completeErr error
	canary      []bool
	state       string // what heartbeats answer; empty means active
}

func (p *plane) Heartbeat(_ context.Context, r wire.HeartbeatRequest) (wire.HeartbeatResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.canary = append(p.canary, r.CanaryOK)
	if p.state != "" {
		return wire.HeartbeatResponse{State: p.state}, nil
	}
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

func (p *plane) LeaseValidation(context.Context, int) (*wire.ValidationJob, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.validations) == 0 {
		return nil, nil
	}
	job := p.validations[0]
	p.validations = p.validations[1:]
	return job, nil
}

func (p *plane) CompleteValidation(_ context.Context, _ string, _ int, r wire.ValidationResult) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.validated = append(p.validated, r)
	return nil
}

func (p *plane) LeaseWatermark(context.Context, int) (*wire.WatermarkJob, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.watermarks) == 0 {
		return nil, nil
	}
	job := p.watermarks[0]
	p.watermarks = p.watermarks[1:]
	return job, nil
}

func (p *plane) CompleteWatermark(_ context.Context, _ string, _ int, result any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.watermarked = append(p.watermarked, result)
	return nil
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

// Goal: the node takes work only while the control plane calls it active, and stops when told to.
func TestServeLeasesOnlyWhileActive(t *testing.T) {
	for state, wantJobs := range map[string]int{"": 0, "draining": 1, "revoked": 1} {
		p := &plane{jobs: []*wire.LeasedJob{sampleJob(30)}, state: state}
		if state == "" {
			p.state = "" // active
		}
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		newAgent(p, &sandbox.Fake{}, &bundles{}).Serve(ctx, 20*time.Millisecond, 5*time.Millisecond)
		cancel()
		left := len(p.jobs)
		if state == "" && left != 0 {
			t.Errorf("an active node must take the job, %d left", left)
		}
		if state != "" && left != wantJobs {
			t.Errorf("%s node must take nothing, %d left", state, left)
		}
	}
}

func TestServeStopsWhenAskedAndAnsweredJobsAreDone(t *testing.T) {
	p := &plane{jobs: []*wire.LeasedJob{sampleJob(30)}}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		newAgent(p, &sandbox.Fake{}, &bundles{}).Serve(ctx, 20*time.Millisecond, 5*time.Millisecond)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Serve did not stop")
	}
	if len(p.completed) != 1 {
		t.Fatalf("the job must be judged once, got %d", len(p.completed))
	}
}

type validator struct {
	err error
	ran int
}

func (v *validator) Run(context.Context, wire.ValidationJob) (wire.ValidationResult, error) {
	v.ran++
	return wire.ValidationResult{Bundle: wire.ValidationBundle{Opens: true}, Runs: []wire.ValidationRun{}}, v.err
}

// Goal: a node with a validator takes validation jobs after submissions, reports what it saw, and
// reports its own failures as retryable; a node without one never asks.
func TestValidationJobsAreRunAndReported(t *testing.T) {
	job := &wire.ValidationJob{JobID: "job_v", LeaseEpoch: 2, LeaseTTLS: 30}
	p := &plane{validations: []*wire.ValidationJob{job}}
	v := &validator{}
	a := newAgent(p, &sandbox.Fake{}, &bundles{})
	a.Validator = v
	ran, err := a.RunOnce(context.Background())
	if err != nil || !ran || v.ran != 1 || len(p.validated) != 1 {
		t.Fatalf("ran %v err %v validator %d reported %d", ran, err, v.ran, len(p.validated))
	}
}

func TestValidationFailureIsReportedAsRetryableAndNodeWithoutValidatorSkips(t *testing.T) {
	failing := &validator{err: errors.New("sandbox down")}
	p := &plane{validations: []*wire.ValidationJob{{JobID: "job_v", LeaseEpoch: 1, LeaseTTLS: 30}}}
	a := newAgent(p, &sandbox.Fake{}, &bundles{})
	a.Validator = failing
	a.RunOnce(context.Background())
	if len(p.failed) != 1 || !p.failRetry[0] || len(p.validated) != 0 {
		t.Fatalf("failed %v retry %v validated %d", p.failed, p.failRetry, len(p.validated))
	}
	idle := &plane{validations: []*wire.ValidationJob{{JobID: "job_v", LeaseEpoch: 1, LeaseTTLS: 30}}}
	ran, _ := newAgent(idle, &sandbox.Fake{}, &bundles{}).RunOnce(context.Background())
	if ran || len(idle.validations) != 1 {
		t.Fatal("a node without a validator must not lease validation jobs")
	}
}

type watermarker struct {
	err error
	ran int
}

func (w *watermarker) Run(context.Context, wire.WatermarkJob) (any, error) {
	w.ran++
	return wire.WatermarkUnchanged{Outcome: "unchanged"}, w.err
}

// Goal: a node with a watermarker takes watermark jobs last, reports what it did, and reports its own
// failures as retryable; submissions and validations come first.
func TestWatermarkJobsAreRunLastAndReported(t *testing.T) {
	p := &plane{
		validations: []*wire.ValidationJob{{JobID: "job_v", LeaseEpoch: 1, LeaseTTLS: 30}},
		watermarks:  []*wire.WatermarkJob{{JobID: "job_w", LeaseEpoch: 4, LeaseTTLS: 30}},
	}
	w := &watermarker{}
	a := newAgent(p, &sandbox.Fake{}, &bundles{})
	a.Validator = &validator{}
	a.Watermarker = w
	for i := 0; i < 2; i++ {
		if ran, err := a.RunOnce(context.Background()); err != nil || !ran {
			t.Fatalf("round %d: ran %v err %v", i, ran, err)
		}
	}
	if len(p.validated) != 1 || len(p.watermarked) != 1 || w.ran != 1 {
		t.Fatalf("validated %d watermarked %d", len(p.validated), len(p.watermarked))
	}
	if ran, _ := a.RunOnce(context.Background()); ran {
		t.Fatal("nothing is left to do")
	}
}

func TestWatermarkFailureIsRetryableAndNodeWithoutWatermarkerSkips(t *testing.T) {
	p := &plane{watermarks: []*wire.WatermarkJob{{JobID: "job_w", LeaseEpoch: 1, LeaseTTLS: 30}}}
	a := newAgent(p, &sandbox.Fake{}, &bundles{})
	a.Watermarker = &watermarker{err: errors.New("box failed")}
	a.RunOnce(context.Background())
	if len(p.failed) != 1 || !p.failRetry[0] || len(p.watermarked) != 0 {
		t.Fatalf("failed %v retry %v", p.failed, p.failRetry)
	}
	idle := &plane{watermarks: []*wire.WatermarkJob{{JobID: "job_w", LeaseEpoch: 1, LeaseTTLS: 30}}}
	if ran, _ := newAgent(idle, &sandbox.Fake{}, &bundles{}).RunOnce(context.Background()); ran || len(idle.watermarks) != 1 {
		t.Fatal("a node without a watermarker must not lease watermark jobs")
	}
}
