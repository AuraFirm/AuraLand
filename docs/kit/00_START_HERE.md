# 00 — START HERE: AuraLand Production Implementation Kit

> **Audience:** Claude (Claude Code) implementing AuraLand, and the human founders supervising it.
> **Purpose:** Everything needed to build AuraLand in **stable, secure, reviewable stages** without re-deriving context.
> **Status:** v1.0, written 2026-10-10. Versions and vendor claims marked ⚠️VERIFY must be checked against primary sources at Stage 0 and recorded in `docs/adr/`.

## What AuraLand is (30 seconds)

AuraLand is the **verification and trust layer for software capability, for people and for AI agents**. One shared **Engine** (a safe code-execution judge, a verifier framework, integrity and identity tooling, a rating model) powers five products:

| Product | One line | Who pays |
|---|---|---|
| **Forge** | Expert-written, adversarially validated tasks, RL environments and private evals | AI labs, AI-data vendors, agent startups |
| **Exam & Contest** | University lab exams and ICPC/IOI-style contests with AI-aware integrity | Universities, organizers, sponsors |
| **Arena** | Rated contests: unaided, AI-allowed ("Centaur"), hack-and-verify, human-vs-AI | Sponsors, community |
| **Passport** | Signed, verifiable credentials with an assurance level (L0–L3) | Employers, candidates |
| **Engine** | Judge, sandbox, verifiers, integrity, rating (internal) | (inside the above) |

Full strategy lives in `../New_Plan/` (read `00`, `04`, `05`, `08`, `12` first). This folder is the **how to build it** companion.

## Reading order for Claude

Read in this order before writing any code. Re-read the relevant file before each stage.

| # | File | Read when |
|---|---|---|
| 01 | `01_Product_Context_For_Claude.md` | Always first. Motivation, users, non-goals, invariants. |
| 02 | `02_Engineering_Principles_TigerStyle.md` | Always. The coding standard (§6 integrates the `craft` skill). |
| 03 | `03_Tech_Stack_Decisions.md` | Stage 0, and whenever tempted to add a dependency. |
| 04 | `04_Repository_Structure.md` | Stage 0, and whenever creating a file. |
| 05 | `05_Architecture_and_Data_Model.md` | Before any schema or module work. |
| 06 | `06_API_and_Realtime_Design.md` | Before any endpoint or stream. |
| 07 | `07_Judge_and_Sandbox_Spec.md` | Stages 3 and 8; anything touching untrusted code. |
| 08 | `08_Security_Spec.md` | Every stage (security gate). |
| 09 | `09_UI_UX_Implementation_Guide.md` | Any frontend work. |
| 10 | `10_Testing_and_Quality_Strategy.md` | Every stage (definition of done). |
| 11 | `11_DevOps_Infra_Observability.md` | Stage 0, deploy work, incidents. |
| 12 | `12_Staged_Implementation_Plan.md` | Planning each stage; it is the master checklist. |
| 13 | `13_Claude_Prompts_Playbook.md` | Copy-paste prompts for each stage and each review. |
| 14 | `14_Repo_CLAUDE_md_Template.md` | Becomes `CLAUDE.md` at the new repo root in Stage 0. |
| 15 | `15_Decisions_Sources_Open_Questions.md` | When a ⚠️VERIFY item or a trade-off comes up. |

## Working method: the `craft` skill

You (Claude) have a user-level skill named **`craft`** (`~/.claude/skills/craft/SKILL.md`). **Invoke it with the Skill tool at the start of every implementation or review session.** It governs how each change is made: think and state assumptions first, simplest thing that works (nothing speculative), **surgical changes** (every changed line traces to the request), goal-driven verification, defensive checks, short functions, precise naming, comments and commit messages that explain *why*. It is the same philosophy as TigerStyle in generic form; file 02 §6 maps the two and resolves conflicts (security rules and domain invariants always win). The kit is the destination; each stage builds only its own scope.

## How the human uses this kit

1. Create the new repo (name: `auraland`). Do **not** put it inside `Production_Details/`.
2. Copy `14_Repo_CLAUDE_md_Template.md` to `<repo>/CLAUDE.md`, and copy this whole folder to `<repo>/docs/kit/` (read-only reference; `cp -R` so the hidden `.claude/` folder comes along). The `craft` skill is bundled in this kit at `.claude/skills/craft/`; also copy it to the repo's own `<repo>/.claude/skills/craft/` so Claude Code discovers it for everyone who clones the repo (Stage 0 verifies this). On your machine it already exists at `~/.claude/skills/craft/`; if the two copies differ, the repo copy wins inside the repo.
3. Start Claude Code in the repo. Paste the **Master Kickoff Prompt** from file 13.
4. Run **one stage at a time** using the stage prompt in file 13. Review the stage report. Only then start the next stage.
5. After every stage run the **Stage Gate Checklist** (file 12 §Gates): green CI, security review, restore drill where relevant, and a human sign-off.

## The ten non-negotiable rules (summary; details in the files)

1. **Safety, then performance, then developer experience** (TigerStyle order). Never trade a lower item for a higher one.
2. **Untrusted code never runs on the control plane.** Only on dedicated judge nodes, inside isolate (Tier-1) or Firecracker microVMs (Tier-2).
3. **Every authorization decision is server-side, in the data layer too** (tenant `org_id` + Postgres Row-Level Security). Never rely on UI hiding or on middleware alone.
4. **Every external input is parsed with a schema at the boundary** (Zod), and every internal invariant is asserted.
5. **Put a limit on everything** (sizes, counts, durations, queue depths, retries, page sizes).
6. **One way to do each thing.** One language per layer (TypeScript; Go only for the judge agent), one database (PostgreSQL), one queue mechanism, one validation library.
7. **No new dependency without an ADR.** Dependency count is a budget (file 03 §Budget).
8. **Credentials are signed and verifiable offline**; signing keys never leave KMS.
9. **Privacy by design**: consent-first telemetry, data minimization, export and delete, explainable and appealable integrity decisions.
10. **Nothing ships without tests that fail first.** Deterministic simulation tests cover the state machines (queue, scoreboard, rating).

## Glossary

- **Assurance level (L0–L3):** L0 open · L1 rated online (ID + telemetry) · L2 proctored remote · L3 supervised site.
- **Centaur:** human + AI allowed, with usage logged.
- **Task:** versioned unit of work = spec + environment image + verifier + hidden tests + metadata + license.
- **Bundle:** content-addressed (sha256) immutable archive of a task version.
- **Verifier:** code that scores a submission or agent trajectory (tests, checkers, fuzzers; LLM graders only as a secondary signal).
- **Un-gameability score:** result of adversarial validation of a task (AI agents + human hackers + mutation tests).
- **Tier-1 judge:** fast `isolate`-based runner for algorithmic tasks. **Tier-2:** Firecracker microVM for full environments and agents.
- **Lease / fencing token:** how a judge node owns a job; stale owners are rejected.
- **DST:** deterministic simulation testing (seeded, fake clock, fake I/O), TigerBeetle-style.
- **ADR:** architecture decision record in `docs/adr/NNNN-title.md`.
