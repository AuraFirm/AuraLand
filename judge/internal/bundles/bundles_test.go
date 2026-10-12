package bundles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// Goal: the node trusts nothing the box prints. Method: build streams by hand (the grammar in
// packages/bundle/src/open.ts) and corrupt one thing at a time.
func record(path, body string) string {
	digest := sha256.Sum256([]byte(body))
	return fmt.Sprintf("%d %s %s\n%s\n", len(body), hex.EncodeToString(digest[:]), path, body)
}

func stream(records ...string) string {
	return "AURA-OPEN 1\n" + strings.Join(records, "") + fmt.Sprintf("END %d\n", len(records))
}

func TestParseStreamAcceptsAGoodStream(t *testing.T) {
	files, err := ParseStream([]byte(stream(record("tests/1.ans", "3\n"), record("tests/1.in", "1 2\n"), record("solutions/reference.py", ""))))
	if err != nil {
		t.Fatal(err)
	}
	if data, ok := files.Get("tests/1.in"); !ok || string(data) != "1 2\n" {
		t.Fatalf("got %q %v", data, ok)
	}
	if got := files.Paths(); len(got) != 3 || got[0] != "tests/1.ans" {
		t.Fatalf("order not kept: %v", got)
	}
}

func TestParseStreamRefusesWhatIsWrong(t *testing.T) {
	good := record("tests/1.in", "ab")
	bad := strings.Replace(good, "ab\n", "ac\n", 1)
	cases := map[string]string{
		"empty":          "",
		"no header":      "END 0\n",
		"unknown header": "AURA-OPEN 2\nEND 0\n",
		"bad digest":     stream(bad),
		"path outside":   stream(record("task.json", "x")),
		"path traversal": stream(record("tests/../task.json", "x"))[:0] + "AURA-OPEN 1\n1 " + strings.Repeat("0", 64) + " ../x\nx\nEND 1\n",
		"duplicate":      "AURA-OPEN 1\n" + good + good + "END 2\n",
		"count mismatch": "AURA-OPEN 1\n" + good + "END 2\n",
		"after trailer":  stream(good) + "x",
		"no trailer":     "AURA-OPEN 1\n" + good,
		"short body":     "AURA-OPEN 1\n99 " + strings.Repeat("0", 64) + " tests/1.in\nab\nEND 1\n",
		"unterminated":   "AURA-OPEN 1\n2 " + strings.Repeat("0", 64) + " tests/1.in\nabX" + "END 1\n",
		"size with sign": "AURA-OPEN 1\n+2 " + strings.Repeat("0", 64) + " tests/1.in\nab\nEND 1\n",
		"negative size":  "AURA-OPEN 1\n-1 " + strings.Repeat("0", 64) + " tests/1.in\n\nEND 1\n",
		"huge size":      "AURA-OPEN 1\n999999999999 " + strings.Repeat("0", 64) + " tests/1.in\n",
		"missing fields": "AURA-OPEN 1\n2 tests/1.in\nab\nEND 1\n",
		"refusal + more": "REFUSED missing_file x\nEND 0\n",
	}
	for name, input := range cases {
		if _, err := ParseStream([]byte(input)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseStreamReportsARefusal(t *testing.T) {
	_, err := ParseStream([]byte("REFUSED unexpected_file solutions/ref.cpp is not reference or wrong_*\n"))
	var refused *Refused
	if !errors.As(err, &refused) || refused.Code != "unexpected_file" || !strings.Contains(refused.Detail, "solutions/ref.cpp") {
		t.Fatalf("got %v", err)
	}
}

func jobFor(packed []byte) wire.LeasedJob {
	digest := sha256.Sum256(packed)
	return wire.LeasedJob{Task: wire.Task{Bundle: wire.Bundle{SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(packed))}}}
}

func opener(box sandbox.Sandbox, packed []byte) *Opener {
	return &Opener{Box: box, Script: "script", Fetch: func(context.Context, wire.LeasedJob) ([]byte, error) { return packed, nil }}
}

func TestOpenerChecksTheDownloadBeforeRunningAnything(t *testing.T) {
	packed := []byte("packed bundle")
	box := &sandbox.Fake{}
	wrongHash := jobFor(packed)
	wrongHash.Task.Bundle.SHA256 = strings.Repeat("0", 64)
	wrongSize := jobFor(packed)
	wrongSize.Task.Bundle.Bytes++
	for name, job := range map[string]wire.LeasedJob{"hash": wrongHash, "size": wrongSize} {
		if _, _, err := opener(box, packed).Open(context.Background(), job); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if box.Compiles != 0 || box.Runs != 0 {
		t.Fatal("a download that fails its check must never reach the box")
	}
}

func TestOpenerReturnsTestsAndReleases(t *testing.T) {
	packed := []byte("packed bundle")
	box := &sandbox.Fake{RunFunc: func(stdin []byte) sandbox.RunResult {
		if string(stdin) != "packed bundle" {
			t.Fatal("the box must get the bundle on standard input")
		}
		return sandbox.RunResult{Verdict: "OK", Stdout: []byte(stream(record("tests/1.ans", "3\n"), record("tests/1.in", "1 2\n")))}
	}}
	data, release, err := opener(box, packed).Open(context.Background(), jobFor(packed))
	if err != nil {
		t.Fatal(err)
	}
	input, answer, err := data.Test(context.Background(), "1")
	if err != nil || string(input) != "1 2\n" || string(answer) != "3\n" {
		t.Fatalf("got %q %q %v", input, answer, err)
	}
	if _, _, err := data.Test(context.Background(), "2"); err == nil {
		t.Fatal("a test the bundle lacks must be an error")
	}
	release()
}

func TestOpenerTreatsABoxFailureAsASystemError(t *testing.T) {
	packed := []byte("packed bundle")
	for _, run := range []sandbox.RunResult{
		{Verdict: "TLE"},
		{Verdict: "MLE"},
		{Verdict: "OK", ExitCode: 1},
		{Verdict: "OK", Stdout: []byte("garbage")},
	} {
		box := &sandbox.Fake{RunFunc: func([]byte) sandbox.RunResult { return run }}
		if _, _, err := opener(box, packed).Open(context.Background(), jobFor(packed)); err == nil {
			t.Errorf("%+v accepted", run)
		}
	}
}
