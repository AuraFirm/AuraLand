package tier2

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/sign"
)

func scriptedRuntime(content func(call int) string) *fake {
	return &fake{do: func(call int, env Env) Result {
		_ = os.WriteFile(filepath.Join(env.Workspace, "out.txt"), []byte(content(call)), 0o644)
		return Result{Verdict: "OK", Stdout: []byte("printed")}
	}}
}

func TestATraceIsCanonicalSignedAndHoldsHashesNotText(t *testing.T) {
	spec := newSpec(t)
	spec.Setup = nil
	run, err := spec.Run(context.Background(), scriptedRuntime(func(int) string { return "same" }))
	if err != nil {
		t.Fatal(err)
	}
	flags := []Flag{{"protected_path_changed", "tests", "changed"}}
	trace, err := BuildTrace(run, flags, &VerifierResult{Score: 0.5, Detail: "half"})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := trace.Canonical()
	b, _ := trace.Canonical()
	if string(a) != string(b) || strings.Contains(string(a), "printed") {
		t.Fatalf("the canonical bytes must repeat and must not carry output text: %s", a)
	}
	var back Trace
	if err := json.Unmarshal(a, &back); err != nil || back.Verifier == nil || back.Verifier.Score != 0.5 || len(back.Flags) != 1 {
		t.Fatalf("round trip: %v %+v", err, back)
	}
	pub, key, _ := ed25519.GenerateKey(nil)
	if !sign.VerifyTrace(pub, a, sign.SignTrace(key, a)) {
		t.Fatal("the node's signature must verify")
	}
}

func TestReplayIsEqualWhenTheEnvironmentIsDeterministicAndSaysWhatDiffersWhenNot(t *testing.T) {
	spec := newSpec(t)
	spec.Setup = nil
	pristine := t.TempDir()
	if _, err := Snapshot(spec.Workspace, pristine, 1<<20); err != nil {
		t.Fatal(err)
	}
	same := scriptedRuntime(func(int) string { return "same" })
	run, _ := spec.Run(context.Background(), same)
	trace, _ := BuildTrace(run, nil, nil)
	spec.UID, spec.GID = os.Getuid(), os.Getgid() // the replay copy is owned by whoever runs the test
	report, err := Replay(context.Background(), scriptedRuntime(func(int) string { return "same" }), spec, trace, pristine)
	if err != nil || !report.Equal {
		t.Fatalf("a deterministic environment should replay equal: %+v %v", report, err)
	}
	report, err = Replay(context.Background(), scriptedRuntime(func(int) string { return "different" }), spec, trace, pristine)
	if err != nil || report.Equal || len(report.Differences) != 1 || !strings.Contains(report.Differences[0], "workspace afterwards differs") {
		t.Fatalf("a changed run must be reported: %+v %v", report, err)
	}
}
