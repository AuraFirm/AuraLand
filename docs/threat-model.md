# Threat model (v1, Stage 1)

Updated every stage (docs/kit/08 section 14). v0 covered the shell, the build pipeline and the
database context pattern; those rows are kept at the end. v1 adds identity, tenancy and the browser.

## Assets
1. **Accounts and the ability to act as someone**: sessions, passkeys, sign-in secrets, API keys.
2. **Tenant data isolation**: organizations, memberships, and everything later stages attach to them.
3. **Integrity of the audit trail**: who did what, when.
4. **Personal data**: email addresses, device and network hints, the export and deletion promises.
5. **Availability of sign-in** and of the outbound services it needs (mail, GitHub, Google).
6. **Secrets**: the login-token key (`AURA_LOGIN_TOKEN_SECRET`), OAuth client secrets, database credentials.

## Actors
Anonymous visitor; ordinary signed-in person; organization member, admin, owner; holder of an API
key; platform administrator; an attacker who controls a mailbox, a browser extension, another website
the victim visits, a network position, or a leaked database dump; a malicious insider with database
read access; a compromised dependency.

## Trust boundaries
1. Internet → edge (not built) → **web** (Next.js, renders UI, decides nothing) → **API** (all decisions).
2. API → **PostgreSQL**, as one of two roles: `aura_auth` (identity work before or around login) and
   `aura_app` (everything on behalf of a person, bound by row-level security). The database is a
   second decision point, not a store.
3. API → **mail service**, **GitHub**, **Google** through the egress client only (fixed origins,
   no redirects, timeouts, size caps).
4. Browser → API: same origin, cookie plus a custom header on writes.
5. Machine → API: bearer API key, no cookie.

## STRIDE for the Stage 1 surface
| Threat | Surface | Control | Evidence |
|---|---|---|---|
| **Spoofing**: take over an account through the email route | Sign-in link and code | 256-bit link, 8-digit code with 5 guesses, 10 and 5 minute lives, single use, bound to the requesting browser, keyed-hash storage | `http-sign-in.test.ts`, `http-red-team.test.ts`, `login` simulation |
| Spoofing: pre-account takeover with a provider | OAuth sign-in | Identity is the provider's id; only a provider-verified email may create an account; an existing email is never linked silently; linking needs a signed-in session | `http-oauth.test.ts` (22 cases), ADR 0016 |
| Spoofing: phishing the second factor | Passkeys | Origin and relying-party id checked by the browser and the server; user verification required; counter regression refused | `http-passkeys.test.ts` (wrong origin, wrong key, replay, regression) |
| Spoofing: forge or replay a session | Session cookie | 256-bit random token, hash stored, `__Host-` cookie, HttpOnly, SameSite=Lax; new token on every sign-in | `http-sessions.test.ts`, `sessions` simulation |
| Spoofing: login CSRF / state fixation | OAuth and email flows | State plus PKCE bound to a cookie; callback needs both; email proof bound to the browser | `http-oauth.test.ts`, `http-sign-in.test.ts` |
| **Tampering**: cross-site request forgery | All writes | Custom header, exact Origin, `Sec-Fetch-Site`; API keys exempt because they carry no ambient credential | `http-sessions.test.ts`, matrix CSRF rows, ADR 0013, ADR 0018 |
| Tampering: change another organization's data | Organizations, members, keys, invitations | `authorize()` plus row-level security using the caller's role read in the database; outsiders get 404 | `orgs.test.ts`, `api-keys.test.ts`, `invitations.test.ts`, `authz-matrix.test.ts` |
| Tampering: promote oneself or remove the last owner | Memberships | Role changes owner-only; no direct inserts for the app role; last-owner and cap rules are locked database triggers | `orgs.test.ts` (races included) |
| Tampering: edit or delete audit history | `audit_log` | Append-only triggers, hash chain, `pnpm audit:verify`; chain head must also be kept outside the database (open, F8) | `audit.test.ts`, `http-*.test.ts` chain checks |
| **Repudiation**: deny an action | Audit log | Sign-ins, signups, factor changes, role changes, key and invitation actions, admin actions, exports and deletion requests are audited with actor, target and (hashed) context, in the same transaction | per-route tests count audit rows |
| **Information disclosure**: learn who has an account | Sign-in start and verify, OAuth, invitations | Start never looks the address up; one generic failure answer; invitations name an address and do no lookup | `http-sign-in.test.ts`, `http-invites.test.ts` |
| Disclosure: secrets in logs | Everything that logs | No secret reaches a log line even with redaction off; redaction list as a second net | `http-log-hygiene.test.ts`, `log.test.ts` |
| Disclosure: secrets from a database dump | Token, key and secret columns | Only hashes (HMAC under a key kept outside the database, or SHA-256 of 256-bit secrets); the app role has no column privilege on them | `login.test.ts`, `passkeys.test.ts`, `api-keys.test.ts`, `invitations.test.ts` |
| Disclosure: data of other tenants | Every tenant table | RLS enabled and forced (two documented exceptions), generated coverage test, two-organization tests | `rls-matrix.test.ts`, `orgs.test.ts` |
| Disclosure: leakage through responses | API output | Strict allowlist schemas; secrets are not in any schema | schema tests, export test |
| Disclosure: injected script steals a session | Web | Nonce CSP with `strict-dynamic`, no eval, HttpOnly cookie, strict headers; the browser is tested to block an inline handler | `pages.spec.ts` (end to end), `csp.test.ts` |
| Tampering: send someone to another site after sign-in (open redirect) | `?next=` on the sign-in page | The value is looked up in a short list of our own pages and our copy is returned; anything not on the list falls back to the account page. (CodeQL flagged a filter-style check as an unvalidated redirect, so the check was rewritten as a lookup.) | `next-path.test.ts`, `sign-in.spec.ts` |
| Disclosure: invitation secret kept during sign-in | Invitation link opened while signed out | Held in this tab's session storage for one sign-in and removed when read; one-time, tied to one verified email | `orgs.spec.ts`, ADR 0019 |
| **Denial of service**: flood sign-in or email | Anonymous endpoints | Per-address, per-email and per-organization limits, body cap, timeouts; flood drill shows the numbers | `http-red-team.test.ts` |
| DoS: lock a victim out | Code guessing | Locks one challenge, not the account; the victim requests a new one; per-email limit caps inbox flooding at 5 an hour | `http-red-team.test.ts` |
| DoS: provider or mail outage | GitHub, Google, mail | Typed 503 or redirect reason, nothing half-saved, other sign-in methods keep working | `http-sign-in.test.ts`, `http-oauth.test.ts`, `http-invites.test.ts` |
| **Elevation**: use a stale or stolen session for a powerful action | Privileged actions | Passkey check in the last 15 minutes; people who hold power get a 30-minute idle limit on every request; promotion ends the person's other sessions | `http-keys.test.ts` |
| Elevation: API key abuse | Machine access | Org-scoped, `org:read` only, expiring, revocable, 20 per organization, hashed; cannot reach routes meant for people | `http-keys.test.ts` |
| Elevation: becoming a platform administrator | Admin routes | No sign-up path; set by an operator in SQL; routes answer 404 to others and need a fresh passkey check; the database function checks the role again | `http-keys.test.ts`, `api-keys.test.ts` |
| Elevation through a library | SimpleWebAuthn, Next.js, Zod | Exact pins, 3-day release age, `pnpm audit`, attestation `none` (avoids the advisory path), thin renderer rules | ADR 0005, ADR 0015, CI |
| Supply chain | Dependencies, CI | As v0, plus Playwright and axe confined to a test-only workspace | `deps.json`, `depcheck` |
| SSRF through OAuth or mail | Outbound calls | Fixed origins from configuration, redirects refused, response caps; the redirect URI is computed, never read from a request | `egress.test.ts`, `oauth-providers.test.ts` |
| Insecure patterns entering the code | Whole repo | Semgrep project rules, tigerlint, CodeQL; two CodeQL alerts on hashing high-entropy secrets: one avoided by renaming a helper, one dismissed with a written reason (alert 3, ADR 0018) | CI |

## Abuse cases drilled (`http-red-team.test.ts`)
Credential stuffing from one machine (10 emails a minute at most); a botnet against one victim (5
emails an hour at most); a leaked binding cookie (5 guesses in total, from any number of addresses);
guessing proofs without a challenge (30 a minute, none touching real state); flooding the passkey
challenge table (30 rows a minute per address); probing API keys (same answer for a wrong prefix and a
wrong secret).

## Privacy review (Stage 1)
Collected: email address; handle and display name (defaults to a random handle, never derived from the
email); coarse network (/24 or /48) and browser string per session; provider id and the provider-verified
email at link time; passkey public keys and names; audit entries about the person's own actions.
Not collected: IP addresses beyond the coarse network and the audit `ip` of security events, phone
numbers, contacts, analytics. Rights: the person can download their data (`/me/export`), end any
session, remove passkeys and connected accounts, and request deletion (recorded, sessions ended, the
purge itself arrives with the worker in Stage 3). Retention is not yet automated: sessions, challenges,
flows and rate-limit rows are cleaned by the Stage 3 worker (F9).

## Rollback and feature flags
Migrations 0001 to 0011 are additive. Reverting a slice leaves a valid database: unused tables and
columns are ignored by older code. OAuth providers and email are switched on by configuration, so any
sign-in method can be turned off without a deploy of code. There are no feature flags beyond that.

## Known gaps (accepted for Stage 1, ranked in `docs/cutlist.md`)
No TLS termination, WAF or CDN (edge not built). No external anchor for the audit chain head. No
cleanup job for expired rows. No production mail provider, so email sign-in is off in production. No
notifications after security changes. OAuth has not been exercised against the real providers. Rate
limits use fixed windows, which allow a burst of up to twice the limit across a window boundary.

## STRIDE for the Stage 2 surface (tasks and bundles, v2)
New trust boundaries: the browser talks to object storage directly (presigned URLs); the API reads
uploaded bytes from storage to hash them; **bundles are untrusted archives** and are parsed only by the
validator library, which runs in the Stage 3 sandbox, never on the API host; statements are
user-written Markdown shown to other users.

| Threat | Surface | Control | Evidence |
|---|---|---|---|
| **Tampering**: replace a verified bundle by uploading other bytes under its hash | Upload and finalize | Uploads land under `uploads/<org>/<id>`; size and SHA-256 are re-read from storage and compared before the object is copied to `bundles/<org>/<sha256>`; an existing bundle is never overwritten | `upload-verify.test.ts` (forged hash, same-size forgery), `http-task-versions.test.ts` |
| Tampering: change a released version | Task versions | Three layers: the state machine refuses, the application role has no way to update released rows except retiring, a trigger raises on any other change or delete | `tasks.test.ts` (frozen, delete), `rules.test.ts`, simulation |
| Tampering: approve one thing, release another | Review | An approval counts only for the review stint it was given in (`submitted_at`); a change request clears it | `tasks.test.ts`, `http-task-review.test.ts` (approval does not outlive content) |
| Tampering: release without a second person | Separation of duties | Constraint on the creator, trigger on reviews, rule in `decide`, and the simulation checks no release has the creator as approver or releaser | `tasks.test.ts`, `rules.test.ts`, `task-versions` simulation (100,000 seeds) |
| Tampering: skip steps (release a draft) | State machine | Allowed pairs are one list in the application and one in the database; a test compares them; every move is a single guarded statement | `rules.database.test.ts`, `http-task-review.test.ts` (simultaneous releases) |
| **Information disclosure**: hidden tests, solutions or checker code in a response | All task routes | No schema carries file contents or storage keys; keys are derived, not stored; a test reads every response for every role and state and checks key names against allowlists | `http-task-hidden.test.ts` |
| Disclosure: another organization's bundle | Storage keys | The organization is part of every key; keys are built only from uuids and digests; presigned URLs are per key, per part, size-pinned and expire in 15 minutes | `object-storage.ts`, `storage.contract.test.ts` |
| Disclosure: private tasks to plain members | Task visibility | Row-level security: plain members see only released versions of `org`-visible tasks; drafts and private tasks answer 404. Known limit: titles of `org` tasks with no release yet are visible (ADR 0023) | `tasks.test.ts`, `http-tasks.test.ts` |
| **Denial of service**: zip bomb, huge entry, many entries | Bundle validator | Packed 64 MiB, unpacked 256 MiB, ratio 100:1 above 5 MiB, 5,000 entries, 64 MiB per file; the output cap is enforced while decompressing; 88-file corpus and 200,000 fuzzed inputs per night | `packages/bundle` tests, `fuzz-cli.ts` |
| DoS: upload floods and abandoned uploads | Upload plan | 5 unfinished uploads per person, 1-hour plan, 15-minute part URLs, 64 MiB cap checked at finalize; abandoned multipart uploads need a bucket lifecycle rule in production (F23) | `tasks.test.ts`, `http-task-versions.test.ts` |
| DoS: slow rendering of a hostile statement | Markdown renderer | 64 KiB input, 200 formulas, 2 KiB per formula, bounded macro expansion, 1 MiB output cap; pathological inputs finish in well under 2 seconds in tests | `markdown.test.ts` |
| **Elevation**: a setter approving their own work, a reviewer editing content | Roles | Policies split writer and reviewer moves; the authorization table has six roles; routes check role, then state, then facts | `access.test.ts`, `authz-matrix.test.ts`, `tasks.test.ts` |
| Elevation: release or retire from a stolen session | Release, retire | Fresh passkey check (15 minutes) after role and state checks; a written waiver reason is audited | `http-task-review.test.ts` |
| **Stored XSS** through statements | Statement rendering | Raw HTML off, own token renderer with a tag allowlist, https and same-site links only, images off, KaTeX as grammar-checked MathML, strict CSP with no inline script or style; browser test with a hostile statement | `markdown.test.ts` (47 inputs, 4,000 fuzzed), `tasks.spec.ts` |
| XSS through the storage origin | Browser and bucket | Only `/versions/*` may connect to the storage origin; objects are never served inline or from the application origin; nothing in storage is rendered | `csp.test.ts`, `tasks.spec.ts` (fails without the origin) |
| SSRF | Upload and storage | Nothing fetches a user-supplied URL; the S3 endpoint is configuration | `config.test.ts` |
| Repudiation | Task actions | Audit entries for task and version creation, edits, upload start, bundle verified (with hash), submit, review (with outcome), release (with waiver reason), retire, abandon | `http-task-*.test.ts` |
| Supply chain: the AWS SDK, markdown-it, KaTeX | Dependencies | Exact pins, 3-day release age, ADRs 0025 and 0026, Trivy and `pnpm audit` in CI; no tar or zstd package (Node's `zlib` and 150 lines we fuzz) | `deps.json`, CI |

**Untrusted archives, in one place.** The API host never opens a bundle. It checks the size and SHA-256
of the stored object as bytes (`upload-verify.ts`). The validator (`packages/bundle`) has no file,
network or process access (enforced by `tigerlint`), takes bytes and returns a value, and is exercised
by a corpus and a fuzzer. From Stage 3 it runs inside the sandbox on a judge node. Until it is wired in,
ASVS V5.2.2, V5.2.3 and V5.2.5 are partial (`asvs-matrix-stage-2.md`).

**Waived releases.** Until Stage 3 provides sandbox validation, a reviewer with a fresh passkey check can
release on a written reason. Every such version has `waived = true`, so Stage 3 can list and re-validate
all of them (runbook `tasks.md`).

## Privacy review (Stage 2)
New personal data: none beyond what Stage 1 holds. Statements, specs and bundles are customer content,
stored per organization; the audit log holds ids, hashes and waiver reasons, not content. Deletion of an
organization removes its tasks and versions in the database (cascade) except released versions, which a
trigger protects from person-initiated deletes; object deletion on organization removal is a worker job
(F24).

## STRIDE for the Stage 3 surface (queue, submissions, judge nodes, v3)
New trust boundaries: **a judge node is a machine that runs hostile code** and talks to us; participants
send source code to be run; the queue connects the API, workers and nodes; the worker role holds
privileges the application role does not.

| Threat | Surface | Control | Evidence |
|---|---|---|---|
| **Spoofing**: pretend to be a judge node | `/judge/v1` | Enrollment needs a single-use 256-bit token that only a platform administrator (with a fresh passkey check) can create and that expires in an hour; afterwards every request is an Ed25519 signature over method, path and query, timestamp, single-use nonce and body hash; every failure is the same bare 401 | `http-judge.test.ts`, `signing.test.ts`, Go `sign_test.go` (shared vector) |
| Spoofing: replay a captured request | Node requests | Timestamps within 60 s, nonces spent in their own committed transaction (a failed request cannot be replayed either), nonces kept 10 minutes | `http-judge.test.ts` (replays, 4xx replays) |
| Spoofing: a revoked or draining node keeps working | Node state | Revocation is checked on every request; only `active` nodes lease; a failing self-test drains | `http-judge.test.ts`, `http-judge-jobs.test.ts` |
| **Tampering**: a node forges a result | Complete | The control plane, not the node, computes the verdict from the spec and the per-test results (`summarize`); impossible reports (unknown or duplicate tests, results after a failure) are refused and the job goes to another node; a system error is never shown as a verdict | `rules.test.ts`, `http-judge-jobs.test.ts` |
| Tampering: a slow or presumed-dead node overwrites a newer result | Fencing | Every heartbeat, result and failure carries the lease epoch and is applied in the same statement that checks it; the old node gets 409 and discards its work | `jobs` simulation (100,000 seeds), equivalence and race tests, `http-judge-jobs.test.ts` |
| Tampering: edit a finished submission or job | Database | Triggers: finished submissions and jobs never change; source, owner, task and language are fixed; verdict exactly when judged | `http-submissions.test.ts`, `job-store.equivalence.test.ts` |
| **Information disclosure**: hidden tests or jury answers reach a participant | Submission reads | Responses carry the participant's own source, verdict, score and per-test (id, verdict, time, memory) only; checker messages are stored with control characters stripped and never returned; the bundle goes only to the node holding the lease, through a 5-minute attachment URL | `http-judge-jobs.test.ts`, `http-task-hidden.test.ts` |
| Disclosure: another person's submission | Submission reads | Row-level security: owner and organization owners/admins only; strangers get 404 | `http-submissions.test.ts`, authorization matrix |
| **Denial of service**: flood submissions | Create | 6 a minute per person per task, 256 KiB source, load shedding at 1,000 ready jobs (503 with `Retry-After`, nothing left behind) | `http-submissions.test.ts` |
| DoS: poison submission crashing every node | Queue | Attempts are bounded (5) with exponential backoff, then the job is dead and the submission `failed_system` (not the participant's verdict); an alert on dead jobs is still to be built (F39) | `jobs` simulation, `http-judge-jobs.test.ts` |
| DoS: long polls exhausting the database | Lease | A waiting lease is a series of short looks, never an open transaction | `job-routes.ts` |
| **Elevation**: code escapes its sandbox | Judge node | Execution only through the `Sandbox` interface; isolate with cgroup v2, no network, process/memory/time/file limits, fresh box per test; a 15-program escape suite. **Escape suite passed once on a development Linux VM (2026-10-12, Ubuntu 24.04 aarch64, isolate 2.1.1) with positive controls; not yet on the production-spec node, no external review** | `internal/isolate` tests; F32 |
| Elevation: a compromised node reaches the control plane | Node identity | The node holds only its own key; the worker role behind the API can read job and submission rows, the spec and bundle columns of task versions, and append worker-kind audit entries; it cannot read statements, users, sessions or keys; a node cannot act as a person | migrations 0015, 0019; `rls-matrix.test.ts` |
| Elevation: housekeeping functions | `SECURITY DEFINER` | Bounded deletes, executable only by the worker role; they run as the table owner, which must be able to bypass row-level security in production (F29) | `cleanup.test.ts` |
| Supply chain: Go agent | Dependencies | Standard library only; CI pins the Go toolchain action by commit | `judge/go.mod`, `ci.yml` |

**What is not claimed.** (Updated 2026-10-12.) The isolate driver and the 15-program escape suite ran
for the first time on a development Ubuntu 24.04 VM (aarch64) and passed after three fixes the first run
exposed (see `judge/node/README.md`); the ten containment probes were also run unconfined as root to
show they do detect an escape. That VM is not the production-spec node, no participant code has run, and
nothing here has had the external sandbox review the kit requires before public use. Until the
production node passes the suite and the review is done, the judge must not be used with real
participants. The bundle is unpacked by nobody yet: the agent's bundle opener
(download by hash, verify, strict unpack inside a box) and the `task.validate` job are not built (F30,
F31).

## Privacy review (Stage 3)
New personal data: participants' source code (stored in PostgreSQL for as long as the account exists),
verdicts and per-test timings. Not collected: anything from the machine that ran the code. Participants
can read their own submissions; organization owners and admins can read those made in their
organization. Deletion of an account does not yet remove submissions (the purge arrives with the
deletion job, F24). Judge nodes see source code and test data for the jobs they lease and nothing else.

## STRIDE for the Stage 4A surface (orders, deliveries, payments, authoring workspace, v4)
| Threat | Surface | Control | Evidence |
|---|---|---|---|
| **Spoofing/Elevation**: a customer or setter creates or changes orders | Order routes and tables | Platform-administrator role checked in the route, again in every database function; the application role has no insert or update on the four tables; step-up (fresh passkey) on every change | `http-orders.test.ts`, `orders.test.ts`, authorization matrix |
| **Information disclosure**: a customer reads another customer's order or delivery | Orders, deliveries, download log | Forced row-level security by the customer organization's role (owner, admin, buyer); strangers get 404 | `orders.test.ts`, `http-deliveries.test.ts`, authorization matrix |
| Disclosure: the seller's tasks reach a customer's buyer directly | Task tables | A buyer belongs to the customer organization, not the seller's, so task policies show them nothing; they get files only through a delivery | `orders.test.ts` ("does not let a buyer read the seller's task versions") |
| Disclosure: a bundle is fetched without a right to it | Download links | `issue_delivery_download` decides (member with a buyer, admin or owner role; bundle is in the delivery; delivery ready and not expired or revoked) and logs in one step; the link lives five minutes; a failure to mint it rolls the log row back | `http-deliveries.test.ts` |
| Disclosure: a leaked statement or pack cannot be traced to its customer | Statements | A per-delivery canary line is inside each delivered statement. **The bundle bytes are not watermarked in 4A**: a leaked bundle is not traceable by content; only the download log (who, when, address) points to a customer. Test-data watermarks come with 4B (F41) | `rules.test.ts` |
| **Tampering**: edit an order after it is placed, or a delivery after it is built | Order and delivery rows | Triggers: a placed order does not change (except the invoice reference and one payment record); a manifest is set once and must hash to its stored SHA-256, recomputed by the database; revocation is the only later change | `orders.test.ts`, `payouts.test.ts` |
| Tampering: a customer receives something other than what was ordered | Manifest | The manifest lists every file with its SHA-256 and size and has its own hash, shown in the portal; `tools/verify-delivery-cli.ts` and `shasum` check them | `rules.test.ts`, `verify-delivery.test.ts` |
| **Repudiation**: "we never downloaded it" or "staff never revoked it" | Download log, audit | Append-only `delivery_access` (who, when, address, which bundle); audit entries for every order, payment, payout, revoke and download | `orders.test.ts`, `http-orders.test.ts`, `http-deliveries.test.ts` |
| **Denial of service**: link or comment flooding | Routes | 30 links a minute and 20 comments a minute per person; a delivery has at most 100 versions | `http-deliveries.test.ts`, `http-comments.test.ts` |
| Elevation: the delivery worker reads more than it should | Worker role | The build job reaches data only through two functions (read one pending delivery's inputs, store one manifest); no table privileges on orders or deliveries | `handlers.database.test.ts` |
| Disclosure: contractor pay is seen by colleagues | Payouts | Only the contractor and platform administrators read a payout; a payout is for the author of a released version and its agreement never changes | `payouts.test.ts`, `http-payouts.test.ts` |
| Disclosure: a setter or reviewer reads tasks they have no part in | Authoring workspace | Setters see only tasks they made or were assigned, reviewers only assigned tasks, owners and admins all; enforced in policies on tasks, versions, reviews and uploads | `http-assignments.test.ts`, `tasks.test.ts` |
| Tampering/XSS: script in a comment | Version comments | Markdown rendered by `renderMarkdownSafe` in the API; the page inserts only that HTML through its one audited component; comments never change | `http-comments.test.ts`, `tasks.spec.ts` |
| Disclosure: node bundle reads are invisible | Judge protocol | Every grant of a bundle link to a leased node is an audit entry; refusals leave none | `http-judge-jobs.test.ts` |

**What is not claimed.** Every delivery says `validation: not performed`: no pack has been validated,
because validation needs the sandbox, which has never run (F32). The customer is not told a pack is
correct, only what it is (hashes) and who made it (provenance in the spec). No money moves through the
system and no card data enters it; payment and payout rows are staff records. A delivered bundle is the
original bytes, so it is not traceable to a customer by content (F41).

## STRIDE for the Stage 4B surface (validation, v5)
| Threat | Surface | Control | Evidence |
|---|---|---|---|
| **Spoofing/Elevation**: a node claims a task is good, or claims to be a production node | Validation result, node attestation | A node reports raw verdicts only; `evaluateValidation` and the score are computed by the control plane. The attestation is declared by a platform administrator at enrollment, copied to the node row, immutable, and read from that row inside `settle_validation`; no caller supplies it | `rules.test.ts`, `score.test.ts`, `validation.test.ts` (db), `http-judge.test.ts` |
| **Tampering**: mark a version validated without evidence | Task version state | The application role cannot set `validating` or `validated` (policy); `request_validation` and `settle_validation` are the only doors; a trigger refuses `validated` without a passing report; the report's `passed` must agree with its checks | `validation.test.ts` (db) |
| Tampering: change or delete a report | `validation_reports` | Update and delete triggers; rows go only with their version or organization | `validation.test.ts` (db) |
| Tampering: a report that cannot be true (missing tests, duplicate runs, skipped attackers, a mutant that never compiled but was killed) | Node result | Rejected, the job goes to another node; nothing is recorded | `rules.test.ts`, `http-validation.test.ts` |
| **Disclosure**: the bundle or hidden tests reach the wrong place | Node bundle download, opener | A node downloads only the bundle of a job it holds; every grant is audited; the opener runs the validator in a box and only `tests/` and `solutions/` come out as a flat stream the node parses strictly; reports show conclusions, not observations | `http-validation.test.ts`, `opener_isolate_test.go`, `bundles_test.go` |
| Disclosure: unreviewed validation sold as validated | Delivery manifest, portal | Plain "validated" only for a `production` report; a development report says "development sandbox only"; no report says "not performed" | `rules.test.ts` (orders), `handlers.database.test.ts`, `version-validation.tsx` |
| **Denial of service**: validation floods the judge | Queue and node | 100 ready jobs at most; 20 wrong solutions, 40 mutants, 10 attackers per job; per-run limits; a dead job returns its version to `uploaded` | `validation.test.ts` (db), `http-validation.test.ts` |
| **Tampering/Repudiation**: an author clears their own task, or a finding is rewritten after the fact | Human attack findings | A guard trigger refuses the version's author and versions not in review, validation or release; only owners, admins and assigned reviewers write; findings never change and are never deleted; each is audited | `attacks.test.ts` (db), `http-attacks.test.ts` |
| Tampering/XSS: markup in a finding's method | Human attack panel | The method is plain text, returned as text and shown in a text node; 4000 characters, no NUL | `http-attacks.test.ts`, `tasks.spec.ts` |
| Elevation: the opener runs hostile code on the host | Node | The archive is parsed only by the validator inside a box; the box sees a read-only Node tree and nothing else; the node parses a flat, hash-checked stream | `opener_isolate_test.go` (zip bomb, symlink, bad names) |

**What is not claimed.**
- All sandbox evidence comes from one development VM (aarch64, isolate 2.1.1, cgroup v2). There is no
  production node and no external review (F32). Reports from it are `development` reports.
- A task passes the harness if its own solutions behave and ten trivial programs fail; that is not
  proof the statement is clear, the difficulty right or the tests free of mistakes. Models have not
  attacked any task and difficulty is not calibrated (F41); people can record attack findings, but a
  finding is evidence for a reviewer and does not block a release.
- Mutants are textual swaps in C++ and Python references; a surviving mutant may be an equivalent one.
  A task whose real answer is trivially computable (a sum of numbers) is rejected by the sum attacker.
- Custom checkers and interactive tasks are not validated here (the node refuses them).

## Privacy review (Stage 4B)
No new personal data. Reports hold task content derivatives (verdicts, scores) and node ids.

## Privacy review (Stage 4A)
New personal data: customer organizations' staff names and email (existing identity data) in orders;
download events with the person's address; contractors' payout amounts and references. Download events
and payouts are readable by the people named above only. Retention is not yet defined for download
events or payouts (F40). Deleting an account does not yet remove them (F24).

## v0 rows (Stage 0, unchanged)
| Threat | Surface | Control | Evidence |
|---|---|---|---|
| Spoofing a request id to poison logs | API request id | Inbound `X-Request-Id` accepted only when the edge is trusted, charset and length checked | `app.test.ts` |
| Tampering with applied migrations | Migration runner | SHA-256 per migration, edit after merge rejected, database ahead of code rejected | `migrate.test.ts` |
| Information disclosure through errors | API errors | RFC 9457 responses with a closed code set; internal causes only in logs | `app.test.ts`, `errors.test.ts` |
| Identity leaking across pooled connections | RLS context | Transaction-local `set_config(..., true)`; leak test; mutation-checked | `context.test.ts` |
| Denial of service by large or slow requests | API | 256 KiB body cap, header and request timeouts, 503 on unready database | `app.test.ts`, `limits.ts` |
| Elevation through framework bugs | Next.js | Thin renderer rules, no auth in proxy, no image optimizer, no ISR, nonce CSP | ADR 0005 |
| Vulnerable software in shipped images | Container images | Distroless runtime, Trivy on every push, non-root, read-only, no capabilities | ADR 0009 |
| Secrets in the repository | Git | `.env` ignored, TruffleHog in CI | `.gitignore`, `ci.yml` |
