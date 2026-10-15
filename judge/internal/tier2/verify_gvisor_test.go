//go:build linux && gvisor

package tier2

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The verifier scenario (Stage 8 slice 4): the task is "write the answer to the question in input.txt to /work/answer.txt".
// The hidden expected answer lives on the host and reaches only the verifier, mounted read-only after the agent has finished.
const secretAnswer = "TOP-SECRET-ANSWER-7731"

func hiddenDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "expected.txt"), []byte(secretAnswer+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// The verifier compares the agent's answer.txt with the hidden expected answer. cmp follows nothing it was not given: the
// snapshot has no links, so an agent that links answer.txt to the hidden file leaves nothing to compare.
func verifierFor(t *testing.T, rootfs, hidden string) VerifierSpec {
	return VerifierSpec{
		Rootfs: rootfs, Hidden: hidden, UID: 1000, GID: 1000, Limits: roomy,
		Argv: []string{"/bin/sh", "-c", `if [ -f /work/answer.txt ] && cmp -s /work/answer.txt /verifier/expected.txt; then echo '{"score": 1, "detail": "match"}'; else echo '{"score": 0, "detail": "no match"}'; fi`},
	}
}

func agentRun(t *testing.T, g *GVisor, rootfs, script string) (string, SessionResult) {
	t.Helper()
	ws := workspace(t)
	spec := SessionSpec{Rootfs: rootfs, Workspace: ws, WorkDir: "/work", UID: 1000, GID: 1000, Agent: []string{"/bin/sh", "-c", script}, Limits: roomy}
	r, err := spec.Run(context.Background(), g)
	if err != nil {
		t.Fatal(err)
	}
	return ws, r
}

func TestTheVerifierScoresAnHonestAgentAndAWrongOne(t *testing.T) {
	g, rootfs := driver(t)
	hidden := hiddenDir(t)
	v := verifierFor(t, rootfs, hidden)
	// The honest agent has to know the answer; here it computes it (the secret is not in its sandbox, so it is typed in
	// the test the way a solved task would produce it).
	wsGood, _ := agentRun(t, g, rootfs, `echo `+secretAnswer+` > /work/answer.txt`)
	good, err := v.Verify(context.Background(), g, wsGood, t.TempDir())
	if err != nil || good.Score != 1 {
		t.Fatalf("honest: %+v %v", good, err)
	}
	wsBad, _ := agentRun(t, g, rootfs, `echo wrong > /work/answer.txt`)
	bad, err := v.Verify(context.Background(), g, wsBad, t.TempDir())
	if err != nil || bad.Score != 0 {
		t.Fatalf("wrong: %+v %v", bad, err)
	}
	if bad.Sandbox.Isolation != "gvisor" {
		t.Fatal("the verifier's run records its isolation too")
	}
}

func TestAnAgentCannotFindOrReadTheHiddenAnswer(t *testing.T) {
	g, rootfs := driver(t)
	hidden := hiddenDir(t)
	ws, run := agentRun(t, g, rootfs, `find / -maxdepth 5 -name expected.txt 2>/dev/null; grep -rl `+secretAnswer+` /work /tmp /etc /home /root /var /opt /mnt /srv 2>/dev/null | head; ls /verifier 2>&1; ls / | tr "\n" " "; echo done`)
	out := string(run.Steps[0].Result.Stdout)
	if strings.Contains(out, "expected.txt") || strings.Contains(out, secretAnswer) || !strings.Contains(out, "done") {
		t.Fatalf("the agent saw the hidden material: %q", out)
	}
	_ = ws
	_ = hidden
}

func TestALinkToTheHiddenAnswerEarnsNothingAndIsReported(t *testing.T) {
	g, rootfs := driver(t)
	hidden := hiddenDir(t)
	v := verifierFor(t, rootfs, hidden)
	// The reward hack: answer.txt becomes a link to where the verifier will have the expected answer.
	ws, _ := agentRun(t, g, rootfs, `ln -s /verifier/expected.txt /work/answer.txt`)
	result, err := v.Verify(context.Background(), g, ws, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if result.Score != 0 {
		t.Fatalf("the link earned a score of %v", result.Score)
	}
	if len(result.Snapshot.Dropped) != 1 || result.Snapshot.Dropped[0] != "answer.txt" {
		t.Fatalf("the dropped link must be reported as evidence: %+v", result.Snapshot)
	}
}

func TestTheVerifierCannotChangeWhatItWasShown(t *testing.T) {
	g, rootfs := driver(t)
	hidden := hiddenDir(t)
	v := verifierFor(t, rootfs, hidden)
	v.Argv = []string{"/bin/sh", "-c", `echo tampered > /verifier/expected.txt 2>/dev/null && echo WROTE; echo '{"score": 1, "detail": "x"}'`}
	ws, _ := agentRun(t, g, rootfs, `echo x > /work/answer.txt`)
	result, err := v.Verify(context.Background(), g, ws, t.TempDir())
	if err != nil || strings.Contains(string(result.Sandbox.Stdout), "WROTE") {
		t.Fatalf("the hidden material was writable: %v %q", err, result.Sandbox.Stdout)
	}
	raw, _ := os.ReadFile(filepath.Join(hidden, "expected.txt"))
	if strings.TrimSpace(string(raw)) != secretAnswer {
		t.Fatal("the hidden file changed on the host")
	}
}
