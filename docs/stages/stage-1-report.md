# Stage 1 report: identity, tenancy, audit

Status: **ready for sign-off.** Nothing is merged on your behalf: this is the evidence for the
decision that is yours (docs/kit/12, gate 7).

## Scope delivered
People can sign in four ways (passkey, emailed link, emailed 8-digit code, GitHub or Google), hold
sessions they can see and end, belong to organizations with owner, admin and member roles, invite
others, create machine API keys, export their data and request deletion. Platform administrators can
verify organizations and end a person's sessions. Everything that matters is audited in a tamper-evident
log, and tenant isolation is enforced twice: in the API and in PostgreSQL row-level security.

| Area | What exists |
|---|---|
| Database | 11 migrations; tables for users, profiles, sessions, audit log, login challenges, rate-limit counters, passkeys, passkey challenges, provider identities, OAuth flows, organizations, memberships, API keys, invitations; roles `aura_app` and `aura_auth`; every table in the RLS coverage test |
| API | 42 declared routes, each with an authorization-matrix row; deny-by-default `authorize()`; strict response allowlists; CSRF protection; rate limits; step-up; egress client; mail port |
| Web | Sign-in, link and OAuth result pages, account page (profile, passkeys, connected accounts, devices, export, deletion), organization list and page (members, invitations, API keys), invitation page, site header with sign-out; nonce CSP |
| Quality machinery | Deterministic simulations for sessions and sign-in challenges; memory and PostgreSQL store equivalence tests; generated authorization matrix; Playwright with a virtual passkey device and axe; red-team drill; log-hygiene test; nightly 100,000-seed simulation workflow |
| Documents | ADRs 0011 to 0021, threat model v1, ASVS mapping, authentication reference, identity runbook, cutlist |

Slices as merged: 0 (#7), 1 (#8), 2a (#9), 2b-i (#10), 2b-ii (#11), 3a (#12), 3b (#13), 4 (#14),
5 (#15), 6a (#16), 6b (#17), 6c (#18), 7a (#19), 7b (#20), 8 (this pull request). The plan's
implementation log (`stage-1-plan.md` section 18) records what each slice did differently from the plan.

## Deferred or not done (with reasons)
See `docs/cutlist.md` (17 items, ranked, with owners). The ones that matter most:
| Item | Why |
|---|---|
| Staging deploy (F1) | Needs your cloud account, region and domain (carried from Stage 0) |
| Real OAuth with GitHub and Google (F11) | Needs OAuth apps created by you; tested against a fake provider that enforces PKCE |
| Production mail provider (F12) | Provider not chosen; email sign-in is off in production until it is |
| Notifications after security changes (F3) | Needs the mail provider; ASVS L3 items |
| Audit-head anchor, nightly verifier, cleanup job (F8, F9) | Need object storage and the Stage 3 worker |
| Turnstile (F7) | Needs a Cloudflare account; rate limits cover the same abuse for now |

## Key decisions and deviations from the plan and kit
ADRs 0011 (in-house identity on small libraries instead of Better Auth), 0012 (roles and audit chain),
0013 (cookie and CSRF), 0014 (email sign-in), 0015 (passkeys), 0016 (OAuth), 0017 (organizations),
0018 (keys, step-up, verification), 0019 (invitations), 0020 (screens and end-to-end tests), 0021
(hardening).

Deviations, all recorded where they happened:
- **Arctic was not used** (planned): it calls `fetch` directly and has fixed endpoints, which conflicts
  with the egress-only rule and with fake-provider tests. The flow is 200 lines on the egress client.
- **Playwright and the browser passkey library moved from slice 4 to slice 7**, when there were pages.
- **Slices were split** (2 into 2a, 2b-i, 2b-ii; 3 into 3a, 3b; 6 into 6a, 6b, 6c; 7 into 7a, 7b).
- **Sign-in lifetimes**: link 10 minutes and code 5 minutes (plan said 15 and 10) to meet ASVS V6.5.5.
- **No `login_tokens` table**: sign-in challenges and invitations have their own tables.
- **Timing test for enumeration** became a structural test (the start step never looks the address up);
  wall-clock timing tests are flaky.
- **Kit says "Better Auth", "TOTP", "Turnstile hook", "SES"**: not built; see ADR 0011 and the cutlist.

## Test evidence
| Check | Result |
|---|---|
| `pnpm check` (Biome, tsc, tigerlint, depcheck) | clean; 189 files, 0 violations |
| `pnpm test` | 627 tests in 52 files: api 441, database 108, contracts 32, tools 41, web 5 |
| `pnpm test:sim` | 500/500 seeds for each of 3 scenarios in CI; 100,000 seeds of each run locally on 2026-10-10 (result below); nightly workflow runs a new block of 100,000 |
| `pnpm test:e2e` | 19 tests in real Chromium: email code, email link, wrong code, signed-out redirect, passkey add/sign-in/rename/remove, devices, export, deletion and cancel, organizations, invitations, API keys; axe-clean on every page; zero CSP violations; the browser blocks an injected handler |
| CI on `main` | six required checks (verify including build, audit and end-to-end; images; semgrep; secrets; analyze; CodeQL) green on every merged pull request |
| Semgrep, Trivy, `pnpm audit` | 0 findings; no known vulnerabilities |
| Mutation checks | Every slice injected faults into its own logic (about 100 in all) and the tests caught each one or the fault was covered by a second layer; the exceptions found were turned into new tests |
| Real problems the tests found | session rotation at the cap evicted an unrelated session (simulation); a mutation survived the equivalence test until a guess-flood scenario was added; Zod's `eval` probe blocked by the CSP, hydration mismatch and low button contrast (browser); test-time race creating server-wide roles on a fresh PostgreSQL (CI) |

100,000-seed simulation (local, 2026-10-10, seeds 1 to 100,000): `selftest-queue` 100000/100000, `sessions` 100000/100000, `login` 100000/100000 ok.

## Security gate (docs/kit/08 section 14)
- [x] **Threat model updated; new trust boundaries documented.** `docs/threat-model.md` v1.
- [x] **All new endpoints in the authz matrix; all new tenant tables in the RLS matrix.** `authz-matrix.test.ts` fails on an undeclared route; `rls-matrix.test.ts` fails on a table without RLS or without an entry in ADR 0003 (two documented non-forced tables: `audit_log`, `orgs`/`memberships`).
- [x] **SAST/SCA/secret/container scans green; none unresolved.** Semgrep, CodeQL, TruffleHog, Trivy, `pnpm audit` in CI. Two CodeQL alerts about hashing high-entropy secrets: one avoided by renaming a helper, one dismissed as a false positive with a written reason, at your instruction (alert 3, ADR 0018).
- [x] **Inputs: schemas and limits; fuzz targets for new parsers.** Every body, query and cookie is parsed against a strict schema with caps. The only new parsers are Zod schemas and the WebAuthn library; no custom binary parsers, so no new fuzz targets.
- [x] **Logging and audit events for security-relevant actions; no PII or secrets in logs (test).** `http-log-hygiene.test.ts`, `log.test.ts`; per-route tests count audit rows.
- [x] **Rate limits and abuse cases defined and tested.** `docs/security/authentication.md` section 2; `http-red-team.test.ts`.
- [x] **Privacy review.** In `docs/threat-model.md`: what is collected, export, deletion, retention gap (F9).
- [x] **Rollback and feature-flag plan.** Additive migrations; sign-in methods switched by configuration; runbook section 11.
- [ ] **A human has read the diffs of `identity`, `db/rls` and `infra` changes.** Not something I can tick. Suggested reading order below.
- [ ] **ASVS V6, V7, V8 checklist signed off by a human.** The mapping is `docs/security/asvs-matrix.md`: 47 met, 5 partial, 4 not met, 23 not applicable of 79. The four not met are L3 items or accepted by product decision; each has a follow-up.

## Known issues, risks and follow-ups (ranked)
1. **Email sign-in is single-factor** (ASVS V6.3.3 partial, V6.3.6 not met). Product decision; powerful actions need a passkey. Worth revisiting before enterprise customers.
2. **OAuth has never talked to the real providers.** The fake provider enforces PKCE and rejects reused codes, but a registration mistake only shows up with real apps.
3. **No production mail provider**, so email sign-in is off in production.
4. **The audit chain head is not anchored outside the database yet**; deleting the newest rows would not be detected. Run `pnpm audit:verify` weekly by hand and keep the printed head until F8.
5. **Expired rows are never cleaned** (F9). Harmless to correctness; grows slowly.
6. **Fixed-window rate limits** allow a burst of up to twice the limit across a boundary (F16).
7. **CodeQL's name-based "password hash" heuristic** will keep matching helpers named after credentials; expect more alerts of that kind and decide case by case.
8. **Invitation emails are sent before the commit** and hold a connection for up to 5 seconds (ADR 0019).
9. **Next.js security advisories** keep arriving (ADR 0005): the 72-hour patch rule applies.

## Operational readiness
- Dashboards and alerts: **none yet** (no deployment exists; observability arrives with the first deploy, F1). Counters for failed sign-ins and code locks exist as audit and log events.
- Runbooks: `docs/runbooks/identity.md` (account takeover, leaked key, suspension, secret rotation, platform admins, audit verification, mail and provider outages, deletion requests, rollback).
- Rollback: redeploy the previous image; migrations are additive. Demonstrated on paper only, since nothing is deployed.
- Restore drill: not applicable until there is a database to restore.

## Metrics vs targets
| Target | Result |
|---|---|
| Session lookup about 0.3 ms, one indexed read | Not load-tested. Per request there are now four small indexed reads (session, memberships, platform role, power check); a load test belongs with the first deploy |
| Audit chain a few hundred events a second | Not load-tested; `audit.test.ts` verifies one valid chain under concurrent writers |
| Stage 1 accept list | RLS and authorization matrices generated and green; passkey register and login end to end with a virtual authenticator; rotation and fixation tests; enumeration-safe responses (structural); passkey required for powerful actions; audit tamper detection test; account-takeover drill passes its rate-limit numbers |

## Your remaining manual tasks
Tick these as you go (edit this file in a pull request, or tell me and I will). Last updated 2026-10-10,
after slice 8 (#21).

### To close Stage 1 (required)
- [ ] **Read the security-sensitive diffs** (gate item). Order: `docs/security/authentication.md`, then `docs/security/asvs-matrix.md`, then migrations `0002`, `0004`, `0005`, `0009`, `0010`, then `authorize.ts`, `rules.ts`, `sign-in.ts`, `oauth.ts`, `passkey.ts`, then `auth-middleware.ts` and `app.ts`, then the red-team and log-hygiene tests.
- [ ] **Sign off the ASVS table** (`docs/security/asvs-matrix.md`: 47 met, 5 partial, 4 not met, 23 not applicable). Accept or reject each partial and not-met row; follow-ups are in `docs/cutlist.md`.
- [ ] **Decide on single-factor email sign-in** (V6.3.3, V6.3.6): keep it for ordinary people as built, or require a passkey for everyone after their first sign-in.
- [ ] **Approve Stage 1 in writing** (a pull request comment is enough), or list what to change. Then I update `docs/stages/CURRENT.md` and start Stage 2.

### Before the first real deployment (not needed for sign-off)
- [ ] **Staging decisions D1 (legal entity), D3 (region), D8 (domain)**, and an AWS account for them (cutlist F1, ADR 0008).
- [ ] **Choose a production mail provider** (F12). Until then email sign-in is off in production; passkeys, GitHub and Google still work.
- [ ] **Create the OAuth apps** (F11): a GitHub OAuth App and a Google Cloud OAuth client. Callback URL `<AURA_PUBLIC_ORIGIN>/api/v1/auth/oauth/<provider>/callback` (development: `http://localhost:3000/...`). Put client ids and secrets in your local `.env` as `AURA_OAUTH_GITHUB_CLIENT_ID` / `_SECRET` and `AURA_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET`; never commit them. Then do one real sign-in with each and tell me what happened.
- [ ] **Create the first platform administrator** when there is a real deployment: `docs/runbooks/identity.md` section 6, with a second person watching.
- [ ] **Cloudflare account and Turnstile site key** if you want the bot challenge (F7).

### Routine
- [ ] **Run `pnpm audit:verify` weekly** and keep the printed chain head somewhere outside the database, until the automated anchor exists (F8; runbook section 7).
- [ ] **Patch high and critical Next.js advisories within 72 hours** (ADR 0005); CI's audit step will show them.
- [ ] **After 2026-10-28:** ask me for the ADR recording Node 26 as the new LTS (F2).
- [ ] **Review the platform-administrator list quarterly** (`select email from users where platform_role = 'admin'`).
- [ ] **Look at the nightly simulation** (GitHub Actions, workflow `nightly`) now and then. A failure prints a seed that reproduces it exactly.

### Optional decisions I can act on whenever you say
Offer "sign out everywhere" after removing a passkey (F4); platform-administrator screens (F13); return to
the page you were on after signing in (F14); ASVS mapping for the other chapters (F15). Details and owners:
`docs/cutlist.md`.

## Suggested reading order for the human review
1. `docs/security/authentication.md` and `docs/security/asvs-matrix.md` (what is claimed)
2. `packages/db/migrations/0002_roles.sql`, `0004_audit_log.sql`, `0005_sessions.sql`, `0009_orgs_memberships.sql`, `0010_api_keys_stepup.sql` (what the database enforces)
3. `apps/api/src/modules/identity/authorize.ts`, `rules.ts`, `sign-in.ts`, `oauth.ts`, `passkey.ts` (the decisions)
4. `apps/api/src/auth-middleware.ts`, `app.ts` (how requests are identified and wired)
5. The red-team and log-hygiene tests (the proof)
