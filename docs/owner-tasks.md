# Owner tasks: what only you can do, with the steps

Last updated 2026-10-12 (after Stage 3, PRs #36 to #45). This is the one list to work from. The stage
reports (`docs/stages/stage-N-report.md`) hold the evidence behind each item; this file holds the
**steps**. Tick items in a pull request, or tell me and I will. Anything marked **BLOCKS** stops a
whole class of work until it is done.

## 0. Where things stand
| Stage | State |
|---|---|
| 0 Foundations | Approved (2026-10-10). Open: the staging deploy (section 3) |
| 1 Identity, tenancy, audit | Approved (2026-10-10) |
| 2 Tasks and bundles | Approved (2026-10-11) |
| 3 Queue, submissions, judge | **Built, awaiting your review.** The sandbox has never been run (section 1) |
| 4A Forge v0 without the sandbox | **Built, awaiting your review** (`stages/stage-4a-report.md`) |
| 4B Forge v0 validation | Not started; needs the sandbox gate in section 1 |

## 1. Stage 3: review, sign-off and the sandbox gate (**BLOCKS** any real use of the judge)
### 1.1 Review and sign off (about half a day)
1. Read `docs/stages/stage-3-report.md`, first the table "what is verified and what is not".
2. Read the delegated decisions you did not make: `docs/adr/0027-stage-3-decisions.md` and
   `docs/stages/stage-3-plan.md` section 3. Challenge anything; I will change it.
3. Read the code in the order the report suggests (migrations 0015 to 0019; `modules/jobs`;
   `modules/judge`; `modules/submissions`; `judge/internal`).
4. Read `docs/security/asvs-matrix-stage-3.md` (28 requirements; nearly every open row is "the TLS edge
   does not exist yet").
5. Reply "Stage 3 approved" or list changes.

### 1.2 A Linux judge node (hardware or a VM that supports KVM, or any Linux host for the first test)
Needed so the escape suite can finally run. `judge/node/` has the files I prepared (unverified, see its
README). Steps:
1. Get a Linux machine: Ubuntu 24.04 LTS server, systemd, cgroup v2, 4+ cores, 8+ GB RAM. Nothing else
   may run on it. For the first test a cloud VM is fine; for real use, dedicated bare metal with KVM.
2. Follow `judge/node/README.md` to install isolate (v2.1.1), delegate a cgroup to it, and build
   `aura-judge`.
3. Run the escape suite from `judge/`:
   `AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/isolate -run TestEscape -v`
4. Send me the full output. Any line containing `ESCAPED` or a failure means the node does not go live and
   I fix the driver or profile. All green means the suite passes *on that node*; it is not a review.
5. Do not enroll the node in a real environment until section 1.3 is done.

### 1.3 External review of the sandbox configuration (kit gate; required before public use)
1. Choose a reviewer with Linux sandbox experience (a contractor or a firm). Give them
   `docs/kit/07_Judge_and_Sandbox_Spec.md`, `judge/internal/isolate/`, `judge/node/`,
   `judge/testdata/escape/` and `docs/threat-model.md` (Stage 3 section).
2. Ask for: review of isolate flags, cgroup and kernel settings, seccomp/syscall policy, the node's
   network rules, and extra escape attempts. Record the result in `docs/security/`.
3. Until it is done, run the judge only with accounts you control.

### 1.4 Create the first judge node enrollment (after 1.2 passes, in a non-public environment)
1. Be a platform administrator (section 3.5), sign in with a passkey.
2. `POST /api/v1/admin/judge-nodes/enrollments` (a screen does not exist yet; use the runbook,
   `docs/runbooks/judge.md` section 3). Copy the token: it is shown once.
3. On the node: `aura-judge enroll --control-plane https://<host>/api/judge/v1 --token <token> --name <node-name> --key-file /etc/aura/node.key`.
4. Check it turned `active` (runbook section 2/3).

## 2. Decisions only you can make
| Decision | Why it matters | My default / recommendation |
|---|---|---|
| Single-factor email sign-in (ASVS V6.3.3, V6.3.6) | Enterprise customers may require MFA for everyone | Keep for now; passkey step-up guards every powerful action |
| Stage 3 delegated decisions (ADR 0027) | You delegated them; they are mine to defend, yours to overrule | See the ADR |
| Start Stage 4B (validation, calibration, attacker runs) | It needs the sandbox gate | Wait for section 1.2 |
| Look for a first customer before 4B | Packs can be delivered, labeled "not validated" | Your call; the methodology page says what is true |
| Waived releases may stay until re-validation exists | Stage 2 decision 5 | Yes; re-validate when F30 is built |
| Raising the bundle cap from 64 MiB to 512 MiB | Needs the worker to hash off-request | Later (F25) |

## 3. Before the first real deployment
### 3.1 Cloud, region, entity, domain (staging decisions D1, D3, D8; cutlist F1; ADR 0008)
1. Decide the legal entity (D1), the data region (D3) and the domain (D8).
2. Create the AWS account (or tell me another cloud) and an IAM user/role for infrastructure work.
3. Tell me the values; I write the infrastructure code and the staging deploy.

### 3.2 Database (needed for a safe deploy; cutlist F29)
1. The migration/owner role must be able to bypass row-level security (superuser or `BYPASSRLS`), because
   the `SECURITY DEFINER` functions (cleanup, enqueue, admin) read forced-RLS tables as the owner.
2. Create login roles for the API and worker; grant them membership in `aura_app`, `aura_auth` and (worker
   only) `aura_worker`; never give the API role `aura_worker`.
3. Turn on TLS to the database and backups; do a restore drill.

### 3.3 Object storage (Stage 2 and 3)
1. Create the bucket: block public access, versioning off, default encryption on.
2. CORS: allow only your site's origin and the `PUT` method (browser uploads).
3. Lifecycle rule: abort incomplete multipart uploads after 1 day and expire `uploads/` after 7 days (F23).
4. Create an access key for the API/worker restricted to `bundles/` and `uploads/` of that bucket; put it
   in the deployment secrets, never in the repository.

### 3.4 Accounts for sign-in and mail
1. **Mail provider** (F12): choose one (for example SES or Postmark), verify the sending domain, tell me; I
   write the adapter. Email sign-in stays off in production until then.
2. **OAuth apps** (F11): GitHub OAuth App and Google Cloud OAuth client. Callback URL
   `<AURA_PUBLIC_ORIGIN>/api/v1/auth/oauth/<provider>/callback`. Put client ids/secrets in `.env`
   (development) or the secret store (staging); tell me when done and I run the real-provider checks.
3. **Turnstile** (F7), optional: Cloudflare account and a site key.

### 3.5 First platform administrator
`docs/runbooks/identity.md` section 6, with a second person watching. Review the administrator list
quarterly.

### 3.6 The edge (TLS, certificates, HTTP/2) (F33)
Decide the load balancer/CDN. It terminates TLS, sets `X-Request-Id` and the client address, and (later)
mTLS for `/api/judge/v1`. Then I re-check ASVS V4 and V12 rows and set `AURA_TRUST_EDGE_REQUEST_ID`.

## 4. Routine
- [ ] Weekly: `pnpm audit:verify`; keep the printed audit-chain head outside the database (until F8).
- [ ] Within 72 hours of a high or critical Next.js advisory: update (ADR 0005); CI shows it.
- [ ] After 2026-10-28: ask me for the ADR recording Node 26 as LTS (F2).
- [ ] Quarterly: review platform administrators (`select email from users where platform_role = 'admin'`).
- [ ] Now and then: look at the `nightly` workflow in GitHub Actions (simulations of every scenario with
  100,000 seeds, and 200,000 fuzzed bundles). A failure prints a seed that reproduces it.
- [ ] Keep the local services running when developing: Colima, `infra/compose.yml` (PostgreSQL, Mailpit,
  SeaweedFS), then `pnpm storage:init` once.

## 5. What is deliberately not done yet (so nobody assumes it is)
| Not done | Why | Where tracked |
|---|---|---|
| Any untrusted code run by the judge | No sandbox verified | Section 1; cutlist F32 |
| Bundle opening on nodes; `task.validate`; re-validating waived releases | Need the sandbox | F30, F31 |
| TLS/mTLS edge, deployment, alerts and dashboards | No cloud account yet | F1, F33, F39 |
| Real GitHub/Google sign-in tested; production mail | Accounts missing | F11, F12 |
| Contests, exams, Arena, ratings, credentials | Later stages | `docs/kit/12` |
| Platform-administrator screens (nodes, orgs) | API only for now | F13 |
