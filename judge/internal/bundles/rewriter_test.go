package bundles

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

// Goal: the node trusts nothing the rewriter box prints, and sends it exactly the request it should.
func TestParseRewritten(t *testing.T) {
	body, marks, err := ParseRewritten([]byte("AURA-REWRITTEN 1 0\nPACKED"))
	if err != nil || string(body) != "PACKED" || !marks.Answers || marks.Solutions {
		t.Fatalf("%q %+v %v", body, marks, err)
	}
	for name, output := range map[string]string{
		"empty":             "",
		"no newline":        "AURA-REWRITTEN 1 1",
		"unknown header":    "HELLO\nPACKED",
		"flag out of range": "AURA-REWRITTEN 2 1\nPACKED",
		"negative flag":     "AURA-REWRITTEN -1 1\nPACKED",
		"no body":           "AURA-REWRITTEN 1 1\n",
		"refusal + more":    "REFUSED missing_file x\nPACKED",
	} {
		if _, _, err := ParseRewritten([]byte(output)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	_, _, err = ParseRewritten([]byte("REFUSED missing_file statement/en.md\n"))
	var refused *Refused
	if !errors.As(err, &refused) || refused.Code != "missing_file" {
		t.Fatalf("a refusal is typed: %v", err)
	}
}

func TestRewriteSendsTheRequestAndRefusesBadTagsAndBoxFailures(t *testing.T) {
	var seen string
	box := &sandbox.Fake{RunFunc: func(stdin []byte) sandbox.RunResult {
		seen = string(stdin)
		return sandbox.RunResult{Verdict: "OK", Stdout: []byte("AURA-REWRITTEN 0 1\nOUT")}
	}}
	out, marks, err := (&Rewriter{Box: box, Script: "s"}).Rewrite(context.Background(), []byte("IN"), 0xc0ffee42)
	if err != nil || string(out) != "OUT" || marks.Answers || !marks.Solutions {
		t.Fatalf("%q %+v %v", out, marks, err)
	}
	if seen != "AURA-REWRITE 1 3237998146\nIN" {
		t.Fatalf("request %q", seen)
	}
	if _, _, err := (&Rewriter{Box: box, Script: "s"}).Rewrite(context.Background(), []byte("IN"), 5); err == nil {
		t.Error("a tag without its top bit must be refused before the box runs")
	}
	for _, run := range []sandbox.RunResult{{Verdict: "TLE"}, {Verdict: "OK", ExitCode: 1}, {Verdict: "OK", Stdout: []byte(strings.Repeat("x", 10))}} {
		failing := &sandbox.Fake{RunFunc: func([]byte) sandbox.RunResult { return run }}
		if _, _, err := (&Rewriter{Box: failing, Script: "s"}).Rewrite(context.Background(), []byte("IN"), 0xc0ffee42); err == nil {
			t.Errorf("%+v accepted", run)
		}
	}
}
