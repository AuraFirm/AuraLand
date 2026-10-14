package watermark

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/bundles"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/validate"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// Goal: the node sends the control plane everything it needs to judge a rewrite (both harness runs, the
// marks, the upload), keeps nothing back, and never ships a rewrite itself. Method: a fake rewriter box
// and a harness that returns canned observations.
func jobFor(packed []byte, checker string) wire.WatermarkJob {
	digest := sha256.Sum256(packed)
	return wire.WatermarkJob{
		JobID: "job_w", LeaseEpoch: 3, LeaseTTLS: 30,
		Task: wire.WatermarkTask{
			Bundle: wire.Bundle{SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(packed))},
			Spec:   wire.Spec{Checker: wire.Checker{Type: checker}},
			Tag:    0xc0ffee42,
		},
	}
}

type recorder struct{ uploaded [][]byte }

func runner(rewriterOut string, harness func(packed []byte) *validate.Runner, rec *recorder, original []byte) *Runner {
	box := &sandbox.Fake{RunFunc: func([]byte) sandbox.RunResult {
		return sandbox.RunResult{Verdict: "OK", Stdout: []byte(rewriterOut)}
	}}
	return &Runner{
		Rewriter: &bundles.Rewriter{Box: box, Script: "s"},
		Fetch:    func(context.Context, string, wire.Bundle) ([]byte, error) { return original, nil },
		Upload: func(_ context.Context, _ wire.WatermarkJob, data []byte) (string, error) {
			rec.uploaded = append(rec.uploaded, data)
			return "up_1", nil
		},
		Harness: harness,
	}
}

// harnessStub opens nothing: it answers with the observations it was built with.
type canned struct{ result wire.ValidationResult }

func (c canned) OpenFiles(context.Context, string, wire.Bundle) (*bundles.Files, error) {
	return nil, &bundles.Refused{Code: "stub", Detail: "not used"}
}

func TestUnchangedWhenThereIsNoCarrier(t *testing.T) {
	rec := &recorder{}
	original := []byte("original bundle")
	r := runner("AURA-REWRITTEN 0 0\nignored", nil, rec, original)
	result, err := r.Run(context.Background(), jobFor(original, "exact"))
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := result.(wire.WatermarkUnchanged); !ok || got.Outcome != "unchanged" || len(rec.uploaded) != 0 {
		t.Fatalf("%#v uploaded %d", result, len(rec.uploaded))
	}
}

func TestCustomCheckerIsUploadedWithoutObservations(t *testing.T) {
	rec := &recorder{}
	original := []byte("original bundle")
	r := runner("AURA-REWRITTEN 0 1\nREWRITTEN", nil, rec, original)
	result, err := r.Run(context.Background(), jobFor(original, "custom"))
	if err != nil {
		t.Fatal(err)
	}
	got, ok := result.(wire.WatermarkRewritten)
	if !ok || got.UploadID != "up_1" || got.Observations != nil || got.Answers || !got.Solutions {
		t.Fatalf("%#v", result)
	}
	if len(rec.uploaded) != 1 || string(rec.uploaded[0]) != "REWRITTEN" {
		t.Fatalf("uploaded %q", rec.uploaded)
	}
}

func TestRefusesWhatItCannotTrust(t *testing.T) {
	original := []byte("original bundle")
	bad := jobFor(original, "exact")
	bad.Task.Bundle.SHA256 = strings.Repeat("0", 64)
	cases := map[string]struct {
		run *Runner
		job wire.WatermarkJob
	}{
		"download does not match the job": {runner("AURA-REWRITTEN 0 1\nX", nil, &recorder{}, original), bad},
		"the rewriter refuses the bundle": {runner("REFUSED missing_file statement/en.md\n", nil, &recorder{}, original), jobFor(original, "exact")},
		"the rewriter prints garbage":     {runner("nonsense", nil, &recorder{}, original), jobFor(original, "exact")},
	}
	for name, c := range cases {
		if _, err := c.run.Run(context.Background(), c.job); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	failing := runner("AURA-REWRITTEN 0 1\nX", nil, &recorder{}, original)
	failing.Fetch = func(context.Context, string, wire.Bundle) ([]byte, error) { return nil, errors.New("network") }
	if _, err := failing.Run(context.Background(), jobFor(original, "exact")); err == nil {
		t.Error("a failed download must be an error")
	}
}
