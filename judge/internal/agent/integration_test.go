//go:build integration

package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/client"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/sign"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// Run by the TypeScript test apps/api/src/judge-agent.integration.test.ts against the real control
// plane: this agent enrolls, becomes active, leases the submission that test queued, judges it with a
// fake sandbox (no code runs) and reports. The TypeScript side then checks the verdict.
func TestAgainstTheRealControlPlane(t *testing.T) {
	url, token := os.Getenv("AURA_JUDGE_URL"), os.Getenv("AURA_JUDGE_ENROLL_TOKEN")
	if url == "" || token == "" {
		t.Skip("AURA_JUDGE_URL and AURA_JUDGE_ENROLL_TOKEN are set by the TypeScript test")
	}
	// The test control plane runs on a simulated clock; the agent's timestamps must follow it.
	base, err := strconv.ParseInt(os.Getenv("AURA_JUDGE_NOW_MS"), 10, 64)
	if err != nil {
		t.Fatalf("AURA_JUDGE_NOW_MS: %v", err)
	}
	started := time.Now()
	now := func() time.Time { return time.UnixMilli(base).Add(time.Since(started)) }
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	anonymous, err := client.New(url, "", private, http.DefaultClient, now)
	if err != nil {
		t.Fatal(err)
	}
	enrolled, err := anonymous.Enroll(ctx, wire.EnrollRequest{
		Token: token, Name: "go-agent-test", PublicKey: sign.Encode(public), AgentVersion: "0.1.0", Tiers: []int{1},
	})
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	node, err := client.New(url, enrolled.NodeID, private, http.DefaultClient, now)
	if err != nil {
		t.Fatal(err)
	}
	a := &Agent{Plane: node, Box: &sandbox.Fake{}, Bundles: &bundles{}, Version: "0.1.0", Logf: t.Logf}
	state, err := a.Beat(ctx, 0)
	if err != nil || state != "active" {
		t.Fatalf("heartbeat: state %q err %v", state, err)
	}
	ran, err := a.RunOnce(ctx)
	if err != nil || !ran {
		t.Fatalf("expected one job: ran=%v err=%v", ran, err)
	}
}
