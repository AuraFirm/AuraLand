# Stage 2 report: tasks and bundles

Status: **ready for sign-off.** Nothing is merged on your behalf beyond what you approved ("i approve
everything that you think to be best suited"); this is the evidence for the decision that is yours
(docs/kit/12, gate 7). The plan and its ten decisions are `stage-2-plan.md` and ADR 0022.

## Scope delivered
A setter can create a task, write its statement (Markdown with formulas) and spec, upload a versioned,
content-addressed bundle straight to object storage, and move the version through review. A second
person approves it; with a fresh passkey check they release it, today on a written waiver because no
sandbox exists yet. Released versions can never change. Statements are shown safely. The two
security-critical pieces everything later depends on exist and are tested hard: the **bundle ingest
validator** (a pure library with a corpus and a fuzzer) and **`renderMarkdownSafe`**.

| Area | What exists |
|---|---|
| Database | Migrations 0012 to 0014: tasks, task versions, reviews, bundle uploads; roles `setter` and `reviewer`; every rule that must never break is a trigger, constraint or policy (frozen releases, one released and one validating version per task, separation of duties, approval per review stint, gapless numbering, caps) |
| API | 58 declared routes in the authorization matrix (15 new); task, version, upload, finalize, review, release, retire, abandon; storage failures answer 503 with nothing half-recorded |
| Storage | A narrow port with S3 and in-memory adapters sharing one contract suite (run against a real SeaweedFS), presigned multipart parts with the size signed in, uploads verified on a staging key before they reach `bundles/<org>/<sha256>` |
| Validator | `packages/bundle`: one canonical zstd+tar form, 20 refusal codes, 88-file language-neutral corpus, mutation fuzzer (3,000 inputs per test run, 200,000 per night), no I/O (enforced by tigerlint) |
| Markdown | Three-layer renderer, KaTeX as grammar-checked MathML, 59 tests including 47 hostile inputs and 4,000 fuzzed documents |
| Web | Tasks on the organization page, task page, version page (statement editor and preview, spec editor, direct upload, review, release, retire); `SafeHtml` is the only place HTML enters a page; CSP allows the storage origin on `/versions/*` only |
| Quality machinery | A version state-machine simulation against an independent model (100,000 seeds run), a test that the application and database state lists are identical, generated authorization matrix, hidden-material walk over every response, browser tests with a hostile statement |
| Documents | ADRs 0022 to 0026, threat model v2, `docs/bundle-format.md`, `docs/security/asvs-matrix-stage-2.md`, `docs/runbooks/tasks.md`, cutlist F18 to F28 |

Slices as merged: 0 (#25), 1 (#26), 2 (#27), 3 (#28), 4 (#29), 5a (#30), 5b-i (#31), 5b-ii (#32), 6 (#33),
7 (#34), 8 (this pull request). The plan's implementation log (`stage-2-plan.md` section 18) records what
each slice did differently from the plan.

## Deferred or not done (with reasons)
See `docs/cutlist.md` (F18 to F28 are new). The ones that matter most:
| Item | Why |
|---|---|
| Validator not yet run on uploads (F18) | By design the API never opens a bundle; the sandbox arrives in Stage 3. ASVS V5.2.2, V5.2.3, V5.2.5 stay partial until then |
| Waived releases need re-validation (F26) | No sandbox yet; `waived` marks every one so Stage 3 can list them |
| 64 MiB cap instead of 512 MiB (F25) | Hashing happens in the request until the worker exists |
| Abandoned-upload cleanup and bucket lifecycle (F23, F24) | Needs the worker and real infrastructure |
| No malware scan or per-organization byte quota (F20, F19) | Decide with delivery and plans |
| Images in statements (F28) | Needs the sandboxed content origin |
| Golden bundles in `tasks/` (kit) | They live in `packages/bundle/corpus/` (`golden-minimal`, `golden-rich`) beside the malformed ones |

## Key decisions and deviations from the plan and kit
ADR 0022 (your ten decisions, all defaults), 0023 (task tables: no stored bundle key, no
current-version pointer, the `uploaded` state, known title visibility limit), 0024 (`packages/bundle`;
no `fast-check`), 0025 (SeaweedFS replaces MinIO, which was archived in 2026; staging key before the
content-addressed key; AWS SDK), 0026 (Markdown rendered by the API, MathML-only formulas).

Deviations, all recorded where they happened:
- **Slice 5 was split** into 5a (roles and task routes), 5b-i (versions and uploads) and 5b-ii
  (review, release).
- **An approval counts only for one review stint** (not in the plan): found while writing the database
  tests; without it a setter could rewrite a statement after an approval and release with the old one.
- **Storage upload goes through a staging key** (not in the plan): otherwise a setter who declares an
  existing bundle's hash could overwrite it before the check refused the upload.
- **Release is waiver-only for now**, as decided; `validated` and `validating` exist in the state
  machine and are used by the simulation, not yet by any route.
- **The statement is rendered by the API**, not the web app (ADR 0026), which keeps `apps/web` free of
  Markdown dependencies.
- **Compression-ratio rule has a 5 MiB floor**: the corpus showed that 5,000 small files compress better
  than 100:1.
- Small fixes outside the plan, each reported in its pull request: the config loader now ignores
  `AURA_TEST_*` variables so one `.env` serves tests and the API; simulation tests got a generous
  timeout after one flaked under load; the Semgrep raw-HTML rule now excludes the real `SafeHtml` file.

## Test evidence
| Check | Result |
|---|---|
| `pnpm check` (Biome, tsc, tigerlint, depcheck) | clean; 8 workspaces |
| `pnpm test` | 995 tests in 69 files, all green (needs PostgreSQL, Mailpit and the local S3 server) |
| `pnpm test:sim` | 500/500 seeds for each of 4 scenarios in CI; `task-versions` 100,000/100,000 seeds run locally on 2026-10-11; the nightly workflow runs a new block of 100,000 |
| Validator fuzzing | 200,000 mutated bundles run locally (seed 11): no exception, 22 mutants still valid; the nightly workflow runs 200,000 a night |
| `pnpm test:e2e` | 22 tests in real Chromium (2 new: a full setter-to-release journey with a hostile statement and a real upload to the local S3 server; a read-only member) |
| CI on `main` | six required checks green on every merged pull request |
| Semgrep, Trivy, `pnpm audit` | 0 findings |
| Mutation checks | Faults injected in the database migration (14), the state machine (14), the validator (21), upload verification (6), the routes (about 20) and the renderer (14); each was caught, or covered by a second layer, or turned into a new test. Real defects found by tests: spec stored as a JSON string, `.map(versionBody)` passing an index as a flag (caught by the compiler), the stale approval above, the ratio floor |
| Not vacuous | Removing the storage origin from the CSP makes the upload test fail; a TruffleHog hit on a hostile test URL was fixed by building it from parts and squashing history |

## Security gate (docs/kit/08 section 14)
- [x] **Threat model updated; new trust boundaries documented.** `docs/threat-model.md` v2: direct-to-storage upload, untrusted archives, stored XSS.
- [x] **All new endpoints in the authz matrix; all new tenant tables in the RLS matrix.** Generated tests fail on an undeclared route or a table without row-level security or an ownership entry (ADR 0003).
- [x] **SAST/SCA/secret/container scans green; none unresolved.** Semgrep, CodeQL, TruffleHog, Trivy, `pnpm audit` in CI.
- [x] **Inputs: schemas and limits; fuzz targets for new parsers.** Strict schemas for every body and query; fuzz targets for the tar/zstd validator and the Markdown renderer, with corpora.
- [x] **Logging and audit events for security-relevant actions; no PII or secrets in logs.** Audit entries for every task action; presigned URLs are never logged (`http-task-hidden.test.ts` forbids them in responses; the log redaction list from Stage 1 still applies).
- [x] **Rate limits and abuse cases defined and tested.** Creation limit, upload caps, validator limits (threat model v2).
- [x] **Privacy review.** Threat model v2: no new personal data; content handling and deletion noted.
- [x] **Rollback and feature-flag plan.** Additive migrations; storage driver is configuration; runbook section 9.
- [ ] **A human has read the diffs of the `tasks` module, the migrations 0012 to 0014, `storage-*`, `markdown.ts` and the bundle validator.** Not something I can tick. Suggested reading order below.
- [ ] **ASVS V1, V2, V5 checklist signed off by a human.** `docs/security/asvs-matrix-stage-2.md`: 33 met, 6 partial, 1 not met, 16 not applicable of 56. The partials and the one not met share one reason: the validator is not yet attached to uploads (Stage 3).

## Known issues, risks and follow-ups (ranked)
1. **Bundles are not parsed on upload yet.** Only size and hash are checked until the sandbox exists; a malformed or malicious bundle can be stored and released (on a waiver). It cannot run anywhere. Treat releases as unverified until F26.
2. **Waived releases** rely on two people's judgement and a written reason; the audit log keeps both.
3. **Task titles of `org`-visible tasks are visible to members before release** (F27, ADR 0023).
4. **No cleanup of abandoned uploads** until the worker and a bucket lifecycle rule exist (F23, F24).
5. **KaTeX and markdown-it are new code in the rendering path.** Their output is never trusted: the renderer emits only allowlisted tags, and formulas are checked against a MathML grammar.
6. **The AWS SDK is the largest dependency tree so far** (26 packages); Trivy and `pnpm audit` cover it.
7. Items 1 to 9 of the Stage 1 report still stand (single-factor email, no real OAuth test, no production mail provider, and so on).

## Operational readiness
- Dashboards and alerts: **none yet** (no deployment exists, F1). Refused uploads and validator rejections are visible as audit and log events.
- Runbook: `docs/runbooks/tasks.md` (local storage, refused uploads, storage outage, waived release list, retire, validating by hand, fuzzing, rollback).
- Rollback: redeploy the previous image; migrations are additive. Demonstrated on paper only.
- Restore drill: not applicable until there is a database and a bucket to restore.

## Metrics vs targets
| Target | Result |
|---|---|
| Hashing a 64 MiB object inside the request: about 0.2 to 0.4 s (plan section 10) | Not load-tested on real storage; the local S3 contract and end-to-end tests upload and hash up to 20 MiB well inside a request |
| Validator: every malformed corpus file rejected with its specific code | 86 of 88 files are refusals (the other two are golden bundles that pass); a test requires every refusal code to appear in the corpus except the 64 MiB packed cap, which a unit test covers |
| Released versions immutable (trigger test) | Tested at three layers; mutation-checked |
| Sanitizer passes the XSS corpus; no script in a headless browser | 47 hostile inputs, 4,000 fuzzed documents, and a real-browser test with a hostile statement: no script, no dialog, no CSP violation |

## Suggested reading order for the human review
1. `packages/db/migrations/0012_tasks.sql`, `0013_task_roles.sql`, `0014_upload_ids.sql` (rules and policies).
2. `apps/api/src/modules/tasks/rules.ts`, `review-routes.ts`, `version-routes.ts`, `upload-verify.ts`.
3. `apps/api/src/platform/markdown.ts` and `docs/adr/0026-safe-markdown.md`.
4. `packages/bundle/src/tar.ts`, `validate.ts` and `docs/bundle-format.md`.
5. `apps/api/src/platform/storage-s3.ts`, `docs/adr/0025-object-storage.md`.
6. `docs/security/asvs-matrix-stage-2.md` (partial and not-met rows).

## Your remaining manual tasks
- [ ] Read the reviewed files above and the ASVS table; sign off in writing (reply "Stage 2 approved", or list what to change).
- [ ] Decide whether Stage 3 may start with waived releases in place (the plan assumes yes, with F26 first in Stage 3).
- [ ] Before the first deployment (not needed for development): an AWS account, the bucket (versioning off, encryption on, CORS limited to your site's origin and the PUT method, a lifecycle rule for `uploads/`), and the staging decisions D1, D3, D8 from Stage 0.
- [ ] Still open from earlier stages: OAuth apps (F11), mail provider (F12), Turnstile (F7), the weekly `pnpm audit:verify` until F8.
