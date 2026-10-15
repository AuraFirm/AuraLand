# Current stage

**Stage 0 — Foundations and guardrails: approved on 2026-10-10.** Report:
[stage-0-report.md](stage-0-report.md). Open item carried forward: the staging deploy (ADR 0008).

**Stage 1 — Identity, tenancy, audit: approved on 2026-10-10.**
Plan: [stage-1-plan.md](stage-1-plan.md). Report: [stage-1-report.md](stage-1-report.md).
Open items are in [../cutlist.md](../cutlist.md); your manual tasks are the checklist in the report.

**Stage 2 — Tasks and bundles: approved on 2026-10-11.** Report: [stage-2-report.md](stage-2-report.md).

**Stage 3 — Job queue, submissions, judge: approved.** Plan: [stage-3-plan.md](stage-3-plan.md). Report: [stage-3-report.md](stage-3-report.md). **The sandbox has never been run: no real use of the judge before the Linux node gate (cutlist F32).**

**Stage 4A — Forge v0 without the sandbox: approved on 2026-10-14.** Plan: [stage-4-plan.md](stage-4-plan.md). Report: [stage-4a-report.md](stage-4a-report.md). 

**Stage 4B — validation: approved on 2026-10-14** (job, report, mutation, attackers, score, portal). Plan: [stage-4b-plan.md](stage-4b-plan.md). Report: [stage-4b-report.md](stage-4b-report.md). Not built: model calibration, the human-attack queue. **Evidence comes from one development VM; reports are 'development' reports until a reviewed production node exists (F32).**

**Stage 4C — per-delivery watermarks and the leak trace: approved on 2026-10-14.** Plan: [stage-4c-plan.md](stage-4c-plan.md). Report: [stage-4c-report.md](stage-4c-report.md). With 4A, 4B and 4C the Stage 4 build list is done except model calibration and agent attack runs (need a provider account). **Reports and re-checks come from one development VM (F32).**

**Stage 5 — Contests, Arena, ratings: built, awaiting your review.** Plan: [stage-5-plan.md](stage-5-plan.md). Report: [stage-5-report.md](stage-5-report.md). Runbook: [../runbooks/contests.md](../runbooks/contests.md). **Not met: the kit's 5,000-in-10-seconds load target on one process, and anything that needs a deployment, an edge or a production judge fleet (F1, F32, F49).**

**Stage 6 — Exams and integrity: approved on 2026-10-15.** Plan: [stage-6-plan.md](stage-6-plan.md). Report: [stage-6-report.md](stage-6-report.md). Runbook: [../runbooks/exams.md](../runbooks/exams.md). **Not met: any real exam (no deployment, no reviewed judge node, legal review pending), a real LLM call (no provider), assurance above level 1.**

**Stage 7 — Passport (credentials): approved on 2026-10-15.** Plan: [stage-7-plan.md](stage-7-plan.md). Report: [stage-7-report.md](stage-7-report.md). Runbook: [../runbooks/passport.md](../runbooks/passport.md). **Not met: any production credential (no KMS signer, F62), human review of the signing code (F63), identity proof (F64), real employers (F67).**

**Stage 8 — Tier-2 environments and agent evals: built, awaiting your review.** Plan: [stage-8-plan.md](stage-8-plan.md). Report: [stage-8-report.md](stage-8-report.md). Runbook: [../runbooks/environments.md](../runbooks/environments.md). ADRs 0034 and 0035. **Not met: any Firecracker microVM (no KVM here, F68), a network allowlist (F69), an external sandbox review (F73), a real agent or model (F72); every result is gVisor on one development VM and level-1-only by rule.**

**What only you can do, with steps: [../owner-tasks.md](../owner-tasks.md).**
