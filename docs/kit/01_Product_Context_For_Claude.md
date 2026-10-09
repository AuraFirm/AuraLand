# 01 — Product Context for Claude

Read this first. It explains **why** AuraLand exists so that when a spec is silent, you can decide in the direction of the mission.

## 1. Motivation

- AI now solves most competitive-programming problems and writes much production code. A "good coder" rank or a take-home test no longer proves capability.
- Entry-level software jobs have shrunk. Graduates cannot prove what they can do; employers and universities cannot tell **who did the work: the person, or a hidden AI**.
- AI labs and agent builders need **hard, trustworthy, un-gameable tasks and verifiers** to train and measure models, and these are hard to produce.
- Therefore the scarce good is **trust**: verified evidence of capability, for humans and for agents. AuraLand sells that evidence. The better AI gets, the more the world needs it.

The predecessor, *Auracode*, was a competitive-programming platform. Its judge design, contest engine, rating system and community survive as the Engine and Arena. See `../New_Plan/01_Old_Plan_Audit.md`.

## 2. Mission and goals

- **Mission:** be the independent standard for proving software capability in the AI era.
- **Business goal:** a path to ≈$100M ARR in about 8 years (≈$1B valuation, a long shot, not a promise). Revenue ordering: Forge first, Exam/Contest for distribution, Passport for the long-term moat.
- **Product goals (what every engineering choice serves):**
  1. **Trustworthy results**: a verdict, rating or credential must be correct, reproducible and tamper-evident.
  2. **Un-gameable by design**: assume users and AI agents try to cheat; assume customers try to read each other's data.
  3. **Fast and calm**: sub-second feedback loops; exams must feel low-anxiety; contests must not fall over at the start bell.
  4. **Small team, big surface**: simplicity is a security feature. Fewer parts, fewer failures.
- **Positioning constraints:** independent and neutral (we never train our own frontier model and never favor one lab); consent-first data; transparent methodology.

## 3. Users and what each needs

| Persona | Needs | Critical UX property |
|---|---|---|
| **Contestant / learner** | Fair fast judging, clear verdicts, a live scoreboard, rating progress, a shareable proof | Instant feedback, no lag at contest start |
| **Instructor / lab admin** | Run a lab exam in minutes, AI-allowed vs AI-free modes, auto-grade, integrity evidence, LMS roster | Few clicks, confidence, replayable evidence |
| **Student in an exam** | Calm environment, autosave, clear timer, fair integrity rules | No surprises, no data loss, no false accusations |
| **Setter / Forge expert** | Author tasks with a good tool, get validated and paid | Rich authoring + automated validation feedback |
| **AI-lab buyer** | Audited tasks, environments, private evals, delivery in images, contracts and invoices | Rigor, auditability, security |
| **Employer / recruiter** | Verifiable candidate evidence with assurance level, in minutes | Trust at a glance, explainability |
| **Platform admin (us)** | Moderation, rejudge, incident tooling, finance, support | Safe power tools with audit trails |

Detailed screens are in `../New_Plan/Latest/UI_UX_Demo.pdf` (10 desktop screens, mobile, flows, states) and distilled in file 09.

## 4. Product scope (what exists, in dependency order)

1. **Engine core:** accounts/orgs, task bundles, Tier-1 judge, submissions, verdicts.
2. **Contest engine + Arena:** registration, ICPC/IOI/rated formats, scoreboard with freeze, clarifications, Elo-MMR rating.
3. **Forge:** authoring, review, adversarial validation harness, task packs, delivery portal, licensing.
4. **Exam:** rosters, exam sessions, AI-allowed/AI-free modes, telemetry, oral defence, rubric grading, instructor replay.
5. **Passport:** signed credentials, public verification, employer reports.
6. **Tier-2:** Firecracker microVM environments and agent runs, record/replay.
7. **Business systems:** billing, enterprise SSO, marketplace revenue share, compliance tooling.

## 5. Explicit non-goals (do not build)

- No own frontier/foundation model. LLM calls go through one provider-abstraction module.
- No native mobile apps in the first 12 months; a responsive PWA only.
- No home-grown identity verification (use a vendor), no home-grown payments, no home-grown email delivery.
- No microservices. No Kubernetes in the first phase. No GraphQL. No second database engine until a measured trigger fires (file 03 §Revisit triggers).
- No social network features beyond follow/profile/activity until retention data says otherwise.
- No "LLM-likeness detector" as proof of cheating. Ever. High false-positive risk; it may only be one weak input, never a verdict.
- No dark patterns. Especially none in exams.

## 6. Domain invariants (these must always hold; tests assert them)

1. A **verdict is a pure function of (bundle sha256, submission sha256, judge profile)** within documented tolerance; rejudging yields the same verdict or records a flagged nondeterminism.
2. A **submission is judged at most once per attempt epoch** (fencing tokens); a stale judge node can never overwrite a newer result.
3. **A contest scoreboard is a deterministic fold** over the ordered submission/verdict log; recomputing from the log reproduces it exactly, including freeze rules.
4. **Ratings are a deterministic function** of the ordered contest results; recomputation reproduces them.
5. **Tenant isolation:** no row, object, log line or cache entry of org A is readable by org B except through an explicit, audited share.
6. **Hidden tests, reference solutions and verifier code are never exposed** to a contestant, an agent under test, or a different tenant.
7. **Credentials** are issued only for events at or above the stated assurance level, signed with a KMS-held key, verifiable offline, revocable with a public status list.
8. **Audit log is append-only and hash-chained**; admin and break-glass actions always appear in it.
9. **Time is UTC `timestamptz`; money is integer minor units + ISO currency; IDs are UUIDv7**.
10. **Consent is recorded** before any behavioral telemetry is collected, and can be withdrawn (with defined consequences for the assurance level).

## 7. Quality bar summary

- Production-grade from day 1: typed, tested, observable, secure, documented by ADRs.
- "Done" means: acceptance criteria met + tests + docs + security checklist + observability + rollback path (file 10 §Definition of Done).
- When unsure between two designs, choose the one that is **simpler, more explicit and easier to verify**, and record the reasoning in an ADR.

## 8. How to treat the New_Plan numbers

Market sizes, prices and growth in `../New_Plan/` are illustrative and partly secondary-sourced. They justify **priorities**, not engineering constraints. Engineering capacity targets are defined in file 05 §Capacity and are the only numbers that bind the implementation.
