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
| F9 | Cleanup job for expired sessions, challenges, flows, invitations and rate-limit windows | Needs the worker role (Stage 3); rows are small and unused ones are never read | engineering |
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
