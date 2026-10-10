# Stage 2 plan: tasks and bundles

Status: **approved on 2026-10-10 with every default (ADR 0022); Stage 1 signed off.** Kit reference: `docs/kit/12` Stage 2, `docs/kit/05` (tasks and bundles), `docs/kit/06`
(task endpoints), `docs/kit/07` section 7 (bundle format), `docs/kit/08` sections 4 and 5.

## 1. Goal
After this stage a setter can create a task, upload a versioned content-addressed bundle straight to
object storage, have the server check its size and hash, move the version through review to a release,
and see its statement rendered safely. Released versions can never change. Nothing is judged yet:
running code and parsing untrusted archives on a sandbox arrive with Stage 3. The stage also builds the
two pieces of security-critical machinery everything later depends on: the **bundle ingest validator**
(a pure library, fuzzed) and **`renderMarkdownSafe`** (the only way user Markdown reaches a page).

## 2. Decisions I need from you (my default in bold; say "defaults" to accept all)
1. **Where bundles are stored.** **An S3-compatible server in `infra/compose.yml` for development and
   CI, the AWS S3 API in production (no AWS account is needed until the first deploy).** The kit names
   MinIO; the ADR will check whether it is still the right local server before we commit to it.
2. **What "content-addressed" means in this stage.** The kit hashes the *uncompressed* tar, which the
   API cannot do without decompressing untrusted data (forbidden on the API host). **Stage 2 addresses
   a bundle by the SHA-256 of the exact bytes uploaded; the canonical-tar hash is computed and recorded
   by the sandbox validation in Stage 3.** Same security story, one extra field later.
3. **Bundle size cap in this stage: 64 MiB (kit: 512 MiB).** With no worker yet, the API hashes the
   upload while streaming it from storage during `finalize`; 64 MiB takes well under a second. The cap
   rises to 512 MiB when the worker exists (cutlist item).
4. **New organization roles `setter` and `reviewer`** (the kit's names), added to owner, admin and
   member. Setters write tasks; reviewers approve; **nobody can review a version they created**.
5. **Release without sandbox validation, for now.** The state machine has `validating` and `validated`
   states, but no sandbox exists to move a version through them. **A reviewer with a fresh passkey check
   can release a version on an explicit, audited waiver** (the kit already allows a recorded waiver).
   Every such release is marked `waived` in the data, so Stage 3 can re-validate them all.
6. **Statements live in the database, not only in the bundle.** Reading a statement out of the bundle
   would mean parsing the archive on the API host. **The setter edits the statement as Markdown in the
   task version (stored as text, rendered by `renderMarkdownSafe`); the bundle carries a copy and the
   sandbox cross-checks them in Stage 3.**
7. **Supported task kinds: `algorithmic` and `function`.** The other three kinds in the schema
   (`repo_env`, `sql`, `agent_env`) are rejected with a clear code until the stages that need them.
8. **Visibility:** `private` (the setter's organization members with a role) and `org` (all members) are
   enforced. `public` and `licensed` are stored but grant nothing extra until the marketplace stage.
9. **Markdown stack:** `markdown-it` with raw HTML switched off, our own allowlist over its token
   stream (not a regular-expression filter over HTML), and KaTeX with `trust: false`. No second
   sanitizer library.
10. **The ingest validator is TypeScript, with a language-neutral test corpus.** Stage 3 can run it
    under Node in the sandbox or port it to Go; either way it must pass the same corpus files.

## 3. Assumptions (tell me if any is wrong)
1. No new application modules outside `apps/api/src/modules/tasks/`; the validator is a library with
   no I/O except a file reader passed in (kit prompt), living in `packages/bundle` (new package, ADR).
2. Tables follow the Stage 1 pattern: UUIDv7 keys, `org_id`, forced row-level security, rows in the RLS
   matrix and the ownership list, column-level grants that hide anything hidden.
3. Tests, reference solutions, checker and verifier code inside a bundle are **hidden material**: no
   response schema contains them, and the application database role cannot read the storage keys of
   hidden parts (only the setter's organization, through a separate authorization action).
4. The upload never passes through the API. The browser (or a script with an API key) sends the parts
   to presigned URLs; the API only issues URLs and checks the result.
5. One bundle per version, immutable once uploaded: re-uploading means a new version.
6. Bundle storage keys are `bundles/<org_id>/<sha256>`; the organization prefix and the hash both appear
   so one organization can never read or overwrite another's object.
7. Everything user-visible stays in plain accessible markup; the design system is a later stage.
8. The worker does not exist, so nothing here runs in the background; every step is one request.

## 3b. New dependencies (each gets an ADR and a `deps.json` entry; 3-day release rule applies)
| Package | Where | Why | Notes |
|---|---|---|---|
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | api | Multipart upload, presigned URLs, size and hash reads | Official SDK instead of hand-rolled request signing; the largest dependency tree so far, reviewed in the ADR |
| `markdown-it` | api, web | Markdown parsing | Raw HTML off; used only through `renderMarkdownSafe` |
| `katex` | api, web | Formulas | `trust: false`, fixed macro set |
| `fast-check` | dev, bundle and api | Property tests and fuzzing for parsers | Kit calls for fuzz targets on every parser |
| S3-compatible server image | `infra/compose.yml` | Local and CI storage | Digest-pinned, pulled from a registry without Docker Hub's anonymous limit (ADR 0010) |

No tar or zstd package: Node 24 has `zlib` zstd support, and the tar reader is a small strict parser
that rejects everything unusual (it is the thing we fuzz). The budget for `apps/api` (25) is respected.

## 4. Scope
**In:** `TaskSpec` contracts; tasks, task versions, bundle metadata and review records with row-level
security; the version state machine as a pure module with a simulation scenario; the ingest validator
library and its malformed-bundle corpus and fuzz target; the storage port with an in-memory adapter for
tests and the S3 adapter; presigned multipart upload and `finalize` with server-side size and hash
verification; task routes with authorization-matrix rows and audit entries; `renderMarkdownSafe` with an
XSS corpus, a browser test and a Semgrep rule; basic task screens; threat model v2.

**Out:** running or judging anything (Stage 3), the sandbox, the worker and queue, validation reports
from real runs, difficulty calibration, marketplace and licensing behaviour, deliveries, task kinds
beyond `algorithmic` and `function`, bundle download for judge nodes, content scanning beyond what the
validator does, billing.

## 5. Data model (new migrations, expand-only)
| Table | Purpose | Row-level security |
|---|---|---|
| `tasks` | org, slug (unique per org), kind, visibility, title, current released version pointer | members with a role that may read tasks; setters and above write |
| `task_versions` | per task: sequence number, state, spec (validated JSON), statement text, bundle key, size, SHA-256, `waived` flag, created by | same as tasks; hidden columns (bundle key) readable only by the owning organization's setters, reviewers, admins and owners |
| `task_reviews` | one row per review decision: reviewer, outcome (approved, changes requested, rejected), comment | same organization; the reviewer cannot be the version's creator (a constraint) |
| `bundle_uploads` | an upload in progress: storage upload id, expected size and hash, expiry, who started it | the starter and their organization's setters |

Constraints as assertions: state in the closed set; `released` rows are immutable (trigger on update and
delete, with a test); a version's creator never appears as its approving reviewer; sequence numbers are
gapless per task; at most one version per task in `validating`; size within the cap; hash 32 bytes.
Also a migration adding `setter` and `reviewer` to the membership role check.

## 6. API and contracts
New schemas in `@aura/contracts` (strict, with limits): ids `tsk_` and `tsv_`, `TaskSpec` v1 (title,
limits, languages, scoring, tests list without contents, samples, license, provenance), task and version
objects, upload and review requests. Routes under `/api/v1` (each with an authorization-matrix row):
- `POST|GET /tasks`, `GET|PATCH /tasks/{id}`
- `POST /tasks/{id}/versions` (creates a draft and returns the multipart upload plan: part size, part URLs)
- `POST /task-versions/{id}/finalize` (server checks size and hash, moves to `uploaded`)
- `PATCH /task-versions/{id}` (statement and spec while in `draft`)
- `POST /task-versions/{id}/submit-review`, `/review` (reviewer), `/release`, `/retire`
- `GET /task-versions/{id}` (never returns hidden material or storage keys to anyone below setter)

## 7. Security design (key rules)
- **No archive parsing on the API host.** The API checks size and the SHA-256 of the object as bytes
  only. The validator library is exercised by tests and fuzzing here, and runs in the sandbox from Stage 3.
- **Presigned upload.** Short-lived part URLs scoped to one key and one upload id; the key includes the
  organization; the declared size and part count are bounded; `finalize` re-reads size and hash from
  storage and refuses mismatches; abandoned uploads are aborted by expiry (cleanup is a cutlist item
  until the worker exists, and bucket lifecycle rules cover it in production).
- **Storage access.** The API role for storage can write only under `bundles/` and read only to hash.
  Objects are served only as downloads (`Content-Disposition: attachment`), never inline, never from the
  application origin.
- **CSP.** The upload page needs `connect-src` to include the storage origin, and only that page does.
  The storage bucket's CORS allows only our origin and the `PUT` method.
- **Immutability.** A released version cannot change at any layer: the state machine refuses it, the
  application role has no update privilege on released rows, and a trigger raises.
- **Separation of duties.** Creators cannot review their own versions (constraint and code); releasing
  and waiving need a fresh passkey check (ADR 0018).
- **Hidden material.** Response schemas are allowlists with no storage keys or test contents; a test
  walks every task response and fails if any hidden field name appears.
- **Markdown.** `renderMarkdownSafe` is the only function that returns HTML for user text. A Semgrep
  rule bans `dangerouslySetInnerHTML` and `innerHTML` elsewhere; an XSS corpus runs in a real browser
  and asserts that no script executes and no handler attribute survives.
- **Statement size and shape.** Statements are capped (64 KiB), images are not allowed in Stage 2
  (assets come with the sandboxed content origin), links are `https` or relative only.

## 8. Invariants (each asserted in code and covered by a test)
1. A bundle's recorded hash and size equal the stored object's, checked by the server at `finalize`.
2. A released version never changes; its bundle key and spec are fixed.
3. State changes follow the state machine only; each is a single SQL statement guarded by the previous
   state, so two reviewers acting at once cannot both win.
4. A version's creator never approves it.
5. A task has at most one current released version.
6. `renderMarkdownSafe` output contains only allowlisted tags and attributes, for every input
   (property-tested: idempotent, no script, no handlers, no `javascript:` URLs).
7. The validator returns a specific error code for every malformed bundle in the corpus and never throws
   on any byte sequence (fuzzed).
8. No response contains hidden material.

## 9. Limits (named constants with units and reasons, in `limits.ts`)
Bundle 64 MiB (this stage); entries per bundle 5,000; one test file 64 MiB; compression ratio 100:1;
statement 64 KiB; task title 120; slug 3 to 40; tasks per organization 1,000; versions per task 100;
parts per upload 100 at 8 MiB or more; upload plan lifetime 1 hour; part URL lifetime 15 minutes;
unfinished uploads per person 5; page size default 25, maximum 100.

## 10. Back-of-envelope
Hashing a 64 MiB object while reading it from storage: about 0.2 to 0.4 s of CPU and a streamed read at
local-network speed, comfortably inside a request. At the planned cap of 512 MiB it would be 2 to 3 s,
which is why that waits for the worker. Task and version reads are single indexed lookups. Storage
volume is dominated by bundles: 1,000 organizations times 100 tasks times 5 MiB average is about 0.5 TB,
cheap object storage, nothing for PostgreSQL to carry (it stores keys and hashes only).
Revisit triggers: bundles above 64 MiB wanted before the worker exists; more than 100 uploads an hour.

## 11. Work breakdown (small vertical slices, tests first, one PR each)
| # | Slice | Verify |
|---|---|---|
| 0 | ADRs for dependencies; contracts: ids, `TaskSpec` v1, limits | `pnpm check`, contract tests, depcheck |
| 1 | Migration: roles `setter` and `reviewer`; `tasks`, `task_versions`, `task_reviews`, `bundle_uploads` with row-level security, immutability and separation-of-duties rules | Database tests with two organizations; trigger tests; mutation checks |
| 2 | Version state machine (pure `rules.ts`) plus a simulation scenario against an independent model | Simulation 500 seeds in CI, 100,000 nightly; mutation checks |
| 3 | `packages/bundle`: strict tar reader, ingest validator, malformed-bundle corpus **written first**, fuzz target | Every corpus file rejected with its specific code; fuzz run never throws; golden bundles pass |
| 4 | Storage port, in-memory adapter, S3 adapter, local S3 server in compose and CI, presigned multipart plan, `finalize` with size and hash checks | Adapter contract tests run against both adapters; tampered and short uploads refused |
| 5 | Task routes: create, list, versions, finalize, review, release, retire; authorization matrix rows; audit entries; step-up for release and waiver | Generated matrix; HTTP tests through the real app; hidden-material walk |
| 6 | `renderMarkdownSafe`, XSS corpus, property tests, Semgrep rule, browser XSS test | Corpus in headless Chromium: no script runs; Semgrep rule tested |
| 7 | Task screens: list, create, version page with upload and statement editor, review and release; CSP exception for the storage origin | Browser journeys with axe; CSP check; upload of a golden bundle end to end |
| 8 | Hardening: threat model v2 (untrusted archives, stored XSS, upload abuse), ASVS rows for the new surface, runbook entries, stage report | Security gate checklist |

## 12. Things only you can provide, and when
- **Before slice 0:** your answers to section 2 (or "defaults"), and Stage 1 sign-off.
- **Before the first deployment (not for Stage 2 development):** an AWS account and the bucket policy
  decisions (staging decisions D1, D3, D8 from Stage 0 still apply).
- **At the end of the stage:** your sign-off, and a human read of the new database and upload code.

## 13. Failure modes and tests (summary)
Upload interrupted or abandoned; part missing or out of order; object larger or smaller than declared;
hash mismatch; tampered object replaced after upload; storage unavailable at `finalize` (typed 503,
nothing half-recorded); two `finalize` calls racing; two reviewers acting at once; creator trying to
approve; editing a released version by any route; slug collisions; versions of someone else's task;
malformed bundles (zip-slip paths, absolute paths, NUL bytes, symlinks, hardlinks, device files,
duplicate names, too many entries, huge entries, compression bombs, truncated archives, bad checksums,
non-canonical tar headers, mismatched spec and files); Markdown with scripts, handlers, `javascript:`
links, nested formulas that expand to HTML, unterminated constructs, and megabyte inputs.

## 14. Threat model additions (STRIDE highlights)
Tampering: replacing a bundle after the hash check (keys are content hashes under the organization, and
objects are never overwritten); a released task changed later (three layers). Information disclosure:
hidden tests leaking through APIs, errors, logs or storage URLs. Denial of service: zip bombs and
upload floods (caps, ratio limit, per-person upload limit, expiry). Elevation: a setter approving their
own work; a member reading another organization's bundle. Stored XSS through statements (single
renderer, corpus, browser test, CSP). SSRF: none, because nothing fetches user-supplied URLs.
The full table lands in `docs/threat-model.md` v2 with slice 8.

## 15. Observability
Audit entries for task creation, version creation, finalize (with hash), review decisions, waivers,
releases and retirements, with ids and hashes but no content. Counters for refused uploads and
validator rejections are logged now and become metrics when the stack exists.

## 16. Rollout and rollback
Migrations are additive and the new tables are unused by older code. The storage adapter is chosen by
configuration, and the in-memory adapter is forbidden outside tests. Each slice merges with green CI.

## 17. Open questions
Section 2 is the list. Anything you answer differently changes the slices it touches (storage: slice 4;
hash definition and cap: slices 4 and 5; roles: slice 1; waiver: slices 2 and 5; statements: slices 1 and
6; markdown stack: slice 6; validator language: slice 3).

## 18. Implementation log
- **Slice 0 (#25):** contracts, limits, ADR 0022.
- **Slice 1 (#26):** migration 0012 and ADR 0023. Two refinements found while building: an approval
  counts only for the review stint it was given in (`submitted_at`), and the bundle key and
  current-version pointer are not stored.
- **Slice 2:** `modules/tasks/rules.ts` (pure state machine), `sim/task-versions.sim.ts` against an
  independent table model, and a test that compares the machine's allowed pairs with the database
  trigger's. Faults injected into the rules (creator may reject, no approval, no step-up, wrong source
  state, waiver flag, member reviewing, ...) were all caught by the simulation or the unit tests; one
  (release from `uploaded`) is an equivalent mutant because `uploaded` never holds an approval.
- **Slice 3:** `packages/bundle` (ADR 0024, `docs/bundle-format.md`): strict reader, validator, 88-file
  corpus, mutation fuzzer. Mutation testing of the validator found two corpus gaps (checksum value,
  non-adjacent letter-case duplicate), both closed; the corpus found one design flaw (the ratio rule
  rejected bundles with 5,000 small files), fixed with a 5 MiB floor. No new dependency: `fast-check`
  was dropped from the plan.
- **Slice 4:** storage port with S3 and in-memory adapters (one contract suite for both, run against a
  real SeaweedFS), presigned multipart parts with a signed content length, and `verifyUpload`
  (staging key, size and SHA-256 check, copy to the content-addressed key). ADR 0025: SeaweedFS
  replaces MinIO (archived); uploads go to a staging key first, because otherwise a setter could
  overwrite a verified bundle by declaring its hash. The HTTP routes that call it are slice 5.
