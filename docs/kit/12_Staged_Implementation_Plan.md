# 12 — Staged Implementation Plan (stable, secure, one stage at a time)

> Rules of engagement: **never start stage N+1 until stage N passes its gate** (§Gates). Each stage ends in a deployable, tested, secure increment. Stages are sized for Claude-driven implementation with human review (~1–3 weeks each of calendar time with a small team). Order follows dependency and the revenue plan in `../New_Plan/12_First_90_Days.md` (Forge pilots + real contests/exams early).

Legend: **Deliver** = what exists at the end · **Build** = work items · **Accept** = verifiable acceptance criteria · **Security** = stage-specific security additions · **Out of scope** = tempting but deferred.

---

## Stage 0 — Foundations and guardrails
**Deliver:** empty-but-production-shaped repo that enforces the rules.
**Build:**
1. Repo skeleton per file 04; `CLAUDE.md` from file 14; `docs/kit/` copy; `docs/adr/0001-stack.md` (verified, pinned versions), `0002-tigerstyle-adaptation.md` (fetch original TIGER_STYLE.md and diff), `0003-table-ownership.md`, `deps.json`.
2. Tooling: pnpm workspace with supply-chain settings, Biome, `tsconfig` strict, `tools/tigerlint.ts` (function ≤ 70 lines, file ≤ 600 lines, no `any`/`as`/`!`, no recursion heuristics, no `process.env` outside config, no string-built SQL, import-graph rules, no empty catch), `tools/depcheck.ts`.
3. `platform/` essentials: `assert`, `result`, `clock`, `rng`, `log`, `config`, `otel` skeleton. Copy the bundled skill `docs/kit/.claude/skills/craft/` to `.claude/skills/craft/` (commit it) and confirm Claude Code lists it; it is referenced from `CLAUDE.md`. Create no other ports yet (file 02 §6.3). OpenTelemetry, the `Db`/`Storage`/`Net` ports and the `worker` role wait for their first consumer (ADR 0006).
4. `docker-compose.yml`; Postgres 18 + migration runner; `packages/db` client with the transaction-local RLS context helper (and its test).
5. `apps/api` skeleton with `/healthz`, `/readyz`, middleware pipeline in the **fixed order**, problem+json errors, request ids; `apps/web` skeleton with tokens, layout, security headers, CSP nonce.
6. CI pipeline (file 10 §9) incl. security scans, SBOM; GitHub branch protection + CODEOWNERS; `infra/tofu` for `staging` network + RDS + ECS skeleton (can be minimal).
7. DST harness skeleton + one trivial scenario to prove the loop (`seed` reproduces).
**Accept:** fresh-clone → `pnpm check && pnpm test` green; seeded DST failure reproduces; tigerlint catches a seeded violation in a test; CI green; a hello endpoint passes a headers check locally; the **staging deploy needs an AWS account, region, domain and credentials (decisions D1, D3, D8) and was deferred in the first run (ADR 0006)**.
**Security:** secrets scanning, pinned actions, OIDC, least-privilege roles, branch protection, threat-model v0.
**Out of scope:** any product feature.

## Stage 1 — Identity, tenancy, audit
**Deliver:** users, orgs, roles, sessions, API keys, audit log, RLS everywhere.
**Build:** Better Auth integration (passkeys, OAuth, email OTP/magic link, TOTP), `profiles`, `orgs`, `memberships`, `api_keys`; `authorize()`; RLS policies + roles (`aura_app` etc.); hash-chained `audit_log` + nightly verifier; rate-limit classes `auth/read/write`; Turnstile hook; account settings UI (security keys, sessions, export/delete request); org creation/invites UI; email via `MailPort` (Mailpit locally, SES in staging); cookie/CSRF/CSP finalized; `me/export` job skeleton.
**Accept:** RLS matrix + authz matrix tests generated and green; passkey register/login E2E with virtual authenticator; session fixation/rotation tests; enumeration-safe responses (timing test within tolerance); MFA enforced for admin roles; audit chain verification detects tampering in a test.
**Security:** ASVS V6/V7/V8-class checklist for auth/session/access control signed off by a human; account-takeover red-team script (credential stuffing sim) passes rate-limit expectations.
**Out of scope:** SSO/SAML, SCIM, ID verification.

## Stage 2 — Tasks and bundles
**Deliver:** authoring-side data model: tasks, versions, content-addressed bundles, review states.
**Build:** `TaskSpec` contracts; bundle format v1 + **ingest validator** (as a library used later inside the sandbox); S3 presigned multipart upload + finalize (server verifies size/hash); task state machine (`rules.ts`) + DST scenario; statement rendering pipeline (`renderMarkdownSafe`: sanitize + KaTeX) with a fuzz target and XSS corpus; task CRUD UI (basic), visibility/licensing fields; golden bundles in `tasks/`.
**Accept:** malformed bundle corpus (zip-slip, symlinks, bombs, huge entries) all rejected by the validator with specific codes; released versions immutable (trigger test); sanitizer passes XSS corpus (no script execution in a headless browser test).
**Security:** untrusted-archive parsing documented in threat model; no parsing on API host except size/hash checks (full parse deferred to sandbox in Stage 3).
**Out of scope:** judging, marketplace.

## Stage 3 — Tier-1 judge and submissions  *(core engine)*
**Deliver:** a real, safe judge: submit code, get a verdict.
**Build:** the `jobs` queue module (lease/heartbeat/complete/fail, fencing, dedupe, backoff, dead-letter) + **DST lease/fencing scenario**; `judge-protocol` contracts → generated Go types; `aura-judge` agent (protocol client, bundle cache, SQLite spool, scheduler); isolate driver (compile/run/check pipeline, meta parsing, verdict mapping); language profiles C/C++/Java/Python; checker support (testlib); `submissions` API + SSE stream; workspace UI v1 (editor, run samples, submit, verdict panel); node enrollment (mTLS), canary self-test, escape-suite v1; golden suite v1; admin rejudge.
**Accept:** golden suite verdicts exact on a KVM-capable CI runner; escape suite all contained; lease/fencing DST (100k seeds nightly) green; load test: 100 sub/s for 10 min, p95 < 4 s, zero lost; chaos: kill agent mid-job → job re-leased and completed once; timing variance < 3 % on calibration.
**Security:** **external review of the sandbox configuration before any public use** (can be an internal red-team at first; external pentest before paying Forge delivery); node threat model; seccomp profiles reviewed; no secrets on nodes verified.
**Out of scope:** Tier-2, contests.

## Stage 4 — Forge v0 (first revenue)
**Deliver:** author → validate → deliver task packs and private evals to a paying customer.
**Build:** Forge Studio (authoring flow, reviewers, comments), roles (setter/reviewer), **adversarial validation harness v1** (consistency, mutation testing, difficulty calibration with the `LlmProvider` port, attacker-agent runner on Tier-1 first, human-attack queue), `ungameability_score` + immutable validation report; customers/orders/deliveries; delivery packaging (manifest, per-delivery **watermarking**: per-customer test-data perturbations/canary strings logged by `watermark_id`), short-lived signed download URLs, customer portal (orders, deliveries, reports); licensing fields; invoicing hand-off via `BillingPort` (Stripe invoices; manual contract fields OK); contractor payouts record (manual payment initially); methodology doc page.
**Accept:** end-to-end: a setter produces a 20-task pack → validation scores computed → customer downloads → access logged; a deliberately weak task is rejected by the harness; tenant isolation proven for deliveries; delivery tamper-evidence (manifest hash verification script for customers).
**Security:** customer-IP isolation review; watermark leak-trace test; contractor authoring workspace restrictions (no bulk export for setters; access logs).
**Out of scope:** hosted environments (Tier-2), self-serve payment.

## Stage 5 — Contests, Arena, ratings
**Deliver:** run real contests (ICPC/IOI/rated) with live scoreboards, clarifications and ratings.
**Build:** contests module (formats, registration, problem sets, rules, state machine with worker ticks); scoreboard fold + snapshots + SSE fan-out + CDN-cacheable snapshot; freeze/unfreeze; clarifications; ICPC-tools-compatible export; Elo-MMR rating job; public profiles with rating history; Arena UI (home, contest lobby, scoreboard virtualization); practice mode; daily challenge; more language profiles; load tests (file 10 §7); status banner.
**Accept:** scoreboard DST (incremental == fold) green; 5k concurrent viewers + 100 sub/s test meets SLO; freeze never leaks; rating recomputation identical; first real contest (≥ 200 participants) run as a pilot with a rollback plan.
**Security:** submission abuse (rate limits, plagiarism flags as signals), registration bot defense, DDoS runbook rehearsal.
**Out of scope:** team formation social features, centaur/agent ladders (Stage 8+).

## Stage 6 — Exams and integrity
**Deliver:** institution-grade lab exams with AI-aware integrity.
**Build:** exams module (templates, rosters via CSV + LTI 1.3 launch, scheduling, accommodations, modes AI-free / AI-allowed-logged), student exam client (system check, consent, rules, autosave via IndexedDB + server seq, server-synced timer, reconnect), rubric/partial-credit grading, telemetry ingestion (consent-gated, batched, partitioned), instructor live monitor + replay timeline, similarity (AST/winnowing) service, **oral defence v1** (question generator via `LlmProvider` with strict schema, answer capture, reviewer UI), integrity evidence + appeals workflow, SEB/lockdown integration spike (L2), institution dashboard + CO/PO report template (validate with customers), grade export.
**Accept:** exam DST (no acked save lost; no saves after deadline) green; 2,000-session load test; replay reproduces final submission byte-for-byte; consent gate tested (telemetry rejected without consent); accessibility audit (screen reader + extra time); pilot with a real course.
**Security:** privacy impact assessment; DPA template; minors policy; false-positive review process documented; no LLM-detector signals.
**Out of scope:** webcam proctoring (L2 vendor integration later), L3 site workflows beyond roster/supervisor codes.

## Stage 7 — Passport (credentials)
**Deliver:** signed, verifiable, revocable credentials and public verification.
**Build:** `signing_keys` + KMS signer port; VC-JWT issuance (Open Badges 3.0 profile), `did:web` document + JWKS, revocation status list (bit-string, published static), credential issuance jobs from contests/exams/Forge qualification, candidate privacy controls (selective disclosure link, visibility), `/verify/[id]` public page (SSR, cacheable) + JSON endpoints, share cards/QR, employer module v0 (invite-only search, report view, replay highlights), ID-verification vendor integration behind `IdentityVerifier` for L1+, key rotation + incident runbook.
**Accept:** credentials verify with an independent open-source VC verifier; tamper/expiry/revocation cases rendered correctly; verification works with DB down (static artifacts); credential issuance DST green; key-rotation drill in staging passes.
**Security:** ASVS L3 controls for signing and key mgmt reviewed by a human; privacy review for employer access (consent, purpose, logging).
**Out of scope:** Data Integrity proofs, wallets, marketplace payments.

## Stage 8 — Tier-2 microVMs, environments and agent evals
**Deliver:** hosted RL/agent environments and private evals.
**Build:** Firecracker/jailer driver, rootfs/image build pipeline (reproducible), `aura-init` in-guest agent + vsock protocol, snapshot/restore, network policy (default none; allowlist), record/replay, verifier isolation (separate VM or late-attached device), anti-reward-hack detectors, env task kind + spec, agent runner interface (customer-provided model endpoints via egress proxy), leaderboard-as-a-service, red-team audit workflow, cost/density measurements and the ADR comparing build vs managed sandbox; centaur/agent contest formats.
**Accept:** Tier-2 escape suite contained; spike metrics recorded (cold/warm start, density, €/1k runs); a reference agent solves a sample environment end to end; a purpose-built reward-hack environment is detected and flagged; replays deterministic where claimed.
**Security:** dedicated sandbox pentest; incident drill: compromised guest → containment.
**Out of scope:** GPU workloads (separate ADR), multi-VM topologies.

## Stage 9 — Business systems, scale, compliance
**Deliver:** self-serve and enterprise readiness.
**Build:** billing (plans, entitlements, Stripe Checkout/Portal, metering for verifications and runs), enterprise SSO (SAML/OIDC) + SCIM behind `AuthPort`, org admin console, marketplace (setter revenue share ledger + payouts), employer subscriptions, ATS integrations (webhooks/APIs), public developer portal + SDK (TS), admin/support tooling (impersonation with consent + audit), data residency (EU/US/AP buckets; DB region split design), SOC 2 evidence automation, bug bounty, web-framework re-evaluation (Next.js vs TanStack Start), ClickHouse/Valkey/NATS **only if** triggers fired.
**Accept:** billing reconciliation tests; SSO conformance tests; SOC 2 Type I readiness checklist complete; DR drill passed; cost per verification tracked.

---

## Gates (run at the end of every stage; all must be true)
1. **Green:** `pnpm check && pnpm test && pnpm test:sim && pnpm test:e2e` in CI on `main`.
2. **Security gate:** file 08 §14 checklist, ticked in the stage report with evidence links.
3. **Performance:** targets for the stage verified by load test artifacts.
4. **Reliability:** SLO dashboards exist; alerts tested (fire a synthetic failure); runbook written; rollback demonstrated.
5. **Data:** migrations are expand-only for the release; restore drill done if schema-critical.
6. **Docs:** ADRs recorded; `docs/threat-model.md` updated; kit files amended if reality diverged (never silently).
7. **Human sign-off:** a founder reviews the stage report and approves in writing (a PR comment is fine).

## Stage report template (Claude produces at the end of each stage)
```
# Stage N report
- Scope delivered / deferred (with reasons)
- Key decisions (ADR links) and deviations from the kit
- Test evidence: CI run link, DST seeds run, load test artifacts
- Security gate checklist with evidence
- Known issues / risks / follow-ups (ranked)
- Operational readiness: dashboards, alerts, runbooks, rollback
- Metrics vs targets (capacity table)
- Questions for the humans
```

## Scope discipline (from the `craft` skill)
Each stage builds only its own scope. Do not pre-build later stages' modules, tables, ports or options. Within a stage, every changed line must trace to the stage plan; unrelated findings go into the stage report's "Known issues", not into the diff. Stage plans open with an **Assumptions** section and express each acceptance criterion as `step → verify: check`.

## Parallelization guidance
Within a stage, Claude may run independent work streams (e.g. Go agent vs TS API vs UI) but **contracts (`packages/contracts`) land first and are merged before consumers**. Never parallelize schema migrations. Keep PRs small and vertical (a slice that works end to end) to preserve stability.

## Time-boxing and cutlines
If a stage overruns by 50 %, stop and re-plan: cut scope (never cut tests, security items or assertions). Maintain a `docs/cutlist.md` of deferred nice-to-haves with owners.
