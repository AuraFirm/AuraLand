//go:build linux && isolate

package watermark

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/bundles"
	"github.com/AuraFirm/AuraLand/judge/internal/isolate"
	"github.com/AuraFirm/AuraLand/judge/internal/validate"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// The whole node-side watermark job against the real sandbox (4C slice 2), on a judge node or a Linux VM:
//
//	AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/watermark -v
//
// It rewrites the corpus's golden-solved bundle, runs the harness (g++, python3, Node) on the original
// and on the rewrite, and checks that the observations the control plane would compare are identical.
func TestRealSandboxRewritesAndObservesNoChangeInAnyVerdict(t *testing.T) {
	binary := os.Getenv("AURA_ISOLATE_BIN")
	if binary == "" {
		t.Skip("AURA_ISOLATE_BIN is not set")
	}
	read := func(path string) []byte {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	opener, rewriter := string(read("../../../packages/bundle/dist/open-bundle.cjs")), string(read("../../../packages/bundle/dist/rewrite-bundle.cjs"))
	original := read("../../../packages/bundle/corpus/golden-solved.tar.zst")
	box, err := isolate.New(binary, 1)
	if err != nil {
		t.Fatal(err)
	}
	var uploaded []byte
	r := &Runner{
		Rewriter: &bundles.Rewriter{Box: box, Script: rewriter},
		Fetch:    func(context.Context, string, wire.Bundle) ([]byte, error) { return original, nil },
		Upload: func(_ context.Context, _ wire.WatermarkJob, data []byte) (string, error) {
			uploaded = data
			return "up_real", nil
		},
		Harness: func(packed []byte) *validate.Runner {
			fetch := func(context.Context, string, wire.Bundle) ([]byte, error) { return packed, nil }
			return &validate.Runner{Box: box, Open: &bundles.Opener{Box: box, Script: opener, Fetch: fetch}}
		},
	}
	digest := sha256.Sum256(original)
	job := wire.WatermarkJob{JobID: "job_real", LeaseEpoch: 1, LeaseTTLS: 30, Task: wire.WatermarkTask{
		Bundle: wire.Bundle{SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(original))},
		Spec: wire.Spec{
			TimeLimitMS: 1000, MemoryLimitKiB: 262144, OutputLimitKiB: 1024,
			Scoring: wire.Scoring{Type: "binary"}, Checker: wire.Checker{Type: "exact"},
			Tests: []wire.TestSpec{{ID: "001", IsSample: true}, {ID: "002"}},
		},
		Tag: 0xc0ffee42,
	}}
	result, err := r.Run(context.Background(), job)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := result.(wire.WatermarkRewritten)
	if !ok || !got.Solutions || got.Answers || got.Observations == nil || len(uploaded) == 0 {
		t.Fatalf("%#v", result)
	}
	if string(uploaded) == string(original) {
		t.Fatal("the uploaded bundle must differ from the original")
	}
	before, after := verdictLines(got.Observations.Original), verdictLines(got.Observations.Rewritten)
	if strings.Join(before, "|") != strings.Join(after, "|") || len(before) == 0 {
		t.Fatalf("verdicts differ:\n%v\n%v", before, after)
	}
	t.Logf("%d runs, %d mutants, %d attackers, identical verdicts", len(got.Observations.Original.Runs), len(got.Observations.Original.Mutants), len(got.Observations.Original.Attackers))
}

func verdictLines(result wire.ValidationResult) []string {
	var lines []string
	for _, run := range result.Runs {
		for _, test := range run.Tests {
			lines = append(lines, run.Solution+"#"+string(rune('0'+run.Repeat))+":"+test.TestID+"="+test.Verdict)
		}
	}
	return lines
}
