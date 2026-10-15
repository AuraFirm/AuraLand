# Owner tasks: what only you can do, with the steps

Last updated 2026-10-15 (after Stage 9 and the backlog work, PRs up to #147). The new **section A** below is the master list; the numbered sections after it keep the detailed steps. This is the one list to work from. The stage
reports (`docs/stages/stage-N-report.md`) hold the evidence behind each item; this file holds the
**steps**. Tick items in a pull request, or tell me and I will. Anything marked **BLOCKS** stops a
whole class of work until it is done.

## A. Master list: everything that remains for you, in the order that unblocks the most

Nothing here is optional if you want real customers, real money or real exams. Each item says **what it is**, **why**, **what you hand me**, and
**what I do next**. "Account" means an account in your name that I never hold the keys to: you create it and give me only what the software
needs (identifiers and non-secret settings; secrets go into the secret store, not into chat or git).

### A1. Decide and create (week 1; everything else waits on these)
| # | Item | Why | You do | I do next |
|---|---|---|---|---|
| A1.1 | **Legal entity and jurisdiction** (D1) | Stripe, contracts, tax, the DPA and who is "the company" in the privacy text all depend on it | Pick the entity (for example a Delaware C-corp or a UK Ltd via an incorporation service) and tell me its name and country | Put the entity into the privacy and consent texts and the DPA template; choose direct Stripe or a merchant of record with you (D2) |
| A1.2 | **Domain name** (D8) | The credential issuer address (`did:web`) is the site's host and **cannot change later without invalidating credentials**; cookies, CSP, OAuth callbacks and `security.txt` use it | Buy the domain; choose the registrar. Decide the production host (for example `auraland.<tld>`) and a separate staging host | Set `AURA_PUBLIC_ORIGIN`, the issuer DID and the redirect addresses; configure staging and production hosts |
| A1.3 | **Cloud account: AWS (recommended)** (F1, D3) | One account gives everything the design names: ECS Fargate or EC2 for web/API/worker, RDS PostgreSQL 18 with backups and PITR, S3 for bundles and Passport documents, **KMS for the credential signing key**, SES for mail, Secrets Manager, CloudWatch | Create an AWS Organization with a **separate staging and production account**; turn on MFA for the root user and do not use it; create an IAM role for infrastructure work that I can describe in code (tell me how you want to grant me access: usually you run the infrastructure code yourself and I write it) | Write the infrastructure as code (new ADR first), the staging deploy (F1), the production signer on KMS (F62), backups and the recovery drill (F79), alerts and dashboards (F39) |
| A1.4 | **Region and data-residency promise** (D3, ADR 0038) | Decides where data lives; the residency code is a primitive until a second region exists | Choose the primary region (kit default: EU, Frankfurt or Ireland). Say whether you will promise any customer a specific region | Switch each module's storage to region routing if you do; otherwise state clearly that there is one region |
| A1.5 | **Cloudflare (optional, my suggestion: yes for DNS, TLS edge, WAF, Turnstile)** (F7, F33) | If you want a CDN/edge in front (kit allows CloudFront or Cloudflare): TLS termination, DDoS protection, the request-id and client-address headers the API trusts, optional Turnstile on sign-in | Create a Cloudflare account, add the domain, and tell me whether the edge is Cloudflare or CloudFront. If Cloudflare, create a Turnstile site key (free) | Set `AURA_TRUST_EDGE_REQUEST_ID`, write the edge rules and the cache rules for Passport's static documents (F65), re-check ASVS V4 and V12 (F33) |

AWS and Cloudflare are not either/or: AWS runs the product, Cloudflare (if you choose it) sits in front. If you would rather use one vendor, say
so and I will plan for CloudFront and Route 53 instead.

### A2. Money (needs A1.1)
| # | Item | You do | I do next |
|---|---|---|---|
| A2.1 | **Stripe account** (or a merchant of record: Paddle, Polar) (F77, D2) | Create the account for the entity; complete their verification; create the products/prices you decide on (see A5.1); give me the **publishable key and the product/price ids** (not the secret key) and put the secret key and the webhook signing secret into the secret store | Write the real adapter behind `PaymentProvider`, run it against Stripe's test mode, wire the webhook (`/api/webhooks/stripe`), run reconciliation against real data |
| A2.2 | **Tax and invoicing decision** | Decide: Stripe Tax, a merchant of record, or manual invoices for the first customers (orders are manual today) | Build what you choose; until then plans can only be set by staff or bought in test mode |
| A2.3 | **A bank account and a payout process for setters** | Decide how setters are paid (the product records "paid" with a bank reference; it moves no money) | Adjust the payout batch export to your bank's format if needed |

### A3. Identity, signing and mail (needs A1.3)
| # | Item | You do | I do next |
|---|---|---|---|
| A3.1 | **AWS KMS signing key for credentials** (F62) | After A1.3, create the key in KMS (I give you the exact spec: asymmetric, sign/verify, ECC NIST P-256 for ES256) and tell me its ARN; decide **Ed25519 vs ES256** with me (KMS support for Ed25519 must be checked in your region) | Write and test the KMS adapter behind the `Signer` port, rotate/retire keys by runbook, switch Passport on in staging then production |
| A3.2 | **A person to review the signing and key-management code** (F63) | Find a security reviewer (a colleague, a consultancy or a freelancer). I list exactly what to read: `platform/signer.ts`, `modules/passport/{vc,issue,verify,status-list,publish,reissue}.ts`, migrations 0053-0060 | Fix what they find |
| A3.3 | **Mail provider** (F12) | Choose SES (natural with AWS) or Postmark; verify the sending domain (SPF, DKIM, DMARC records at your DNS); get production sending access (SES starts in a sandbox) | Write the adapter; email sign-in, invitations and exam notices go live |
| A3.4 | **OAuth apps** (F11) | Create a GitHub OAuth App and a Google Cloud OAuth client; callback `<origin>/api/v1/auth/oauth/<provider>/callback`; put client id and secret in the secret store | Run the real-provider checks |
| A3.5 | **A real identity-provider test tenant** (F78) | Create a free Okta developer tenant, a Microsoft Entra ID test tenant and/or a Google Workspace trial so SSO and SCIM can be tested against something real | Run SSO and SCIM against each, fix what differs from my fakes, publish setup guides |
| A3.6 | **First platform administrator** | Follow `docs/runbooks/identity.md` section 6 with a second person watching | - |
| A3.7 | **Identity-proof vendor** (F64), only if a customer needs assurance above level 1 | Pick Persona, Veriff or Stripe Identity and open an account | Build the `IdentityVerifier` adapter and the higher credential levels |

### A4. Judging and sandboxes (needs A1.3 for hosting; a reviewer for the gate)
| # | Item | You do | I do next |
|---|---|---|---|
| A4.1 | **A production judge node** (F32, **BLOCKS any real use of the judge**) | Provision a Linux x86-64 host (Ubuntu 24.04, cgroup v2) that is **not** a shared machine; for Tier-1 any cloud VM works; follow `judge/node/README.md` | Run the escape suite on it, harden the baseline, enroll it as `production` (never before the review) |
| A4.2 | **An external review of the sandbox configuration** (F32, F73) | Hire a sandbox reviewer or pentester; give them `docs/security/red-team-tier2.md`, the escape suites and the threat model; budget for a retest | Fix findings; keep the findings table |
| A4.3 | **A KVM-capable host for Firecracker** (F68) | AWS **bare-metal instances** (`.metal`) or an instance type with nested virtualization on another cloud (check current availability and price yourself); give me SSH access to a throwaway machine | Build the Firecracker driver with its own escape suite, snapshot/restore, density figures, cost per 1,000 runs (F75); then Tier-2 results can be eligible for credentials above level 1 |
| A4.4 | **Decide build versus buy for the first microVM customer** (ADR 0035) | If a customer needs microVM-grade assurance before A4.3 is done: evaluate a managed sandbox (price, regions, who can see code, security record) | Write the adapter behind the `Runtime` port |
| A4.5 | **A model-provider account and budget** (F41, F56, F72) | Anthropic or another provider; set a monthly cap; decide zero-retention terms | Difficulty calibration, agent attack runs, oral defence for exams, customer-model endpoints for agent evals |

### A5. Business decisions only you can make
| # | Decision | Notes |
|---|---|---|
| A5.1 | **Plans, limits and prices** | The numbers in `plans` are my placeholders. Decide names, member/run/verification limits, prices and currency; I change them by migration |
| A5.2 | **Employer module**: who may buy it, and is self-serve OK? | It can be bought by card today (in test mode); legal review first (A6.2) |
| A5.3 | **Whether customers may opt in to gVisor-grade scores** (ADR 0034) | The code refuses otherwise |
| A5.4 | **Key scopes and an SDK** (F83) | Decide whether machine access by API key is a product; if yes, I write the design (ADR) first |
| A5.5 | **Exam series / courses** (F55), **outcome mapping** (F59), **similarity across exams** | Needs a pilot institution to say what it wants |
| A5.6 | **Cross-check my other delegated decisions** | Listed per stage in each stage report under "Decisions I made that you may overrule" |

### A6. Legal, compliance and trust (can start now, in parallel)
| # | Item | You do |
|---|---|---|
| A6.1 | **Legal review of exams** | A lawyer reads `docs/security/privacy-impact-assessment-exams.md`, the consent text and `dpa-template-exams.md` for each jurisdiction in kit 15 item 33. **Nothing about exams goes to real people before this** |
| A6.2 | **Legal review of the employer module** (F67) | Employer access to candidates' public credentials, per jurisdiction |
| A6.3 | **Privacy policy, terms of service, sub-processor list, DPAs, breach-notification procedure** | A lawyer drafts; I supply the facts (what data, where, which vendors) |
| A6.4 | **SOC 2**: pick an auditor, adopt policies (incident response, access review, vendor management, change management) | `docs/compliance/evidence-*.md` shows what the repository can already prove and what needs people. Re-run the collector after each change |
| A6.5 | **Security contact and bug bounty** | Choose the security address, publish `/.well-known/security.txt` (template in `docs/security/`), decide on a platform and budget, have a lawyer read the safe-harbour sentence |
| A6.6 | **A human accessibility audit** of the candidate screens | axe passes but axe is not an audit |
| A6.7 | **Incident response**: who is on call, who tells customers, the 72-hour breach clock | Needed before the first customer; I write the runbook with you |

### A7. People and pilots
| # | Item | You do |
|---|---|---|
| A7.1 | **A first customer or pilot** | Pick one: a contest (200+ people with a partner and a date), an exam at a pilot institution, a company wanting a task pack, or an agent-eval customer. Each needs the earlier items it names (contest: A1.3, A1.5, A4.1-4.2; exam: A6.1, A3.3, A4.1-4.2, A4.5) |
| A7.2 | **Name two staff per exam host** (appeals need a reviewer other than the decider) and **who decides a confirmed case** | Before any exam |
| A7.3 | **Contest-day support** (D11) | Who answers questions and watches the queue |
| A7.4 | **Put problems in the practice bank** (F53) | `docs/runbooks/contests.md` |
| A7.5 | **Approve the stage reports** | Stages 3, 5 and 9 are marked built, awaiting your review; the others you approved |

### A8. Routine once live
Weekly: `pnpm audit:verify` and keep the audit-chain head somewhere the database cannot reach (F8: external anchor, needs object lock in S3). Within 72 hours
of a high or critical Next.js advisory: update. Quarterly: review platform administrators; re-run `node apps/api/src/soc2-evidence-cli.ts`; run the
recovery drill (`node apps/api/src/dr-drill-cli.ts`) against a restored backup once A1.3 exists. After 2026-10-28: ask me for the ADR recording Node 26 as LTS (F2).

### A9. The shortest path to a first real customer
1. A1.1 entity, A1.2 domain, A1.3 AWS (and A1.5 Cloudflare if you want it). 2. I deploy staging (F1) and the edge (F33).
3. A3.1 KMS key, A3.3 mail, A3.4 OAuth: sign-in, credentials and notices work for real. 4. A4.1 production judge node and A4.2 review.
5. A2.1 Stripe (test mode first). 6. A6.1/A6.3 legal. 7. A7.1 the pilot. Everything else can follow the pilot.

### A10. What I can do without any of this
Not much that matters is left: the unblocked backlog is done. If you want me working meanwhile, the useful options are (a) the disk-backed
workspace so images larger than the unpack limit work (F70 remainder), (b) a design for API-key scopes (F83) once you say you want it, (c) SCIM
Groups and more webhook events when a customer asks (F81, F82), and (d) writing the infrastructure code for A1.3 as a draft you review before an
account exists (it cannot be tested without one).

## 0. Where things stand
| Stage | State |
|---|---|
| 0 Foundations | Approved (2026-10-10). Open: the staging deploy (A1.3) |
| 1 Identity, tenancy, audit | Approved (2026-10-10) |
| 2 Tasks and bundles | Approved (2026-10-11) |
| 3 Queue, submissions, judge | **Built, awaiting your review.** The production judge node and the external sandbox review are open (A4.1, A4.2) |
| 4A, 4B, 4C Forge v0, validation, watermarks | Approved (2026-10-14); calibration and agent attack runs wait for a model-provider account (A4.5) |
| 5 Contests, Arena, ratings | Built, awaiting your review; the load target and a pilot need a deployment (A1.3, A7.1) |
| 6 Exams and integrity | Approved (2026-10-15); no real exam before legal review (A6.1) |
| 7 Passport | Approved (2026-10-15); development signer only until KMS (A3.1) |
| 8 Tier-2 environments | Approved (2026-10-15); gVisor only, no Firecracker (A4.3) |
| 9 Business systems | Built, awaiting your review; everything ran against fakes (A2, A3.5, A6) |

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

### 3.10 Stage 8 (Tier-2 environments): what only you can do
1. **A KVM-capable Linux host** (bare metal or nested virtualization; the production judge node of F32 would do) so I can build and
   observe the Firecracker driver (F68). Without it every Tier-2 result stays gVisor.
2. **Decide build or buy** (ADR 0035): whether to buy a managed microVM sandbox for the first customer who needs credentials above
   level 1 or customer-delivered scores before our own driver exists. Check its price, regions, who can see code and traces, and its
   security record; I cannot know those.
3. **A sandbox reviewer or pentester** (F73), using `docs/security/red-team-tier2.md`.
4. **A customer who wants environments or evals**, to say which environment first; and a **model provider account** (F41) for real
   agent runs (F72).
5. Decide whether any customer may opt in to gVisor-grade scores being delivered to them (the code refuses otherwise).

### 3.11 Stage 9 (business systems and compliance): what only you can do
1. **A legal entity and a Stripe (or merchant-of-record) account** (D1, D2, F77), then I write and test the real adapter. Until then nothing is charged and plan prices are placeholders: **set real plan names, limits and prices** (they are rows in `plans`).
2. **A customer who needs SAML** (F78), and a real identity provider (Okta, Entra ID, Google Workspace) to test OIDC and SCIM against; so far both ran only against fakes.
3. **A cloud account with backups** (F1, F79) for a real recovery drill, and a decision on regions (ADR 0038) before anyone is promised residency.
4. **A SOC 2 auditor, and the policies the company adopts** (incident response, access review, vendor register): `docs/compliance/evidence-*.md` lists exactly what is not evidenced.
5. **Choose a security contact address and publish `security.txt`**; decide on a bug-bounty platform and budget (`docs/security/bug-bounty-policy.md`); have a lawyer read its safe-harbour sentence.
6. **Real unit costs** from a bill, to replace `docs/compliance/unit-costs.json`, so cost per verification means something.
7. **Decide the key-scopes design** (F83) if you want an SDK, and whether employers should self-serve the employer plan (it can be bought by card today).

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
| Firecracker, a network allowlist for environments, an unpacker inside a sandbox, a real agent or model, a cost model | Need a KVM host, time, a provider account and prices | F68 to F76 |
| Platform-administrator screens (nodes, orgs) | API only for now | F13 |
