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

## STRIDE for the Stage 4C surface (per-delivery watermarks and the leak trace, v6)
|---|---|---|---|
| **Repudiation/Disclosure**: a leaked bundle names nobody | Delivered bundles | Each delivered copy carries a tag derived by the database from the delivery's secret watermark id (answer-line trailing spaces for whitespace-blind checkers, a comment in each solution), recorded in `delivery_bundles`; `trace-leak-cli` names candidates and a person decides | `watermark.test.ts`, `trace.test.ts`, `trace-leak-cli.test.ts`, `pack-e2e-cli.ts` |
| **Tampering**: a mark changes a customer's results | Rewritten bundles | Marks only where a verdict cannot change (answers a token checker ignores; solution comments); test inputs never touched; the node re-runs the harness on the original and the copy and the control plane delivers the copy only if every verdict, mutant and attacker outcome is identical | `rules.test.ts` (watermark), `watermark_isolate_test.go` |
| Spoofing/Elevation: a node chooses its own tag or delivers a different bundle | Watermark job | The tag is computed by `record_delivery_bundle`/`delivery_tag` in the database; the node's word on hash and size is never taken (the API measures the upload); the source hash must be the version's own; the attestation is read from the node row | `watermark.test.ts` (db), `http-watermark.test.ts` |
| Disclosure: the watermark id or tags reach a customer | Responses | The id and tags are in no response; only platform administrators can read `delivery_bundles`; the node learns a tag but not which delivery it names | `watermark.test.ts` (db), allowlisted response schemas |
| Elevation: rebuilding an archive runs on the host | Rewriter | The rewrite happens in a box on a judge node (pinned Node, read-only mount), from a bundle the validator accepted, and the result is validated again before it is returned | `rewriter_isolate_test.go`, `rewrite.test.ts` |
| Tampering: a customer receives a bundle other than the recorded one | Downloads | A link points at the key the database chose (the delivery's own copy, or the original when nothing was marked); a ready delivery without a recorded bundle is an error, never a fallback | `http-deliveries.test.ts`, `handlers.database.test.ts` |
| Denial of service: watermarking floods nodes | Queue | One job per ordered version (at most 100); 3 attempts; dead jobs are visible in the queue and leave the delivery pending | `watermark.test.ts` (db) |

**What is not claimed.**
- The marks survive a verbatim copy, a partial copy and a copy with files dropped (tested). A leaker who
  normalizes whitespace in the answers and strips the comments in the solutions erases them (tested, and
  the trace finds nothing); we say so.
- Tasks with an `exact` or custom checker and no solutions carry the statement canary only, because no
  safe carrier exists; the manifest says which marks each copy carries.
- A `development` node's re-check is labelled in the manifest (`checked_on`); only a reviewed production
  node (F32) makes it more than evidence.
- The 20-task run used 20 versions of one bundle, not 20 different authored tasks, and one development VM.
- A dead watermark job leaves its delivery pending; there is no automatic recovery or alert (F39).

## Privacy review (Stage 4C)
No new personal data. The tag identifies a delivery, which identifies a customer organization; it is
readable only by platform administrators.

## STRIDE for the Stage 5 surface (contests, the Arena, ratings, practice; v7, built)
| Threat | Surface | Control (ADR 0031 and its amendments) | Evidence |
|---|---|---|---|
| **Disclosure**: a stranger or an early registrant reads a contest's problems | Problem statements | Statements readable only by registered people from `running` (the host's staff always); never in `draft` or `scheduled` for contestants. The route returns an allowlist (no tests, checker or bundle) with safe HTML | `contests.test.ts` (db), `http-contest-problem.test.ts`, RLS matrix |
| Disclosure: a contestant reads hidden material through the new access | Tests, solutions, bundles, reports, comments | The rule opens only the statement and limits of a released version of the contest's own problems; the staff routes (`/task-versions/:id`) stay closed to outsiders, also for the practice bank | `http-task-hidden`-style checks, `http-practice.test.ts` |
| Disclosure: per-test verdicts used to probe hidden tests | Verdicts during a contest | Verdict and score only; the policy on `verdict_details` hides per-test results until the contest ends | `contest-submissions.test.ts` (db), `http-contest-submissions.test.ts`, browser test |
| **Elevation/Tampering**: an organizer or problem author competes with inside knowledge | Registration | Owners, admins, setters and reviewers of the host or problem organizations cannot register as competitors | `contests.test.ts` (db) |
| Tampering: submissions after the end, before registration, or by a direct insert | Contest submission | Created only by `create_contest_submission` with the injected clock (window, registration, language, interval, queue cap); the app role cannot insert contest submissions; a practice submission to a live contest's problem is refused by a trigger on both practice routes | db and HTTP tests, `rules.database.test.ts` |
| Tampering: a finished submission is rewritten | Submissions | Immutable except one guarded transition: a staff rejudge (count +1, old verdict kept as `previous_verdict`); every other change is refused by the trigger; rejudges are audited and refused after finalize | `http-scoreboard.test.ts` (guard bypass attempts) |
| Repudiation: scoreboard disputes | Scoreboard | A pure, order-independent fold of the judged log; incremental application equals recompute; stored boards carry a version and etag; the final board is the host staff's | `scoreboard.test.ts` (500 seeds), simulation `scoreboard` (500 seeds, a broken fold is caught) |
| Disclosure: a frozen scoreboard reveals later events | Public view | Events after `freeze_at` are excluded from the public fold until the host unfreezes (once, after the end) or finalizes; a rejudge keeps the old verdict counting so the board does not flicker | `http-scoreboard.test.ts` |
| Information: private profiles exposed on a public scoreboard or in history | Scoreboard, profiles, ratings | Only public profiles are named, everyone else is "participant N"; no user id is stored in a board; a rated contest must be public; unlisted/private/missing profiles are one 404 | `http-scoreboard.test.ts`, `http-ratings.test.ts` |
| Denial of service: submission floods starve a contest | Queue, routes | Contest priority above practice (cap 10,000 vs 1,000), per-person (30/min) and per-problem interval limits, queue-full 503 | `contest-submissions.test.ts`, load run (zero lost at 100/s) |
| Denial of service: readers of the scoreboard exhaust the process | Snapshot, export, stream | Reads fetch only the etag, answer 304, and serve text built once per etag (gzip once); a shared-cache window of one second; streams carry pings not boards, with caps (5,000/instance, 3,000/contest, 5/person, 20/address), a keepalive and a 30-minute lifetime | `scoreboard-cache.test.ts`, `scoreboard-hub.test.ts`, `http-scoreboard.test.ts`, load run |
| **Denial of service: the database pool deadlocks** (a handler holds a connection and asks for a second; found by the load run, older than Stage 5) | Every route that rate-limits inside a handler | At most half the pool is inside handlers at once, with a bounded line (503 + Retry-After) | `gate.test.ts`, `http-pool-gate.test.ts` (hangs without the gate) |
| Tampering/Information: contestant text (clarifications) used for injection | Clarifications | Plain text only: contracts reject NUL and blank text, length-bounded, the page renders it as text, answers once and append-only (trigger), no asker identity in responses, 20 questions per person per contest and 6 a minute | `http-clarifications.test.ts` |
| Tampering: rating manipulation or double rating | Ratings | Only judged contest submissions of people who submitted; rated once per contest under an advisory lock, oldest finalized first, recorded in the same transaction; history rows never change; ratings are never edited by hand | `rating-tick.database.test.ts`, simulation `rating` (a replay reproduces the store exactly) |
| Elevation: a non-administrator curates the practice bank or sets the status banner | Admin routes | Platform administrator only, fresh step-up, otherwise the same 404 as a missing route; audited | `http-practice.test.ts`, `http-status.test.ts`, authz matrix |
| **Elevation (sandbox)**: untrusted C and Java code escapes the box | Judge nodes | Same box as C++ and Python; 15 escape attacks per language (16 for Java), the suite refuses a language that lacks one; `javac -proc:none`; Java mounts only `/etc/java-21-openjdk`, read-only | `TestEscapeSuite` and `TestLanguages` on the **development VM only** (runbook); external review (F32) not done |
| Information: the platform banner is abused to phish | Status banner | Plain text only (no links, no markup), 280 characters, set by administrators with step-up | `http-status.test.ts` |

**Not designed away.** There is no identity proof, no proctoring and no AI-policy enforcement in Stage 5;
a contest's results are only as trustworthy as an unproctored online contest. Similarity or plagiarism
detection is a Stage 6 signal. Ratings are computed, never edited. The rating function is ours, not a
port of a published system, and has not been calibrated on real contests. Java and C evidence comes from
one development VM. A contest cannot be extended or cancelled once published (no such feature), and
finalizing needs only one owner or admin (no second approver; ASVS V2.3.5).

## STRIDE for the Stage 6 surface (exams and integrity, v8, built)
| Threat | Surface | Control (as built) | Evidence |
|---|---|---|---|
| **Tampering**: a candidate's answer is lost or changed after they were told it was saved | Autosave | Server `seq` with a greater-than rule, content hash, idempotent repeats, acknowledgement only after commit; the client deletes nothing until acknowledged | `exam-saves` simulation 500/500 (mutation-checked: fails if the deadline check or the commit-before-ack is removed); `save-rules.database.test.ts` 1,500 random requests, SQL equal to the pure rule; load run: 2,000 people, 0 lost acknowledged saves |
| Tampering: saving or submitting after the deadline | Autosave, submit | `save_exam_draft` and `submit_exam_session` take the injected clock and refuse at or after `deadline_at`; the exam state alone is not trusted; a stopped worker cannot extend an exam | `http-exam-saves.test.ts`, the simulation, `exams.test.ts` |
| **Disclosure**: a candidate reads other candidates' work, grades or per-test results | Sessions, submissions, grades | Forced RLS on every exam table; a candidate sees only their own session; a problem is readable only during their own sitting; results only when `released`; the exam problem view and the result are separate allow-listed shapes | RLS matrix, `http-exam-session.test.ts`, `http-exam-grading.test.ts` |
| Disclosure: telemetry collected without consent, or beyond the closed list | Telemetry ingest | `ingest_telemetry` requires a started sitting with consent; closed kinds, counts and durations only, no text; 200 events per batch, 400 per 10 s; times clamped to the sitting | `http-exam-telemetry.test.ts` |
| Information: telemetry kept too long or read by the wrong people | Telemetry store | Monthly partitions; `purge_exam_telemetry` deletes by the exam's retention (1 to 365 days) and is the only deleter; staff of the host read through policy; updates and other deletes refused by a guard | `http-exam-telemetry.test.ts` |
| **Repudiation**: an integrity decision cannot be explained or challenged | Flags, decisions, appeals | A flag stores kind, evidence (staff only), a plain explanation (candidate-safe) and the rule version; each decision and appeal is audited; the appeal is reviewed by someone other than the decider, **enforced in SQL** | `integrity-rules.database.test.ts` (400 flags x 8 random operations equal to the pure rules; mutation-checked), `http-exam-integrity.test.ts` |
| Elevation: a program, not a person, decides a case | Integrity, oral defence | Flag states change only through staff-only functions; the model writes questions and nothing else; `score` is set only by `score_oral_defence`; **no AI-text detector** exists in the code | same tests; `http-exam-oral.test.ts` (a model reply carrying a `score` is rejected) |
| Tampering: hostile candidate code steers the model | Oral-defence prompts | Code only in the user part, inside one block it cannot close, cut at 20,000 characters; constant instructions; the reply must match a strict schema (3 to 5 questions, no extra fields, no links, no control characters); model calls outside transactions; no tools, no secrets | `oral-prompt.test.ts`, `http-exam-oral.test.ts`. **Verified with a scripted model only: no real provider has been called (F41)** |
| Disclosure: other material sent to a provider | LLM calls | Only the candidate's own code goes to the port; audit rows hold counts only | `oral-tick.ts` review; a real adapter and a per-institution switch are not built (F41) |
| Denial of service: a start-of-exam stampede or autosave flood | Sessions, saves | Per-session save cap (60 a minute, 20,000 a problem, 256 KiB), batched telemetry, the request gate from Stage 5, bounded batches in the tick | Load run at 2,000 people (`stage-6-load-2000.json`): no errors; hand-in surge p50 about 2.1 s, queueing the whole class for judging took 19 s |
| Tampering: a roster upload poisons accounts | CSV roster | Whole-file validation before any write; row and byte caps; emails lower-cased; invitation only through the join flow | `http-exams.test.ts` |
| Disclosure: similarity results shown to the wrong people | Similarity | Pairs only to the host's staff; authorization before query validation; never to candidates; the explanation a candidate reads names no one | `http-exam-similarity.test.ts`, `http-exam-integrity.test.ts` |
| Disclosure: a spreadsheet formula in a name or email runs when staff open an export | Grade export | Cells starting with `= + - @`, tab or CR get a leading apostrophe | `http-exam-grading.test.ts` |
| Elevation: one admin decides and reviews their own case | Appeals | The reviewer must differ from the decider; a host with one admin cannot review (documented in the runbook) | tests above |

**Not designed away.** No identity proof, webcam, screen recording or lockdown browser (assurance level 1 only; see
`docs/security/seb-lockdown-note.md`): an exam here is as strong as an open-book exam at a computer the candidate controls
plus the signals above. A person with a second device is invisible to it. The judge is still evidenced on one development
VM (F32). Similarity compares within one exam only (no course concept yet).

## STRIDE for the Stage 7 surface (Passport, v9, built)
| Threat | Surface | Control (ADR 0033) | Evidence |
|---|---|---|---|
| **Spoofing**: a forged credential passes as ours | Verify page, JWT | ES256 signature over the JWT checked against the published key set for its `kid`; unknown or revoked `kid` is `invalid`; claims schema is strict | tamper and wrong-key tests, independent verifier (slice 2, 4) |
| Tampering: a credential's claims edited | JWT | Signature covers header and payload; the page shows only verified claims, never the unverified text | tamper tests (slice 4) |
| Tampering: signing key stolen | Signer | The application never holds the key; the dev signer refuses outside development and test; the KMS adapter (not run) never exports | refusal test (slice 1); **KMS custody unverified (F62)** |
| **Repudiation**: we cannot say who issued or revoked | Issuance, revocation, keys | Every issuance, revocation, visibility change and key change is an audit event; credentials hold `kid` and an issue time | audit tests |
| **Disclosure**: a private credential is found | Verify page, JSON, status list | Private by default; unknown and private look the same (`unknown`); the status list holds bits, no ids; ids are unguessable UUIDs | HTTP tests (slice 4, 6) |
| Disclosure: a credential carries more than the person agreed | Claims | Strict claim schemas: no email, no per-test results, no integrity evidence; exam points shown as a quarter band only | contract tests (slice 0) |
| Disclosure: employers see more than consented | Employer search | Invite-only, MFA, `public` only, every view logged and shown to the candidate | HTTP tests (slice 9) |
| Elevation: someone earns a credential they should not | Issuance | One per (subject, event) by dedupe; exam credentials withheld for a confirmed, un-overturned flag; assurance never above the event's | DST, job tests (slices 5, 7, 8) |
| Denial of service: verification depends on the database | Verify | Verification needs only the JWT, key set and status file, all static; page degrades to those | database-stopped test (slice 4); real edge untested (F1) |
| Tampering: status list altered or stale | Revocation | Rebuilt by the worker on every change; a bit is set iff revoked (property tested); stale-ok cache policy documented | golden file, DST (slices 3, 5) |

Added while building: a **holder who could revoke** (a null role made a refusal condition null) was found by a test and fixed; a
**share link's secret** is stored only as a hash, its answers are never shared-cacheable, and a link opens only its own
credential; the **employer log** is written in the same statement as the report and is append-only; **re-signing after a key
revocation** is the one case where signed text may change, allowed only through `reissue_credential` for a credential whose key is
revoked (the guard refuses every other rewrite).

**Not designed away.** Development credentials are not production credentials (F62). Identity proof comes from a vendor that does
not exist yet; assurance 1 means the event's own rules, not a verified person. A credential proves an event happened under stated
conditions; it does not prove a person's skill beyond it.

## Privacy review (Stage 7, draft)
Credentials are personal data the person controls: private by default, visible only as chosen, revocable by the person (hides) or
the issuer (status bit). They hold the event title, the host's name, a rank or a quarter band, the AI mode and times; never an email
or integrity evidence. Employer access is the risk that matters: consent is the person's `public` choice, purpose is hiring
search, every view is logged and shown to the candidate, accounts are invited and MFA-protected. **Needs legal review per
jurisdiction before any real employer is invited**, as does the effect of a credential outliving an account (the kit says deletion
revokes credentials only where required; the policy is the owner's).

## STRIDE for the Stage 8 surface (Tier-2 environments and agent evals, v11)
| Threat | Surface | Control (ADR 0034) | Evidence |
|---|---|---|---|
| **Elevation**: an agent escapes its sandbox | gVisor sandbox on a judge node | runs only on judge nodes, never API/web hosts; no host paths; no network by default; limits on memory, pids, disk, time and output; escape suite with positive controls | slice 2 (Go tests on the Colima VM). **gVisor is a lower assurance than a microVM; no microVM was run (F68)** |
| Elevation: a gVisor result is passed off as microVM-grade | Credentials, customer delivery | `isolation` recorded on every run; `isolationAllows` refuses gVisor above level 1 and for customer delivery without opt-in; opting in never raises the level | contract tests (slice 0), db and HTTP tests (slice 8) |
| **Tampering**: the agent changes the checker or its config | Verifier | verifier and hidden files in a second sandbox that gets only the final workspace; protected paths hashed before and after | slices 4 and 5 |
| Tampering: the agent games the score (reads answers, edits tests, detects the harness) | Reward hacking | honeypots, per-run canaries, tamper hashes, recorded probes; a flag is evidence for a person, never an automatic verdict | purpose-built hacking environment is flagged, an honest run is not (slice 5) |
| **Disclosure**: hidden tests or the verifier leak to the agent | Image, mounts | hidden material never in the agent's image or mounts; verifier separate | slice 4 |
| Disclosure: the agent reaches the host's or another tenant's network | Network | default none; an allowlist of DNS names pinned at start, default-drop, flows logged; no address literals or private names in the spec | spec tests (slice 0); containment tests (slice 6) or documented as off |
| **Repudiation**: a run cannot be explained afterwards | Trace | append-only, size-capped, node-signed trace of commands, workspace hashes and flows | slice 7 |
| **Denial of service**: a hostile or runaway agent starves a node | Resource limits | per-run caps; wall limit; output cap; trace cap; one run per sandbox; poison-job rules as Tier-1 | escape suite resource probes (slice 2) |
| Spoofing: a forged result for a run | Node protocol | as Tier-1: mTLS, lease epochs, schema/bounds/consistency validation; node signs traces | slice 8 |

**Added by slices 8 to 10 (v11), observed on one development VM.**
|---|---|---|---|
| Elevation: a malicious image archive writes outside its directory, through a link, or via a hard link | The node's unpacker | Names cleaned and kept inside; nothing written through a link; hard links copied from an unpacked regular file and refused otherwise; entry, byte and depth caps; archives pinned by SHA-256 | `extract_test.go`. The unpacker runs in a gVisor sandbox by default (F70 done; `--tier2-extract=in-process` is an explicit opt-out) |
| Elevation: an unprivileged node needs privilege to run `runsc` | Node host | Helper commands run through a configurable elevation prefix; the agent itself is unprivileged; files go back to the node's user after each run | End-to-end run on the VM. **The VM's sudo is unrestricted; narrowing it is not done** |
| Tampering: a node reports a forged or altered trace | Control plane | Ed25519 signature over the exact bytes, checked before parsing; strict shape; parts must agree | slice 8 tests |
| Denial of service: leftovers accumulate on a node | Judge node | Run directory, mount and cgroup removed on every path; the drill finds none after hostile runs | `TestCompromisedGuestDrill...`. **No startup sweep of stale sandboxes; unreaped zombies seen (F71)** |
| Denial of service: many runs exhaust node memory | Workspace memory file system | Per-run disk limit equals the memory file system size | Sizing rule in the runbook. **No admission control (F74)** |

**Not designed away.** Firecracker, and everything the kit asks of it, is not built; gVisor shares the host kernel and is weaker. A
run is evidence, not proof of what an agent can do, and no figure from one development VM is a capacity or cost claim.

## STRIDE for the Stage 9 surface (business systems, v12; added slice by slice, ADR 0036)
|---|---|---|---|
| Elevation: an organization gives itself a better plan | `customers` | Writes only through `set_org_plan` (platform administrator, checked in the database, fresh passkey check at the route, audited); no application role can insert or update | `http-billing.test.ts` |
| Information disclosure: a member or stranger learns another organization's plan or billing references | `org_entitlements`, `customers` | Entitlements only to members of that organization; `customers` rows only to owners and administrators; a stranger and a missing organization answer identically | `http-billing.test.ts` |
| Elevation: a feature check that forgets the plan | Every sold feature | One function and two pure checks; an unknown plan or missing row means the free plan | `rules.test.ts` |
| Tampering: usage is double counted, forgotten or edited | `usage_events` | Written by triggers in the transaction that records the fact, unique on (organization, kind, source), guard trigger refuses update and delete | `http-billing.test.ts`, `http-environments.test.ts`, `http-passport-employer.test.ts` |
| Denial of service: an organization queues unlimited runs | Environment run requests | Monthly allowance from the plan, counting finished and waiting runs, answered `plan_limit_reached` (402); soft by at most the concurrency of requests | `http-environments.test.ts` |
| Spoofing: a forged, tampered or replayed payment webhook changes a plan | `/api/webhooks/stripe` | HMAC-SHA-256 over the exact bytes with the endpoint secret, constant-time; five-minute window both ways; one answer for every failure; nothing parsed before the signature; without a configured secret the route is a 404 | `stripe-signature.test.ts`, `http-billing-webhook.test.ts` |
| Tampering: a delivered-twice or out-of-order event undoes a plan | `apply_provider_event` | Provider event id is the key (advisory lock for concurrent duplicates); an older event is `stale`; a staff-set plan is `staff_managed` and untouched; record never changed | `http-billing-webhook.test.ts`. **Signature scheme written from Stripe's documentation and tested against signatures computed in the test, never against Stripe (F77)** |
| Elevation: a member or stranger buys a plan, opens the billing portal, or learns the billing account | `/orgs/:id/billing/*` | Owners and administrators only (stranger 404, member 403), fresh passkey check, audited; the provider is told the organization and plan from the request and return addresses from our own origin; no provider configured means nothing is offered | `http-billing-checkout.test.ts` |
| Elevation (SSRF): a customer's webhook address makes us reach our network or the cloud metadata service | `platform/webhook-egress.ts` | https only, ports 443/8443, a DNS name never an IP literal, no credentials; our own lookup refuses the connection when any resolved address is not global unicast, so the address checked is the address connected (no rebinding gap); no redirects; body capped at 64 KiB; connect 5 s and total 10 s limits; errors carry fixed words, never the address or the remote's text | `webhook-egress.test.ts` (a real local server counts connections: blocked means none) |
| Tampering: money lines that do not add up, or are edited afterwards | `ledger_*` | Debits equal credits per currency at commit (deferred constraint triggers, also against writes that bypass the posting function); positive whole-unit amounts; rows never changed; posting the same fact twice returns the first | `ledger.database.test.ts` |
| Repudiation: our usage and the provider's books drift apart unnoticed | Monthly reconciliation | Each month compared once, differences recorded (never repaired automatically) and logged as an error by the worker | `reconcile.test.ts`, `tick.database.test.ts`. **Against a fake provider only (F77)** |
| Information disclosure: a webhook signing secret leaks through the API, a log or a query | `webhook_endpoints` | Secrets are absent from the application role's column privileges (a `select *` fails), shown once in the answer that creates or rotates them, not in audit or logs; rotation keeps the old one signing for 24 hours only | `http-webhooks.test.ts` |
| Spoofing: a receiver cannot tell our delivery from a forgery or a replay | Webhook deliveries | `X-Aura-Signature: t=<seconds>,v1=<HMAC-SHA-256 of "t.body">` (one v1 per secret in force); receivers reject timestamps more than five minutes off | `rules.test.ts`, `tick.database.test.ts` |
| Denial of service: a dead receiver is hammered, or two workers send the same delivery | Delivery worker | Backoff doubling from 30 s to 4 h, given up after 24 h; claims are `skip locked` with a one-minute lapse; at most ten per pass, sent one after another | `tick.database.test.ts` |
| Elevation: an attacker signs in as someone through a forged, replayed or mis-targeted id_token | `/auth/sso/*` | Signature (RS256/ES256 from the provider's own key set), issuer, audience and authorized party, expiry, nonce, verified email; the flow is used once and only from the browser that started it (hashed state, verifier cookie); the redirect address is computed, never read from a request | `oidc.test.ts`, `http-sso-sign-in.test.ts` (fake provider, real tokens; **never against a real provider**) |
| Elevation: account takeover by claiming someone's email | SSO account linking | A person is recognised by (organization, subject); an existing account is attached only when the verified email is in a domain the organization proved by DNS; one organization can hold a verified domain; a suspended account is refused | `http-sso-sign-in.test.ts`, `http-sso.test.ts` |
| Denial of service / lock-out: enforcing SSO strands people | Enforcement | Needs a verified domain and an administrator who has signed in through SSO; owners of the organization keep other ways in; applies to email, passkey and OAuth sign-in alike | `http-sso-sign-in.test.ts` |
| Elevation (SSRF): a customer's provider address reaches our network | Discovery, key set, token exchange | The same public client as webhooks; discovery must name the issuer typed and only addresses the strict policy accepts | `oidc.test.ts`, `webhook-egress.test.ts` |
| Elevation: a stolen or guessed SCIM token provisions people into another organization or an owner is removed | `/api/scim/v2` | 256-bit random token, only its SHA-256 stored, shown once, revocable; bound to one organization and to a plan with provisioning (checked each request); only addresses in the organization's verified domains; the plan's room is respected; an owner is never removed by SCIM | `http-scim.test.ts`. Rate limited per address (300 a minute; F80 done) |
| Repudiation: a deprovisioned person keeps access | Deprovisioning | Membership removed, SSO sessions revoked, SSO sign-in refused for them | `http-scim.test.ts` |
| Tampering: money paid to the wrong person, twice, or more than was earned | Revenue share and payouts | Every booking and payout is a balanced ledger transaction; revenue is booked once per order item; shares on a task cap at 100% with rounding to the platform; a batch reserves exactly what is available, is paid or cancelled once, and posting it zeroes what is owed; only platform administrators with a fresh passkey check act; each action is audited | `http-revenue.test.ts`, `ledger.database.test.ts`. **No money moves: the payment rail is outside the product and "paid" records a reference** |
| Elevation / repudiation: support staff look at an account without the person knowing or agreeing | `/admin/support` | A summary only, never acting as the person; needs the person's own live grant (at most 24 hours, one at a time, ended by them at will); the look is recorded in the same statement that returns the data and shown to the person; refused for other administrators and for anyone in an exam sitting | `http-support.test.ts` |

## Privacy review (Stage 4A)
New personal data: customer organizations' staff names and email (existing identity data) in orders;
download events with the person's address; contractors' payout amounts and references. Download events
and payouts are readable by the people named above only. Retention is not yet defined for download
events or payouts (F40). Deleting an account does not yet remove them (F24).

## v0 rows (Stage 0, unchanged)
|---|---|---|---|
| Spoofing a request id to poison logs | API request id | Inbound `X-Request-Id` accepted only when the edge is trusted, charset and length checked | `app.test.ts` |
| Tampering with applied migrations | Migration runner | SHA-256 per migration, edit after merge rejected, database ahead of code rejected | `migrate.test.ts` |
| Information disclosure through errors | API errors | RFC 9457 responses with a closed code set; internal causes only in logs | `app.test.ts`, `errors.test.ts` |
| Identity leaking across pooled connections | RLS context | Transaction-local `set_config(..., true)`; leak test; mutation-checked | `context.test.ts` |
| Denial of service by large or slow requests | API | 256 KiB body cap, header and request timeouts, 503 on unready database | `app.test.ts`, `limits.ts` |
| Elevation through framework bugs | Next.js | Thin renderer rules, no auth in proxy, no image optimizer, no ISR, nonce CSP | ADR 0005 |
| Vulnerable software in shipped images | Container images | Distroless runtime, Trivy on every push, non-root, read-only, no capabilities | ADR 0009 |
| Secrets in the repository | Git | `.env` ignored, TruffleHog in CI | `.gitignore`, `ci.yml` |
