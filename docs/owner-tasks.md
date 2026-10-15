# Owner tasks: what only you can do, with the steps

Last updated 2026-10-15 (after Stage 9 and the backlog work, PRs up to #147). The new **section A** below is the master list; the numbered sections after it keep the detailed steps. This is the one list to work from. The stage
reports (`docs/stages/stage-N-report.md`) hold the evidence behind each item; this file holds the
**steps**. Tick items in a pull request, or tell me and I will. Anything marked **BLOCKS** stops a
whole class of work until it is done.

## START HERE: the accounts to create, one step at a time

**If the rest of this file feels like too much, ignore it and work only through this list, top to bottom.** It covers only the free first release.
You need no programming knowledge for any of it. You are creating accounts and filling in forms; I do the technical work.

Three rules that keep you safe:
1. **Never paste a password, secret key or token into chat, an email or git.** When I need a value, I will say whether it is safe to share. Names,
   domain names and "ids" are safe. Anything labelled *secret*, *password*, *token* or *key* is not.
2. **Turn on two-step login (an authenticator app) on every account below, the moment you create it.** These accounts will hold the whole service.
3. **The screens of these websites change.** If a button is not where I say, look for the same words, or take a screenshot and ask me.

Expect about **2 to 3 hours** for steps 0 to 5, spread over a few days (some steps wait for a verification email or for the web to catch up).

| Step | Platform | What it is for | Cost |
|---|---|---|---|
| 0 | A password manager and an authenticator app | Keeps the other accounts safe | Free |
| 1 | A domain name (bought at a registrar) | The web address of the service | Yearly fee (check the price on the page before buying) |
| 2 | Cloudflare | Looks after the domain's address book (DNS) and protects the site from abuse | Free tier is enough to start |
| 3 | Amazon Web Services (AWS) | The computers, database, storage and email that run the service | Pay for what you use; you will set a spending cap alarm |
| 4 | GitHub (you already have it) and a Google Cloud project | "Sign in with GitHub / Google" buttons | Free |
| 5 | Email sending (inside AWS) | So the site can send sign-in emails | Very small usage fee |
| later | A lawyer and a security reviewer | Not websites: people. See section A3 and A4 | Paid |

---
### Step 0. A password manager and an authenticator app (15 minutes)
1. Install a password manager (for example Bitwarden; it has a free plan) on your computer and phone. Create a long master password and **write it on
   paper and keep the paper somewhere safe**. If you lose it, nobody can recover it.
2. Install an authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator or Aegis). This is what produces the 6-digit
   codes for "two-step login".
3. From now on: every new account gets a **unique, long, generated password** saved in the password manager, and **two-step login using the authenticator
   app**. When a site shows you "backup codes", save them in the password manager too.
4. Use one email address that you control for all of these accounts (a new address just for this project is ideal, for example a fresh Gmail or a mailbox
   on your own domain later). Nobody else should read it.

### Step 1. Buy the domain name (20 minutes)
This is the one choice you cannot undo later: **the domain is also the permanent address that credentials are issued from.** Pick a name you will keep for years.
1. Decide the name. Short, easy to say and spell, no hyphens or numbers if possible. Pick the ending (.com is the safest; others are fine).
2. Choose where to buy it. Two simple options: **Cloudflare Registrar** (you will have a Cloudflare account anyway, so buy it there after Step 2; it sells domains
   at cost) or a registrar such as Namecheap or Porkbun. If you buy elsewhere, you will point it to Cloudflare in Step 2.
3. Search for the name on the registrar's site. If it is free, add it to the cart. **Turn on "WHOIS privacy" / "domain privacy" if offered (it is usually free)** so your
   home address is not public. **Turn on auto-renew**, so you do not lose the domain by forgetting.
4. Pay, and save the receipt. Tell me the domain name (safe to share).

### Step 2. Cloudflare (30 minutes)
Cloudflare answers "which computer is this domain?" and shields the site from floods of fake visitors.
1. Go to cloudflare.com, click **Sign up**, use the project email and a generated password from the password manager. Confirm the email.
2. Turn on two-step login: top right profile menu, **My Profile**, **Authentication**, **Two-Factor Authentication**, follow the steps with your authenticator app. Save the backup codes.
3. Click **Add a domain** (sometimes "Add a site"), type your domain, choose the **Free** plan.
4. If you bought the domain at Cloudflare, it is done. If you bought it elsewhere, Cloudflare shows two "nameservers" (names like `xxx.ns.cloudflare.com`).
   Go to your registrar, find the domain's **Nameservers** setting, choose "custom", and replace the old ones with Cloudflare's two. This can take from minutes to a day;
   Cloudflare emails you when it is active.
5. Create a **Turnstile** site (this is the "are you a human" check on sign-up): left menu **Turnstile**, **Add widget**, name it "AuraLand sign-in", add your domain, choose
   "Managed". Cloudflare shows a **Site key** (safe to share) and a **Secret key** (**not** safe: save it in the password manager only).
6. Tell me: the domain is active on Cloudflare, and the Turnstile **site key**.

### Step 3. Amazon Web Services (AWS) (60 to 90 minutes)
AWS is where the service will actually run. It is also where mistakes cost money, so we start with safety.
1. Go to aws.amazon.com, click **Create an AWS Account**. Use the project email, a generated password, and an account name like "auraland".
2. Enter your details and a payment card (required even for small use) and your phone number for verification. Choose the **Basic support (free)** plan.
3. **Secure the "root user" at once.** Sign in as the root user, click your account name (top right), **Security credentials**, **Multi-factor authentication (MFA)**,
   **Assign MFA device**, choose Authenticator app, scan the QR code. Save the recovery information in the password manager.
   After this you will almost never use the root user again.
4. **Set a spending alarm so you can never be surprised.** In the search bar type **Budgets**, open **AWS Budgets**, **Create budget**, **Cost budget**, **Monthly**, enter an
   amount you are comfortable losing in a month (you choose), and add your email for alerts at 50 percent, 80 percent and 100 percent. Also, in **Billing preferences**, turn on
   "Receive billing alerts" and "Free tier usage alerts".
5. Create your own everyday login (so you do not use the root user): search **IAM Identity Center**, click **Enable**, create a user for yourself, give it **AdministratorAccess**,
   set up MFA for it too. Use this login from now on.
6. Choose a **region** (the top-right drop-down with place names). For an EU-focused service pick Frankfurt or Ireland; for the US, N. Virginia or Ohio. **Tell me which; do not change it later.**
7. Later, I will ask you to create two separate accounts inside AWS, one for testing ("staging") and one for the real service ("production"), so a mistake in testing cannot touch real users.
   The place for that is **AWS Organizations**, **Add an AWS account**, **Create an AWS account**; each needs its own email address (with Gmail, `yourname+aura-staging@gmail.com` works). Do not do this yet.
8. Tell me: the region, and that the budget alarm and MFA are on. **Do not send me any AWS keys.** When it is time to build, I will give you exact commands to copy and paste into a terminal
   (I explain each one), so the keys stay with you.

### Step 4. "Sign in with GitHub" and "Sign in with Google" (30 minutes, after Steps 1 to 3)
These let people log in without a new password. You create two small "apps"; each gives you a client id (safe) and a client secret (not safe).
**GitHub:**
1. Sign in to github.com. Top right profile picture, **Settings**, left menu bottom **Developer settings**, **OAuth Apps**, **New OAuth App**.
2. Application name: "AuraLand". Homepage URL: `https://` plus your domain. **Authorization callback URL:** `https://YOUR-DOMAIN/api/v1/auth/oauth/github/callback`
   (replace YOUR-DOMAIN with the real one, keep the rest exactly). Click **Register application**.
3. Copy the **Client ID** (safe to share). Click **Generate a new client secret** and save it **only** in the password manager (GitHub shows it once).

**Google:**
1. Go to console.cloud.google.com and sign in with the project email. Top bar project menu, **New project**, name it "AuraLand".
2. Left menu **APIs & Services**, **OAuth consent screen**. Choose **External**, fill in the app name "AuraLand", your support email, and the developer contact email. You can skip optional fields. Save.
3. **Credentials**, **Create credentials**, **OAuth client ID**, type **Web application**. Under **Authorized redirect URIs** add `https://YOUR-DOMAIN/api/v1/auth/oauth/google/callback`. Create.
4. Copy the **Client ID** (safe); save the **Client secret** in the password manager only. Google may later ask you to "publish" the app so anyone can sign in; I will tell you when.

Tell me both **Client IDs** (safe). The secrets go into AWS's secret store later, with my step-by-step help.

### Step 5. Email sending, so the site can send sign-in emails (30 minutes, after Step 3)
We use AWS's email service, SES, because it is already inside AWS.
1. In the AWS search bar type **SES** (Simple Email Service) and open it. Make sure the region (top right) is the one you chose in Step 3.
2. Left menu **Identities**, **Create identity**, choose **Domain**, type your domain, and leave "Easy DKIM" on. AWS shows several DNS records (they look like names and long values).
3. Open Cloudflare, your domain, **DNS**, **Records**, and **Add record** for each one AWS listed (type, name and value copied exactly; set the proxy to **DNS only** (grey cloud) for these).
   Within an hour or so, SES shows the identity as **Verified**.
4. New SES accounts can only send to addresses you have verified (a "sandbox"). In SES, **Account dashboard**, click **Request production access**, say honestly what it is for
   ("sign-in emails for a free coding-contest website; users request them themselves; we handle bounces"), and submit. Approval usually takes about a day. 
5. Tell me when the identity is Verified and the production request is submitted.

### What happens next
When Steps 0 to 5 are done, tell me. I then (a) build the staging environment on AWS with commands you run, (b) wire sign-in, email and Turnstile, and (c) ask you for the two things
that need people rather than websites: **a security reviewer for the judging computers** and **a lawyer for the privacy policy and terms** (section A3 and A4 below explain both).
You can start looking for those two people while the accounts are being created, since they take the longest.

---

## A. The initial release: free for everyone, for the first year

**Decision (2026-10-15): the first release is free for all kinds of users, to build a user base over about a year.** That removes a whole class of
work from the critical path (payments, tax, invoices, payouts, enterprise sign-in, paid-plan enforcement) and moves it to **section Z** at the end of
this file, with the event that brings each item back. It does not remove the safety work: the product still runs strangers' code and stores people's
data, so the judge review, legal basics and abuse control stay.

### A0. What the initial release contains (my proposal; tell me if you want it different)
| In the initial release | Deferred (section Z) |
|---|---|
| Sign-in (email, passkeys, GitHub and Google), profiles, organizations | Payments, plans that cost money, invoices, tax |
| Practice bank, contests, Arena, ratings, scoreboards | Exams and everything that needs legal review of exams |
| Task authoring, review and release for setters and reviewers (Forge, no selling) | Selling task packs to companies (orders, deliveries as a paid service), setter payouts |
| Tier-1 judging on a reviewed production node | Tier-2 environments and agent evals (gVisor review, Firecracker) |
| Customer webhooks (free, with the free-plan limits) | Enterprise SSO/SCIM, employer module, support-access tooling for customers, SOC 2 |
| Passport credentials **only after** the signer is real (Z1): launching with development credentials would claim more than is true | Data residency promises, SDK/API-key scopes |

The code for the deferred items is already built and tested; "deferred" means **not switched on, not promised, not paid for**. I will add a switch so
that the deferred routes are really off in the free release rather than merely unadvertised (see A9).

### A1. Decide and create (first week; the rest waits on these)
| # | Item | Why | You do | I do next |
|---|---|---|---|---|
| A1.1 | **Who runs the service** (legal entity, D1) | A free service still collects personal data and runs strangers' code; someone is the data controller and carries liability. A company (or a nonprofit) limits your personal exposure; running it as yourself is possible for a hobby launch but you carry that risk | Decide: form a company now (recommended, even a small one via an incorporation service), or launch as an individual and form one before the first institution or paying customer. Tell me the name and country | Put it into the privacy policy and terms; nothing else depends on it yet (Stripe is deferred) |
| A1.2 | **Domain name** (D8) | The site's host is also the credential issuer address (`did:web`) and **cannot change later without invalidating credentials**; cookies, CSP, OAuth callbacks and `security.txt` use it | Buy the domain you will keep for years. Decide the production and a separate staging host | Set `AURA_PUBLIC_ORIGIN` and the redirect addresses; staging and production hosts |
| A1.3 | **AWS account (recommended)** (F1, D3) | Hosting for web/API/worker, RDS PostgreSQL 18 with backups, S3 for files, SES for mail, Secrets Manager, CloudWatch; KMS later for Passport (Z1) | Create an AWS Organization with a **staging and a production account**, MFA on the root user (then do not use it), and **a budget alert at a monthly cap you choose** (a free service has no revenue to absorb a surprise bill). Tell me how you want to grant access: usually you run the infrastructure code and I write it | Write the infrastructure as code (ADR first), the staging deploy (F1), backups and one real restore drill (F79), alerts and dashboards (F39), a cost-conscious footprint (one small database, a small web/API/worker, one judge node to start) |
| A1.4 | **Region** (D3) | Where data lives. One region is fine for launch; do not promise residency (ADR 0038) | Choose the primary region (kit default: EU, Frankfurt or Ireland) | Deploy there; the privacy text says where data is |
| A1.5 | **Cloudflare (recommended, free tier is enough to start)** (F7, F33) | In front of AWS: DNS, TLS, DDoS and bot protection, rate limiting at the edge, and **Turnstile on sign-in and sign-up**, which matters more for a free service because anyone can sign up and use compute | Create the account, add the domain, create a Turnstile site key, and tell me Cloudflare is the edge (or choose CloudFront and Route 53 instead) | Set `AURA_TRUST_EDGE_REQUEST_ID`, write the edge rules, wire Turnstile (F7), re-check ASVS V4 and V12 (F33) |

### A2. Mail, sign-in and accounts (needs A1.2, A1.3)
| # | Item | You do | I do next |
|---|---|---|---|
| A2.1 | **Mail provider** (F12) | Choose SES (natural with AWS) or Postmark; verify the sending domain (SPF, DKIM, DMARC at your DNS); ask SES for production access (it starts in a sandbox) | Write the adapter; email sign-in and invitations go live |
| A2.2 | **OAuth apps** (F11) | Create a GitHub OAuth App and a Google Cloud OAuth client; callback `<origin>/api/v1/auth/oauth/<provider>/callback`; secrets into the secret store | Run the real-provider checks |
| A2.3 | **First platform administrator** | Follow `docs/runbooks/identity.md` section 6 with a second person watching | - |

### A3. Judging: the one thing that must be safe before the public arrives (**BLOCKS** the launch)
| # | Item | You do | I do next |
|---|---|---|---|
| A3.1 | **A production judge node** (F32) | Provision a dedicated Linux x86-64 VM (Ubuntu 24.04, cgroup v2) that runs nothing else; follow `judge/node/README.md`. Start with one; add more as load appears | Run the escape suite on it, harden the baseline, enroll it as `production` (never before the review) |
| A3.2 | **An external review of the sandbox configuration** (F32, F73) | Hire a sandbox reviewer or pentester; give them `docs/security/red-team-tier2.md`'s method, the Tier-1 escape suite and the threat model; budget for a retest. **This is the one unavoidable cost of the free launch** | Fix findings; keep the findings table |
| A3.3 | **Abuse limits you are comfortable with** | Decide the free allowances: submissions per person per hour/day, maximum concurrent runs, time/memory limits, and what happens on abuse (suspend, ban) | Set the rate limits and quotas; write the abuse runbook; make the free plan's limits generous but finite (A9) |

### A4. Legal basics (can start now, in parallel; needed before the public arrives)
| # | Item | You do |
|---|---|---|
| A4.1 | **Privacy policy and terms of service** | A lawyer or a reputable template reviewed by one; I supply the facts (what data, where, which vendors: AWS, Cloudflare, the mail provider, GitHub/Google sign-in) |
| A4.2 | **Content and conduct rules** | The service hosts user-written solutions and setter-written problems: rules on plagiarism, leaking problems, harassment, and a takedown address |
| A4.3 | **Security contact** | Choose an address, publish `/.well-known/security.txt` (template in `docs/security/`), and say how you will answer reports. A paid bounty is deferred (Z4), a way to be told is not |
| A4.4 | **Incident basics** | Who is reachable, who decides, and the 72-hour data-breach notification clock; I write the short runbook with you |
| A4.5 | **Children**: decide a minimum age in the terms | Free public services attract students; the rules differ by country |

### A5. People and the first year
| # | Item | You do |
|---|---|---|
| A5.1 | **Seed the practice bank** (F53) | Create a platform organization, add public tasks, release them (`docs/runbooks/contests.md`); a contest site with nothing to solve does not grow |
| A5.2 | **A first contest** | Pick a date and a partner (a university club, a community); 200+ people is the design point; I run `contest-start-spike` on the real deployment (F49) and we rehearse |
| A5.3 | **Who answers users** | Contest-day support (D11), a support address, a status page; decide office hours honestly |
| A5.4 | **Approve the stage reports** | Stages 3, 5 and 9 are marked built, awaiting your review |
| A5.5 | **Say "rating", not "Elo-MMR", in public** until it is calibrated on real contests (F50) | Wording only |

### A6. Routine once live
Weekly: `pnpm audit:verify`; keep the audit-chain head somewhere the database cannot reach (F8: needs S3 object lock). Within 72 hours of a high or
critical Next.js advisory: update. Monthly: look at the AWS bill against the budget alert, and at abuse reports. Quarterly: review platform administrators;
run the recovery drill (`node apps/api/src/dr-drill-cli.ts`) against a restored backup. After 2026-10-28: ask me for the ADR recording Node 26 as LTS (F2).

### A7. The shortest path to a free public launch
1. A1.2 domain, A1.3 AWS (with the budget alert), A1.5 Cloudflare, A1.1 decision on the entity.
2. I deploy staging (F1) and the edge (F33). 3. A2.1 mail, A2.2 OAuth, A2.3 first administrator: sign-in works for real.
4. A3.1 production judge node, A3.2 the review (the long pole: book the reviewer early). 5. A4.1 to A4.5 legal basics, in parallel with 3 and 4.
6. A5.1 seed the bank, A5.2 first contest. 7. Launch. Everything in section Z can wait for its trigger.

### A8. What the free launch costs you (so nothing surprises you)
Not prices (I cannot quote them reliably; check each provider's current page): a domain; AWS (small database, small web/API/worker, one judge VM, storage,
mail, backups, KMS later); Cloudflare free tier; the sandbox reviewer (one-off, the biggest item); a lawyer for A4.1; and your time for A5. The judge nodes
are the part that grows with users, which is why A3.3 (allowances) and the AWS budget alert exist.

### A9. What I will do for the free release (engineering; I start on your word)
1. **A launch configuration** that switches off the deferred features at the routes (billing and checkout, exams, environments, orders and deliveries,
   employer, SSO/SCIM, revenue share, support access), so "deferred" is enforced, not just unadvertised; plus hiding their screens.
2. **Free-plan limits made generous but finite** (members, webhook endpoints, runs) and the default plan for everyone; the billing screens show nothing to buy.
3. **Abuse controls**: per-person and per-address submission quotas, signup throttling with Turnstile, a suspend tool and runbook (A3.3).
4. **Cost controls**: a hard cap on concurrent judge work and queue length (the queue already sheds load), and a monthly usage report.
5. **Infrastructure as code, staging, edge, backups, alerts** (A1.3), and the launch runbook.

## 0. Where things stand
| Stage | State |
|---|---|
| 0 Foundations | Approved (2026-10-10). Open: the staging deploy (A1.3, A7) |
| 1 Identity, tenancy, audit | Approved (2026-10-10) |
| 2 Tasks and bundles | Approved (2026-10-11) |
| 3 Queue, submissions, judge | **Built, awaiting your review.** The production judge node and the external sandbox review are open (A3.1, A3.2) |
| 4A, 4B, 4C Forge v0, validation, watermarks | Approved (2026-10-14); calibration and agent attack runs wait for a model-provider account (Z1) |
| 5 Contests, Arena, ratings | Built, awaiting your review; **the heart of the free launch**; the load target and the first contest need a deployment (A1.3, A5.2) |
| 6 Exams and integrity | Approved (2026-10-15); **deferred for the free launch (Z2)**; no real exam before legal review |
| 7 Passport | Approved (2026-10-15); development signer only; **real signer is Z1, soon after launch** |
| 8 Tier-2 environments | Approved (2026-10-15); gVisor only, no Firecracker; **deferred for the free launch (Z2)** |
| 9 Business systems | Built, awaiting your review; ran against fakes; **deferred for the free launch (section Z)** |

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

## Z. Deferred: not needed for the free initial release

Everything here is built (or designed) and waits for a trigger. Do not start any of it for the launch. The "Trigger" column says when it comes back. The
code stays in the repository, tested, switched off by the launch configuration (A9).

### Z1. Soon after launch (first months; cheap, and they make the product more trustworthy)
| Item | Trigger | You do | I do |
|---|---|---|---|
| **Passport with a real signer** (F62, F63) | You want to issue credentials to contest participants (a growth feature that costs little) | Create an AWS KMS key (asymmetric P-256 sign/verify), tell me its ARN; decide Ed25519 vs ES256 with me; find someone to read the signing code (`platform/signer.ts`, `modules/passport/*`, migrations 0053 to 0060) | KMS adapter and tests, switch Passport on in staging then production, runbook for rotation and compromise |
| **External anchor for the audit chain** (F8) | Right after launch: it is cheap and protects the audit trail | S3 bucket with object lock | The nightly verifier and anchor job |
| **Editorial and community tools** (F13 administrator screens, F53 content) | When volunteers help run it | Choose helpers | Build the screens |
| **Model-provider account** (F41) for difficulty calibration of problems and agent attack runs on problems | When you want problem difficulty measured, not guessed | Account and a monthly cap | Calibration and attack runs |

### Z2. When you serve institutions or companies (second year, or the first paying/pilot customer)
| Item | Trigger | You do |
|---|---|---|
| **Exams** (Stage 6) | A university or employer wants a real exam | Legal review of the privacy assessment, consent text and DPA for each jurisdiction (kit 15 item 33); a pilot institution and course; two staff per exam host and who decides a confirmed case; an LLM provider and budget for oral defence (F41, F56); a human accessibility audit |
| **Tier-2 environments and agent evals** (Stage 8) | A customer wants agent evals | A KVM host (AWS bare metal or nested virtualization) so I can build Firecracker (F68); a sandbox reviewer for Tier-2 (F73); or buy a managed sandbox for the first customer (ADR 0035); a model provider (F72) |
| **Selling task packs** (orders, deliveries, watermarks as a service) | A company wants to buy | Pricing, contract terms, legal entity (A1.1) in place |
| **Employer module** (F67) | An employer wants to search credentials | Legal review per jurisdiction; Passport real signer (Z1) |
| **Identity-proof vendor** (F64) | A customer needs assurance above level 1 | Pick and open an account (Persona, Veriff, Stripe Identity) |
| **Exam series, outcome mapping** (F55, F59) | The pilot institution says what it wants | The institution's answers |

### Z3. When you start charging (the end of the free year, or the first paid customer)
| Item | You do | I do |
|---|---|---|
| **Stripe account or a merchant of record** (F77, D2) | Entity (A1.1) first; create the account, products and prices; secret key and webhook secret into the secret store | The real adapter behind `PaymentProvider`, test mode first, reconciliation on real data |
| **Plans, limits and prices** (the numbers in `plans` are my placeholders) | Decide names, limits, prices and currency; announce the end of the free period fairly (existing users: grandfather, or give notice) | Change the plans by migration, switch billing on |
| **Tax and invoicing** | Stripe Tax, a merchant of record, or manual invoices | Build what you choose |
| **Setter payouts** (revenue share) | A bank account and a payout process | Export formats for your bank |
| **Real cost per verification** | Real unit costs from the bills of the free year | Replace the placeholders in `docs/compliance/unit-costs.json` |

### Z4. When enterprises or auditors ask
| Item | You do |
|---|---|
| **Enterprise SSO and SCIM** (F78) | A real Okta/Entra/Google test tenant to test against; a customer who needs SAML |
| **SOC 2** | An auditor and adopted policies (incident response, access review, vendor management); re-run `node apps/api/src/soc2-evidence-cli.ts` |
| **Bug bounty** (`docs/security/bug-bounty-policy.md`) | A platform, a budget, and a lawyer's read of the safe-harbour sentence |
| **Data residency as a promise** (ADR 0038) | A second region and a decision per customer |
| **A real disaster-recovery programme** (F79) | Multi-AZ, point-in-time recovery, written recovery objectives, regular drills |
| **API-key scopes and an SDK** (F83) | Decide that machine access is a product; I write the design first |
| **SCIM groups, more webhook events, delivery search** (F81, F82) | A customer asking |
| **Microsoft/Apple sign-in, other providers** | When users ask |

### Z5. Notes kept from earlier lists
The detailed steps for these items are in sections 1 to 5 above (older text; where it conflicts with section A, section A wins): the first platform
administrator (3.5), database roles and TLS (3.2), object storage and lifecycle rules (3.3), the stage-specific lists 3.7 (contests: needed), 3.8 (exams: Z2),
3.9 (Passport: Z1), 3.10 (Tier-2: Z2) and 3.11 (business systems: Z3 and Z4).

