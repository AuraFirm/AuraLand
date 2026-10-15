# 0003 — Table ownership
Status: accepted
Date: 2026-10-10

## Context
docs/kit/04: a module's tables are written only by that module, and other modules reach its data
through its `service.ts`.

## Decision
This file is the ownership map. Add a row in the same pull request that creates a table.

| Table | Owner | Notes |
|---|---|---|
| `schema_migrations` | `packages/db` (`migrate.ts`) | Migration ledger with SHA-256 checksums; written only by the migration runner |
| `users` | `modules/identity` | Person accounts; created and updated by the identity role, self-readable by `aura_app` |
| `profiles` | `modules/identity` | Handle, display name, visibility; owner-editable |
| `sessions` | `modules/identity` | Login sessions (token hashes only); created by the identity role, listable and revocable by their owner |
| `login_challenges` | `modules/identity` | Email sign-in challenges (HMAC hashes only); identity role only, invisible to `aura_app` |
| `passkeys` | `modules/identity` | WebAuthn public keys; owner may list, rename and delete (never read the key or counter); identity role verifies and records use |
| `webauthn_challenges` | `modules/identity` | One-time passkey challenges (5 minutes); identity role only |
| `oauth_identities` | `modules/identity` | Links a person to a GitHub or Google identity (provider id, not email); owner may list and unlink, identity role creates |
| `oauth_flows` | `modules/identity` | One-time records of OAuth sign-ins in flight (HMAC hashes only); identity role only |
| `orgs` | `modules/identity` | Organizations (personal space per person, plus teams); members read, owners and admins rename; created only through `create_org` |
| `memberships` | `modules/identity` | Who belongs to which organization, with a role; members read, owners change roles, removal per role; always keeps one owner |
| `api_keys` | `modules/identity` | Organization API keys (SHA-256 of a random secret, never readable by `aura_app`); owners and admins manage; the identity role authenticates with them |
| `org_invitations` | `modules/identity` | Pending invitations to join an organization (HMAC of the link secret, never readable by `aura_app`); owners and admins manage; the identity role accepts them |
| `tasks` | `modules/tasks` | Named problems owned by one organization; content roles read all, members read `org` tasks; owners, admins and setters create and rename |
| `task_versions` | `modules/tasks` | Versions of a task with spec, statement and bundle size/hash; frozen once released; unreleased versions hidden from plain members; every state move guarded by a trigger |
| `task_reviews` | `modules/tasks` | Review decisions (append-only); reviewers insert, never about their own version |
| `bundle_uploads` | `modules/tasks` | Bundle uploads in flight (storage upload id, declared size and hash); the starter and their organization's setters |
| `jobs` | `modules/jobs` | The one job queue (leases, fencing epochs, retries); only the `aura_worker` role can read or write it |
| `submissions` | `modules/submissions` | Source code sent to released task versions and its verdict; owner and organization owners/admins read; created by participants, verdicts written only by the worker role |
| `verdict_details` | `modules/submissions` | Per-test results of a submission; readable wherever the submission is; written only by the worker role |
| `judge_nodes` | `modules/judge` | Machines that run untrusted code: name, Ed25519 public key, state; reached only through the worker role; revoking is a platform administrator's function |
| `orders` | `modules/orders` | A customer organization's purchase of released task versions with licence terms; platform administrators and the customer's owners, admins and buyers read; written only by platform-administrator functions |
| `order_items` | `modules/orders` | The released task versions in an order; fixed once the order is placed |
| `deliveries` | `modules/orders` | What was delivered for an order: a manifest with its hash, a watermark id and an expiry; never changes after creation except revocation |
| `delivery_access` | `modules/orders` | Log of every download link issued for a delivery (who, when, address); append-only |
| `contractor_payouts` | `modules/payouts` | Agreed amount and payment record for the author of a released task version; the contractor and platform administrators read; written only by platform-administrator functions; never deleted |
| `task_assignments` | `modules/tasks` | Which setters and reviewers work on which task; owners and admins assign (through a function) and read, the assigned person reads their own |
| `version_comments` | `modules/tasks` | Discussion on a task version among the people who work on the task and its organization's owners and admins; append-only |
| `validation_reports` | `modules/tasks` | Immutable result of one validation attempt of a task version: checks, observations, the attesting node's kind; written only by `settle_validation` |
| `attack_findings` | `modules/tasks` | Human attacks on a task version: held or gamed, and the method as plain text; written by people other than the author; append-only |
| `delivery_bundles` | `modules/orders` | What was actually delivered for each ordered version (the original, or a copy with a watermark tag written in), with the tag, the original's hash and which node made it; append-only; written only by `record_delivery_bundle` |
| `contests` | `modules/contests` | A contest hosted by an organization: format, rules, window, visibility, state; the clock and the host's owners and admins move it |
| `contest_problems` | `modules/contests` | The released versions a contest uses, labelled; fixed once the contest is published |
| `registrations` | `modules/contests` | Who registered for a contest; written only by `register_for_contest` |
| `contest_scoreboards` | `modules/contests` | The rendered board of a contest, one row per view (public, final); written only by the worker through `store_contest_scoreboard` |
| `contest_clarifications` | `modules/contests` | Questions to a contest's organizers and their answers; written only by `ask_clarification` and `answer_clarification` |
| `ratings` | `modules/contests` | A person's current rating per dimension; written only by the worker through `rating_apply` |
| `rating_events` | `modules/contests` | One row per person per rated contest: the rating history; never changes |
| `contest_ratings` | `modules/contests` | Marks a contest as rated or skipped; makes the rating job idempotent |
| `practice_bank` | `modules/submissions` | Released versions of public platform tasks that anyone signed in may practice on; listed by platform administrators through `practice_list_version` |
| `platform_status` | `modules/identity` | The one-row platform status banner; set by platform administrators through `set_platform_status` |
| `exams` | `modules/exams` | A lab exam hosted by an organization: mode, duration, window, state; the clock and the host's owners and admins move it |
| `exam_problems` | `modules/exams` | The released versions an exam uses, with points and rubric; fixed once the exam is published |
| `exam_roster` | `modules/exams` | Who may sit an exam (email, name, extra minutes); replaced as a whole before it opens |
| `exam_sessions` | `modules/exams` | One person's sitting: consent, start, deadline, state; written only by the exam functions |
| `exam_drafts` | `modules/exams` | A candidate's saved snapshots per problem with a sequence number; append-only; written only by `save_exam_draft` |
| `exam_answers` | `modules/exams` | Links a sitting's problem to the judged submission of its final draft; written only by `queue_exam_answers` |
| `exam_grades` | `modules/exams` | A person's rubric scores and comment for one answer; changed only by `grade_exam_answer` while the exam is closed |
| `integrity_flags` | `modules/exams` | Evidence a rule saw (staff only), a plain explanation, the rule version and a person's decision; raised and decided only by SECURITY DEFINER functions, never deleted |
| `integrity_appeals` | `modules/exams` | A candidate's appeal of a confirmed flag, reviewed by staff other than the decider; created and reviewed only by functions, never deleted |
| `oral_defences` | `modules/exams` | Questions a model proposed about one answer, the candidate's written answers and a person's score; the score is set only by `score_oral_defence` (staff); never deleted |
| `signing_keys` | `modules/passport` | Public keys and the lifecycle of credential signing keys (active, retired, revoked); the private key is never stored here; written only by `register_signing_key` (worker) and the administrator functions `rotate_signing_key` and `revoke_signing_key` |
| `credentials` | `modules/passport` | A signed credential and its holder's controls; one per (person, kind, event); recorded only by `insert_credential` (worker), never deleted, what was signed never changes |
| `passport_artifacts` | `modules/passport` | Digests of the static documents the worker published (keys, revocation lists), so unchanged ones are not rewritten; written only by `record_passport_artifact` |
| `credential_shares` | `modules/passport` | A holder's share links for a credential (hash of the secret, expiry, revocation); created and ended only by the holder's functions, never deleted |
| `passport_events_done` | `modules/passport` | Which finished contests and exams have been turned into credentials, and how many were issued; written only by `mark_passport_event_done` (worker) |
| `employer_orgs` | `modules/passport` | Company organizations a platform administrator approved to search public credentials; written only by `approve_employer_org` and `revoke_employer_org` |
| `credential_views` | `modules/passport` | One row per employer report opened on a public credential (which organization, which person, why, when); written only by `employer_report`, never changed or deleted; readable by the holder (without the person) and by the looking organization |
| `environments` | `modules/environments` | An organization's Tier-2 environment recipe (spec v2, image and hidden-material keys); written only by `create_environment` |
| `env_runs` | `modules/environments` | One agent evaluated in an environment: what was asked, the node's signed trace, the isolation that contained it and whether the result is eligible for the use it was requested for (a generated column); asked by `request_env_run`, finished once by `finish_env_run`, never changed after |
| `plans` | `modules/billing` | The catalogue of plans: limits and switches (members, environment runs, verifications, webhook endpoints, SSO, SCIM, employer search) and a placeholder price; changed by migration only |
| `customers` | `modules/billing` | Which plan an organization is on, with billing and contract references (owners and administrators read it); set only by `set_org_plan`, a platform administrator's function |
| `usage_events` | `modules/billing` | Billable facts (a finished environment run, an opened employer report), written only by triggers on the tables that record those facts, unique per (organization, kind, source), never changed; read by owners and administrators, counted for members through `org_usage` |
| `billing_events` | `modules/billing` | Events from the payment provider, one row per provider event id (the idempotency), with what was done about it; written only by `apply_provider_event` for the worker role; never changed |
| `ledger_txns` | `modules/billing` | Double-entry money transactions, one per business fact (kind, ref), posted by `post_ledger_txn`; never changed; worker role only |
| `ledger_entries` | `modules/billing` | The debit and credit lines of a ledger transaction; amounts are positive whole minor units; debits equal credits per currency when the transaction commits (a deferred constraint trigger); never changed |
| `reconciliations` | `modules/billing` | One row per month: our usage counts, the payment provider's, and the differences between them; recorded once, never changed; worker role only |
| `webhook_endpoints` | `modules/webhooks` | A customer's webhook address, wanted events and signing secrets; read by the organization's owners and administrators without the secrets (column privileges), created, rotated and switched off only by definer functions; the plan limits how many |
| `webhook_deliveries` | `modules/webhooks` | One queued event for one endpoint, its attempts and outcome; queued once per (endpoint, event, source) by triggers, claimed and recorded by the worker, given up on after 24 hours |
| `sso_connections` | `modules/sso` | An organization's OpenID Connect connection (issuer, client id and secret, discovered endpoints); owners and administrators read it without the secret (column privileges); saved and deleted by definer functions; only on plans that include SSO |
| `sso_domains` | `modules/sso` | Email domains an organization claimed for single sign-on, with the token to publish in DNS and when it was verified; a domain can be verified by one organization only (unique partial index) |
| `sso_identities` | `modules/identity` | Which person an organization's identity provider subject is (unique per organization and per person); written only by the sign-in role |
| `sso_flows` | `modules/identity` | One single sign-on attempt in flight: hashed state and verifier, the nonce, used once within ten minutes |
| `scim_tokens` | `modules/sso` | An organization's SCIM bearer tokens (SHA-256 only, unreadable to the application role), made and revoked by owners and administrators on a plan with provisioning |
| `scim_users` | `modules/sso` | The people an organization's identity provider provisioned, whether they are switched on, and the provider's own id; a switched-off person cannot return through single sign-on |
| `setter_terms` | `modules/revenue` | A setter's share (basis points) of a task's revenue, set by platform administrators; shares on one task add up to at most 100% |
| `order_revenue` | `modules/revenue` | Revenue booked for one order item, once, with the ledger transaction that split it; never changed |
| `payout_batches` | `modules/revenue` | A run of payments to setters: created (reserves amounts), paid (posts the ledger transaction) or cancelled |
| `payout_batch_lines` | `modules/revenue` | How much of a batch goes to which setter |
| `support_grants` | `modules/support` | A person's consent to let support staff see an account summary for up to 24 hours; theirs to make and end |
| `support_views` | `modules/support` | Each time staff looked, written in the same statement that returned the data; the person sees it; never changed |
| `telemetry_events` | `modules/exams` | Consent-gated events of a sitting (closed kinds, counts only), range-partitioned by month; written only by `ingest_telemetry`, deleted only by the retention job |
| `node_enrollments` | `modules/judge` | Single-use enrollment tokens (SHA-256 only) created by platform administrators |
| `node_nonces` | `modules/judge` | Nonces of signed node requests, kept 10 minutes to refuse replays |
| `rate_limit_counters` | `platform` (`rate-limit.ts`) | Fixed-window counters for the strict rate-limit class; identity role only |
| `audit_log` | `packages/db` (`audit.ts`), written through `appendAudit` by any module | Append-only hash chain; readable by org members and by the actor |

The RLS matrix test (`packages/db/src/rls-matrix.test.ts`) fails when a table is missing from this list or lacks row-level security.

## Consequences
CI will gain a check that every table in the schema appears here (Stage 1, with the first tables).

## Revisit trigger
Module split into services.
