package tier2

import (
	"context"
	"fmt"
	"time"
)

// A Session is one environment run from start to finish: the recipe's setup commands, then the agent's command, each in
// its own fresh sandbox over the same workspace. There is no resident in-guest agent: a gVisor sandbox starts in about 35
// ms, so separate sandboxes give every step the same containment and a clean process table, and need no channel between
// the host and something running inside (ADR 0034 amendment). The workspace after each step is hashed so a trace can say
// what changed when, and so protected paths can be checked.
type SessionSpec struct {
	Rootfs    string
	Workspace string
	WorkDir   string
	UID, GID  int
	Env       []string
	Setup     [][]string
	Agent     []string
	// Limits for every step. Setup steps and the agent share the wall budget: the session as a whole never exceeds it.
	Limits Limits
}

type StepResult struct {
	Name     string // "setup 1", "agent"
	Argv     []string
	Result   Result
	TreeHash string // the workspace after the step
}

// SessionResult says how far the session got. Outcome is "completed" (every step ran; the agent may still have failed),
// "setup_failed" (a setup command did not exit 0, and nothing after it ran) or "sandbox_error" (the runtime itself failed).
type SessionResult struct {
	Outcome   string
	StartHash string // the workspace before anything ran
	Steps     []StepResult
	Isolation string
}

// Run executes the session on a Runtime. The Runtime is the only thing that touches a sandbox; the hashing reads the
// workspace directory only.
func (s SessionSpec) Run(ctx context.Context, rt Runtime) (SessionResult, error) {
	result := SessionResult{Outcome: "completed", Isolation: IsolationGVisor}
	start, err := HashTree(s.Workspace)
	if err != nil {
		return result, fmt.Errorf("hash workspace: %w", err)
	}
	result.StartHash = start
	budget := time.Duration(s.Limits.WallSeconds) * time.Second
	steps := make([]step, 0, len(s.Setup)+1)
	for i, argv := range s.Setup {
		steps = append(steps, step{name: fmt.Sprintf("setup %d", i+1), argv: argv, setup: true})
	}
	steps = append(steps, step{name: "agent", argv: s.Agent})
	for _, st := range steps {
		remaining := budget
		if remaining < time.Second {
			result.Steps = append(result.Steps, StepResult{Name: st.name, Argv: st.argv, Result: Result{Verdict: "TLE", Isolation: IsolationGVisor}})
			if st.setup {
				result.Outcome = "setup_failed"
			}
			return result, nil
		}
		limits := s.Limits
		limits.WallSeconds = int(remaining / time.Second)
		started := time.Now()
		r, err := rt.Run(ctx, Env{Rootfs: s.Rootfs, Workspace: s.Workspace, WorkDir: s.WorkDir, Argv: st.argv, Env: s.Env, UID: s.UID, GID: s.GID, Limits: limits})
		if err != nil {
			result.Outcome = "sandbox_error"
			return result, err
		}
		budget -= time.Since(started)
		hash, err := HashTree(s.Workspace)
		if err != nil {
			return result, fmt.Errorf("hash workspace: %w", err)
		}
		result.Steps = append(result.Steps, StepResult{Name: st.name, Argv: st.argv, Result: r, TreeHash: hash})
		if st.setup && (r.Verdict != "OK" || r.ExitCode != 0) {
			result.Outcome = "setup_failed"
			return result, nil
		}
	}
	return result, nil
}

type step struct {
	name  string
	argv  []string
	setup bool
}
