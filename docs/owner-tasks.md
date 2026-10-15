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
| 4A Forge v0 without the sandbox | Approved (2026-10-14) |
| 4C Per-delivery watermarks and leak trace | Approved (2026-10-14) |
| 4B Forge v0 validation | Approved (2026-10-14); model calibration and agent attack runs wait for your provider account; reports stay `development` until the production node exists |

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
**Update 2026-10-12:** I found the Colima VM on your Mac is Ubuntu 24.04 with systemd and cgroup v2, ran
isolate and the escape suite there, and it passed (after fixing three driver bugs it exposed; details in
`judge/node/README.md`). So the suite is no longer unrun. What remains is the same suite on a
production-spec node (x86, hardened baseline) and the external review in 1.3; those need you.
The steps below are for that production node. `judge/node/` has the files I prepared (unverified, see its
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
| Approve the Stage 4B core and say whether to build calibration and the human-attack queue now | Calibration needs a model-provider account; the queue is a standalone feature | Review `stages/stage-4b-report.md`; build the queue next, calibration when you have an account |
| Enroll a node as `production` | Only a reviewed production node may make a report that is called plain "validated" | Never until F32 is done; use `development` (the default) |
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

### 3.7 Stage 5 (contests): what only you can do
1. **Put problems in the practice bank** (F53): create a platform organization, add public tasks, release them, then list
   them as a platform administrator (`POST /api/v1/admin/practice`, see `docs/runbooks/contests.md`).
2. **Pick the pilot** (a date, 200+ people, a partner) once a deployment, the edge and a reviewed judge node exist; I
   then run `contest-start-spike` there (F49) and we rehearse with the runbook.
3. **Contest-day support** (D11): decide who answers questions and watches the queue.
4. **Decide the rating's honesty**: it is our own Elo-MMR-style function; say "rating" not "Elo-MMR" in public until it is
   calibrated on real contests (F50).
5. Approve or change the Java allowances (1 s extra time, 64 MiB reserved) after seeing real tasks (F51).

### 3.8 Stage 6 (exams): what only you can do
1. **Legal review** of `docs/security/privacy-impact-assessment-exams.md`, the consent text (`CONSENT_TEXTS` in
   `packages/contracts/src/exams.ts`; agreeing is a condition of sitting) and `docs/security/dpa-template-exams.md`, for each
   jurisdiction in kit 15 item 33. Nothing about exams should go to real people before this.
2. **A pilot institution and course**, and what they want from the attainment report (outcome mapping, threshold) (F59).
3. **An LLM provider account and budget** (F41/F56) if you want oral defence for real; until then it works only with the scripted
   fake and requests stay pending. Decide the per-institution switch and zero-retention terms with the provider.
4. **Decide cross-exam similarity** (F55): do exams belong to a course or series? Today similarity compares within one exam.
5. **Name two staff per exam host** (appeals need a reviewer other than the decider) and who decides a confirmed case before any
   consequence outside the product.
6. **A human accessibility audit** of the candidate screens (timer, editor, forms); axe passes, but axe is not an audit.
7. The same blockers as contests for any real exam: deployment and edge (F1, F33), a reviewed judge node (F32).

### 3.9 Stage 7 (Passport): what only you can do
1. **A cloud account with KMS** (F1), then I build and test the production signer (F62) and answer Ed25519 versus ES256. Until
   then credentials are development credentials and Passport is off in production.
2. **A domain for the issuer** (D3): the issuer's `did:web` is the site's host; changing it later invalidates credentials.
3. **A human to read the signing and key-management code** (F63) before anything is called production.
4. **Legal review** of the employer module and of what a credential may say about a person, per jurisdiction; decide the policy
   for deleting an account that holds credentials (kit 05: revoke only where required).
5. **Decide the exam-credential policy**: low bands (0-24%) currently issue a credential; the validity (5 years) and whether
   hosts may opt out are yours to set.
6. **A pilot employer**, if you want one, only after (4).
7. An identity-verification vendor, if you want assurance above the event's own (F64).

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
| A production signer; credentials that may be called production credentials; identity proof; real employers | Need KMS, a reviewer, a vendor and legal review | F62 to F67 |
| A real exam with real people; identity proof, proctoring or a lockdown browser; a real LLM provider call | Need review, a deployment and accounts; assurance above level 1 is not built | F32, F41, F55 to F61 |
| Contest pilot with real people, the scoreboard at kit load, a calibrated rating | Need a deployment, an edge and a reviewed judge fleet | F1, F32, F49, F50 |
| Platform-administrator screens (nodes, orgs) | API only for now | F13 |
