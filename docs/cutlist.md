# Cutlist: deferred work with reasons

Nothing here blocks Stage 1 or Stage 2. Ranked by how much it matters; "owner" is who decides.

| # | Item | Why deferred | Owner |
|---|---|---|---|
| F1 | Staging deploy of a hello endpoint (ADR 0008) | Needs an AWS account, region and domain (D1, D3, D8) | founder |
| F2 | ADR for Node 26 becoming LTS (2026-10-28) | The date has not arrived; development runs on Node 26, production images use Node 24 | engineering |
| F3 | Email the person after security changes (new passkey, provider linked or removed) and on unusual sign-ins (ASVS V6.3.5, V6.3.7) | Needs a production mail provider and a notification template set | engineering |
| F4 | ~~Offer sign-out of other devices in the flow after removing a passkey or provider; ask for a fresh check before ending sessions~~ | **Done 2026-10-10** (ASVS V7.4.3, V7.5.2 now met) | n/a |
| F5 | Store 8-digit codes with a password-hashing algorithm instead of a keyed hash (V6.5.2) | The keyed hash plus 5 attempts and 5 minutes is the stronger practical control for a code that is typed once; revisit if the standard is read strictly | security review |
| F6 | Adaptive controls on IP, device or time; contextual checks for admin routes (V8.2.4, V8.4.2) | Level 3 items; recorded signals exist (session network, user agent) but nothing consumes them | engineering |
| F7 | Turnstile hook (kit Stage 1 list) | Needs a Cloudflare account and a site key; rate limits cover the same abuse for now | founder |
| F8 | External anchor for the audit chain head and a nightly verifier job | Needs object storage with object lock and the worker (Stage 3) | engineering |
| F9 | ~~Cleanup job for expired sessions, challenges, flows, invitations and rate-limit windows~~ | **Done 2026-10-11** (Stage 3 slice 2: `maintenance.cleanup`) | n/a |
| F10 | Send invitation emails after the commit through the worker, with retry | Needs the worker (Stage 3); today a mail outage fails the invitation cleanly | engineering |
| F11 | Exercise OAuth against the real GitHub and Google | Needs OAuth apps created by the repository owner (plan section 12) | founder |
| F12 | Production mail provider adapter | Provider not chosen | founder |
| F13 | Platform-administrator screens (verify organizations, end sessions, suspend accounts) | API routes exist; a screen is not needed until there are many | engineering |
| F14 | ~~Return to where you were after signing in~~ | **Done 2026-10-10**: `?next=` is looked up in a list of three of our own pages (`/account`, `/orgs`, `/invitations/accept`) and our copy is used, kept in the tab's session storage across sign-in and the trip to GitHub or Google; invitation links opened while signed out come back and join. A link opened from an email in a new tab starts without it, so it lands on the account page | n/a |
| F15 | ASVS mapping for V1 to V5 and V9 to V17 | Mapped as the stages that introduce each surface land; V6, V7, V8 are the Stage 1 set | security review |
| F16 | Sliding-window rate limits | Fixed windows allow a burst of up to twice the limit across a boundary; acceptable at current limits | engineering |
| F17 | Real-provider compatibility tests for the browser sign-in buttons | Same as F11 | founder |
| F18 | Run the bundle validator on every finalized upload and record the canonical-tar hash (ASVS V5.2.2, V5.2.3, V5.2.5) | By design the API host never opens a bundle; the sandbox arrives in Stage 3 | engineering |
| F19 | Total storage quota per organization (V5.2.4) | Per-person upload and per-task counts bound it for now; needs billing/plan decisions | founder |
| F20 | Malware scan for bundles (V5.4.3) | Bundles are never executed outside the sandbox or served; decide with delivery in Stage 4 | security review |
| F21 | Refuse duplicate keys in `task.json` (V1.5.3) | `JSON.parse` keeps the last value; the schema check applies to what remains, so it is a consistency gap, not a bypass | engineering |
| F22 | Automated ReDoS scan of all regular expressions (V1.3.12) | The new expressions are linear and tested; a scanner needs choosing | security review |
| F23 | Bucket lifecycle rule to abort abandoned multipart uploads and expire `uploads/` | Part of the infrastructure that does not exist yet (F1); the local server needs nothing | engineering |
| F24 | Worker job to delete storage objects when an organization or task is removed, and to prune finished upload rows | Needs the Stage 3 worker | engineering |
| F25 | Raise the bundle cap from 64 MiB to the kit's 512 MiB | Needs the worker to hash off-request (plan section 10) | engineering |
| F26 | Re-validate every `waived` release in the sandbox and retire those that fail | Stage 3, when validation exists | engineering |
| F27 | Hide titles of `org`-visible tasks that have no release yet from plain members | Needs the tasks and versions policies not to refer to each other (ADR 0023); use `private` while drafting | engineering |
| F28 | Images in statements and a sandboxed content origin for assets | Needs the content origin; images are refused for now (ADR 0026) | engineering |
| F29 | Make the owner-role requirement for `SECURITY DEFINER` functions explicit at deploy time: they run as the table owner and read forced-RLS tables (`jobs`, `sessions`, challenges), so the migration/owner role needs `BYPASSRLS` (or superuser); a managed database may not give that | Development and CI use a superuser; the first deployment decides the role (F1) | engineering |
| F30 | **Partly built (4B).** `task.validate` exists: a reviewer requests it, a node runs the bundle's reference, wrong solutions, mutants and ten attackers, the control plane stores an immutable report and the score. **Still open:** re-validate `waived` releases automatically (F26); validate custom-checker and interactive tasks (the node refuses them); (the joined run exists, see F31) | A production node (F32) for reports that may be called plain "validated" | engineering |
| F31 | ~~Bundle opener, `aura-judge run`, and the joined end-to-end run~~ done on the development VM (`apps/api/src/validate-e2e-cli.ts`). **Still open:** running the agent as an installed service (`aura-judge.service`, `judge/node/` step 3) and the same run on a production-spec node | A production node (F32) | engineering |
| F32 | **Run the escape suite on the production-spec Linux judge node (x86, hardened baseline) and get the external review of the sandbox configuration before any public use** (kit gate). Done so far: the suite passed on 2026-10-12 on a development Ubuntu 24.04 aarch64 VM (isolate v2.1.1, cgroup v2), with positive controls (see `judge/node/README.md`) | Needs the production node and a reviewer; the VM run proves the driver works, not that the node is hardened | founder, security review |
| F33 | TLS and mTLS at the edge for `/judge/v1` and the whole API; re-check ASVS V12 and V4.2 | The edge does not exist (F1) | engineering |
| F34 | Server-sent events for verdicts instead of 2-second polling | Polling is correct and cheap at this scale | engineering |
| F35 | Custom checkers and interactive tasks in the sandbox | Agent refuses them (another node may take them) until the sandbox exists | engineering |
| F36 | Lease filtering by language and capacity; per-node scheduler for cores and memory | One job at a time per agent is enough to prove the loop | engineering |
| F37 | Re-run borderline CPU times up to three times and take the median (kit 4.3) | Needs real timings | engineering |
| F38 | Contest, exam and Arena submission contexts | Later stages | engineering |
| F39 | Alerts and dashboards: dead jobs, lease-expiry spikes, node canary failures, queue depth | No deployment, no metrics stack (F1) | engineering |
| F40 | Write the data classification with protection requirements per level, and the logging inventory (ASVS V14.1.x, V16.1.1); ship logs to a separate system (V16.4.3) | Documentation and deployment work; needs the deployment (F1) | security review |
| F41 | Stage 4B/4C remainder: **difficulty calibration with models** (needs a provider account), **agent attack runs and a human-attack work queue** (recording findings is built). Built: validation, mutation, attackers, `ungameability_score` v1, per-delivery watermarks and the leak trace (4C). **Still open for watermarks:** input perturbation (deliberately never), recovery or alerting for a delivery whose watermark jobs died (F39), and a trace over archives in a sandbox | Provider account; reviewed production node (F32) | engineering |
| F42 | A delivery whose ordered version was retired before the manifest was built never finishes (the build refuses a missing version and the job dies after its attempts); an alert and an administrator action to rebuild or amend are missing | Rare; the failure is loud (dead job) but has no screen (F39) | engineering |
| F43 | Pages for platform administrators (orders, deliveries, payouts, assignments across tasks); today these are API-only | The first customers are served by staff with the API; a screen is not needed to prove the flow | engineering |
| F44 | A payment provider adapter behind `BillingPort` (invoices, webhooks) and tax handling | Needs the legal entity (D1) and a provider account | founder |
| F45 | Remove a person's assignments and comment rights when they leave the organization or change role (today a former setter's assignment row remains but their organization role no longer matches the policy, so access ends; the row is stale) | Harmless for access, untidy for audit | engineering |
| F46 | Download links for delivered bundles are not bound to the requesting address and live five minutes; consider binding and a per-delivery download count limit | Needs customer feedback on real use | engineering |
| F47 | Organizer and administrator screens for what is API-only today: answer clarifications, rejudge, unfreeze, set the platform banner, curate the practice bank | The pilot can be run by staff with the API and `docs/runbooks/contests.md` | engineering |
| F48 | Check the scoreboard stream ("Live") through the real edge and the Next proxy; today the page falls back to a 15-second poll and a browser test covers only that | No edge (F1, F33) | engineering |
| F49 | Run `contest-start-spike` on a real deployment with several API instances and the edge cache; kit target is 5,000 people in 10 s then 100 submissions/s for 10 min. Measured here: 2,000 in 10 s is comfortable on one process, 5,000 is not | Needs a deployment | founder + engineering |
| F50 | Calibrate the rating (`RATING_PARAMETERS_V1`, tiers) on real contests; it is Elo-MMR style but our own, with no independent vectors; consider the faster algorithm above 20,000 participants | Needs real contest data | engineering |
| F51 | Calibrate the Java allowances (1 s CPU/wall, 64 MiB reserve) and C/Java timings against real tasks; run the golden-task timing calibration on a production node | Needs real tasks and a production node (F32) | engineering |
| F52 | A second approver for finalizing a rated contest (ASVS V2.3.5), and a way to extend or cancel a published contest | Pilot scale; one trusted organizer | engineering |
| F53 | Put content in the platform practice bank: a platform organization with public released tasks, listed by an administrator; the daily challenge is empty until then | Content, not code | founder |
| F54 | Team contests, other formats (centaur, agent ladder), identity proof and AI-policy enforcement (assurance levels above 0) | Stages 6 to 8 | engineering |
