# 13 — Claude Prompts Playbook

Copy-paste prompts for driving Claude Code through AuraLand's staged build. Replace `{{…}}`. Run **one prompt per fresh session** where indicated; the repo's `CLAUDE.md` (file 14) and `docs/kit/` carry the persistent context.

**Working agreement for all prompts:** plan first → implement in small vertical slices → tests first → run the full checks → self-review against the checklists → report honestly (including failures and skipped items). Invoke the `craft` skill at the start of every session and follow it (state assumptions, simplest solution, surgical changes, verifiable goals). Ask the human when requirements are ambiguous in a way that changes the design, when a decision is human-owned (kit file 15 §3), or before anything destructive; for everything the kit already decides, choose the kit's default, state the assumption, and record an ADR.

---

## P0 — Master Kickoff Prompt (once, at the start of Stage 0)

```
You are the lead engineer building AuraLand, a production system. First invoke the `craft` skill (Skill tool) and follow it throughout. Then read these files fully before doing anything, in order:
docs/kit/00_START_HERE.md, 01_Product_Context_For_Claude.md, 02_Engineering_Principles_TigerStyle.md,
03_Tech_Stack_Decisions.md, 04_Repository_Structure.md, 05_Architecture_and_Data_Model.md,
06_API_and_Realtime_Design.md, 08_Security_Spec.md, 10_Testing_and_Quality_Strategy.md,
11_DevOps_Infra_Observability.md, 12_Staged_Implementation_Plan.md. Skim 07 and 09 (you will need them in later stages).

Then:
1. Summarize in <= 25 lines: the mission, the architecture, the ten non-negotiable rules, and the stage plan, so I can confirm you understood. Do not write code yet.
2. List every item marked ⚠️VERIFY across the kit. For each, research the primary source (official docs / release notes / security advisories) and tell me the verified fact, the date, and the source URL. Where a fact contradicts the kit, say so and propose the fix.
3. Fetch the original TigerBeetle TIGER_STYLE.md and list differences vs docs/kit/02, proposing which deviations to keep.
4. Propose exact pinned versions for the whole stack (current stable/LTS) and any dependency additions beyond file 03's budget (each needing an ADR).
Wait for my approval before starting Stage 0.
```

## P1 — Stage kickoff template (use for Stages 0–9)

```
Implement Stage {{N}} — {{name}} from docs/kit/12_Staged_Implementation_Plan.md.

First invoke the `craft` skill. Context to re-read now: docs/kit/12 (Stage {{N}} section and Gates), docs/kit/02 §6, plus {{relevant files, e.g. 05, 06, 08}}.
Previous stage report: {{path or "none"}}.

Process:
1. PLAN (no code): produce docs/stages/stage-{{N}}-plan.md containing: **assumptions** (and any ambiguous requirement with the interpretations you considered), scope & non-scope (build only this stage; no speculative ports/abstractions), success criteria written as "step → verify: check", work breakdown as small vertical slices (each <= ~400 changed lines), data-model/API/contract changes, the back-of-envelope for capacity and the bottleneck resource, invariants + their assertions, limits to define, failure modes and tests for each, security considerations specific to this stage (STRIDE table), observability additions, rollout/rollback plan, open questions. Stop and show me the plan; wait for approval.
2. IMPLEMENT slice by slice. For each slice: write failing tests first (unit/property/integration, plus DST scenario where a protocol or state machine is involved), then code, then run `pnpm check && pnpm test` (and `pnpm test:sim` when relevant). Commit per slice with Conventional Commits. Keep to the TigerStyle rules (docs/kit/02): functions <= 70 lines, named limits with units, >= 2 assertions per non-trivial function, no new dependency without an ADR.
3. VERIFY: run the full gate (docs/kit/12 §Gates). Fix everything red. Do not weaken tests to pass.
4. SELF-REVIEW using the `craft` summary checklist, docs/kit/02 §5 and docs/kit/08 §14; confirm every changed line traces to the plan (revert drive-by edits; report unrelated issues instead of fixing them); list any item you cannot verify.
5. REPORT using the Stage report template in docs/kit/12. Be explicit about anything skipped, flaky, or deferred. Do not claim "done" unless every acceptance criterion is demonstrated with evidence (command output, test names, CI link).

Constraints: no real secrets in the repo; no destructive commands on shared infra without asking; no force-pushes; do not modify docs/kit/ except to propose changes via an ADR. If the kit conflicts with reality, write an ADR and tell me.
```

## P2 — Stage-specific addenda (append to P1)

**Stage 0**
```
Additional: create the repo skeleton exactly per docs/kit/04. Implement tools/tigerlint.ts and tools/depcheck.ts with tests that prove each rule fires on a violating fixture. Build the DST harness skeleton with a trivial scenario that reproduces a failure from a seed. Wire CI exactly per docs/kit/10 §9. Produce docs/adr/0001-stack.md with verified, pinned versions. Provide a `README.md` that gets a fresh clone running in < 10 minutes.
```

**Stage 1**
```
Additional: use Better Auth for identity (verify its current API and security advisories first; record in ADR). Implement RLS exactly per docs/kit/05 §6 with the generated RLS matrix and authz matrix tests. Passkeys first. Treat the audit log as a hash chain with a nightly verifier. Everything about sessions per docs/kit/08 §3. Do not build SSO.
```

**Stage 2**
```
Additional: bundle ingest validator must be a pure library (no I/O except through a passed-in file reader) so Stage 3 can run it inside the sandbox. Write the malformed-bundle corpus first (zip-slip, symlink, hardlink, bombs, NUL names, huge counts) and a fuzz target. renderMarkdownSafe must be the ONLY path to render user markdown; add a Semgrep rule banning dangerouslySetInnerHTML elsewhere.
```

**Stage 3**
```
Additional: this is the security-critical stage. Before coding the isolate driver, write docs/threat-model.md for the judge and the escape-regression program set (docs/kit/07 §9). Implement the queue with lease+fencing and its DST scenario FIRST and run 100k seeds. Generate Go protocol types from contracts (CI no-diff check). The agent must be outbound-only, spool results in SQLite before sending, and refuse to lease when its self-test fails. Do not run untrusted code on the dev machine outside a container; use the dev-mode judge container, and mark any result produced without KVM/cgroup v2 as non-authoritative.
```

**Stage 4**
```
Additional: the adversarial validation harness is the product's quality moat. Make the un-gameability score formula explicit, versioned and documented (docs/methodology.md). LLM usage only via LlmProvider with schema-validated outputs and cost logging. Delivery watermarking must be testable: given a leaked file, identify the delivery.
```

**Stage 5**
```
Additional: implement the scoreboard as a pure fold in rules.ts with an incremental worker tick; prove incremental == fold with a DST scenario. SSE fan-out per docs/kit/06 §6 (serialize once, shared buffer, bounded per-client buffer, resume via Last-Event-ID or resync). Write the k6 scenarios and attach results to the stage report. Rating math must be deterministic and golden-vector tested.
```

**Stage 6**
```
Additional: exam correctness over cleverness. Autosave protocol = monotone seq, server deadline authority, IndexedDB buffer; DST must prove no acknowledged save is lost. Telemetry is consent-gated and batched; never store raw keystroke content unless the exam policy explicitly enables it. Integrity output is evidence with explanations, never an accusation; build the appeals workflow. Do not use or build LLM-text detectors as evidence.
```

**Stage 7**
```
Additional: credentials are VC-JWT (Open Badges 3.0 profile) signed via a KMS-backed Signer port (verify KMS algorithm support; fall back to ES256 if Ed25519 is unavailable and record an ADR). Publish did:web, JWKS, and a revocation status list as static artifacts. Validate output with at least one independent open-source verifier in CI. Key rotation runbook + drill.
```

**Stage 8**
```
Additional: begin with a time-boxed spike (docs/kit/07 §5.2 decision gate): Firecracker+jailer on a KVM host vs gVisor vs a managed sandbox provider; produce the ADR with measurements before building the full driver. Verifier isolation is mandatory (separate VM or late-attached read-only device). Build a deliberately hostile reward-hacking environment as a regression test.
```

**Stage 9**
```
Additional: build only what triggers or customer commitments justify. Reconcile billing against Stripe in tests. Prepare SOC 2 evidence automation. Re-evaluate Next.js vs TanStack Start with data (advisory cadence, DX, bundle sizes) and record an ADR.
```

## P3 — Review prompts

**Security review (run before merging any security-sensitive PR and at each stage end)**
```
Act as a skeptical application-security engineer. Review the diff for branch {{branch}} against docs/kit/08_Security_Spec.md, focusing on: authn/session, authorization (BOLA/BFLA), RLS coverage, input validation/limits, injection classes (SQL, XSS, SSRF, path traversal, command), file/archive handling, crypto/key handling, secrets, logging of sensitive data, rate limiting/abuse, race conditions/TOCTOU, supply chain (new deps/scripts), and LLM prompt-injection exposure. For every finding give: severity, exact file:line, exploit scenario, fix. Then try to write a failing test (or proof-of-concept request) for each High/Critical finding. If you find nothing in a category, say what you checked to be sure. Do not invent findings.
```

**TigerStyle / quality review**
```
Invoke the `craft` skill, then review the diff against docs/kit/02_Engineering_Principles_TigerStyle.md §5 and §6. Also flag: lines that do not trace to the stated task (drive-by changes), speculative abstractions/options, branching scattered in helpers instead of the parent, negated or compound conditions that should be positive/nested, reliance on library defaults for important options, abbreviated names or unit-first naming, and commit messages that do not explain why. Report violations of: function/file size, missing assertions (positive and negative space), unbounded loops/queues/buffers, missing limits, swallowed errors, silent fallbacks, derived-state duplication, poor naming (units last), comments that explain what instead of why, unnecessary abstraction or dependency. Propose minimal fixes. Verify tests fail first by checking out the previous commit's code against the new tests where feasible.
```

**Data/migration review**
```
Review the migration(s) in {{paths}}: lock levels and duration on large tables, expand/contract compliance, backfill strategy and batching, indexes (CONCURRENTLY), constraints (NOT VALID then VALIDATE), RLS policies and the RLS matrix coverage, rollbacks, impact on running old code (N-1 compatibility), and query plans (EXPLAIN ANALYZE) for the hot queries listed in the PR.
```

**Design review (before a plan is approved)**
```
Critique docs/stages/stage-{{N}}-plan.md as a principal engineer: What is the simplest design that satisfies the acceptance criteria? What can be deleted? What are the failure modes and blast radius? Are invariants and limits explicit? Is the capacity math correct and is the bottleneck resource identified? Where could a tenant or an AI agent abuse this? What would we regret in 12 months? Give a ranked list of changes.
```

## P4 — Operational prompts

**Incident analysis**
```
Production incident: {{symptom}}. Evidence: {{logs/metrics/trace ids}}. Using docs/kit/11 and docs/runbooks/, (1) state the most likely failure hypotheses ranked with the evidence that would confirm or refute each, (2) propose the safest mitigation first (feature flag, drain node, shed load, rollback), (3) do NOT take destructive or irreversible action without my approval, (4) after mitigation, write a blameless postmortem draft with timeline, root cause, contributing factors, and action items including the missing test/alert/DST scenario.
```

**Reproduce from DST seed**
```
A DST run failed: SCENARIO={{name}} SEED={{seed}}. Reproduce it locally with `pnpm test:sim --scenario={{name}} --seed={{seed}}`, minimize the failing trace, explain the root cause in terms of the violated invariant, fix the code (not the test), and pin the seed in sim/regressions.ts. Run 100k seeds of that scenario afterwards and report.
```

**Dependency addition**
```
I want to add dependency {{pkg}}. Write the ADR per docs/kit/03 §4: what it replaces, why the platform/stdlib is insufficient, size, maintainers/activity, license, install scripts, provenance, known CVEs, transitive deps, exit plan. Recommend yes/no. Do not install until I approve.
```

**Resume a session**
```
Resume work on Stage {{N}}. Read CLAUDE.md, docs/kit/12 (Stage {{N}}), docs/stages/stage-{{N}}-plan.md, and the git log since the stage began. Report: slices done, slices remaining, any red checks, and your proposed next slice. Then continue with the next slice using the P1 process.
```

**Kit maintenance**
```
Reality diverged from the kit in {{area}}. Draft an ADR that records the divergence and propose a minimal patch to docs/kit/{{file}} (as a diff, don't apply). Explain which invariants or security properties are affected.
```

## P5 — Prompt-writing rules used above (so you can write more)
1. **Give the why and the files to read**, not just the task.
2. **Force a plan checkpoint** before code on anything non-trivial.
3. **State the acceptance evidence** (commands, tests, load results) and demand honest reporting of gaps.
4. **Name the checklists** (TigerStyle §5, Security §14, Gates) so reviews are consistent.
5. **Constrain blast radius**: one stage, small slices, no dependency additions without ADR, no destructive actions unasked.
6. **Prefer verifiable commands** over adjectives ("pnpm test:sim passes 100k seeds" not "robust").
