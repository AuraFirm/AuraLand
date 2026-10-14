# Runbook: the job queue, the worker and judge nodes (Stage 3)

Commands assume the repository root and a populated `.env`. SQL needs a superuser connection
(`psql "$AURA_DATABASE_URL"`). **No judge node exists yet that can run code** (README of the stage:
`docs/stages/stage-3-report.md`); sections 3 to 6 describe how it will be operated.

## 1. The worker
- Start: `AURA_ROLE=worker node apps/api/dist/main.js` (same image and environment as the API).
- It runs two recurring jobs: `maintenance.cleanup` (expired rows, bounded per pass) and
  `maintenance.abort_uploads` (abandons expired bundle uploads in storage). It logs `worker started`.
- Stopping on SIGTERM finishes the current job. A crash is safe: its lease expires and the job returns
  to the queue (after the backoff).
- The database role the worker connects through must be a member of `aura_worker`. The functions it
  calls run as the table owner, which must be able to bypass row-level security (cutlist F29).

## 2. Looking at the queue
```sql
select queue, state, count(*) from jobs group by 1, 2 order by 1, 2;
select kind, state, attempt, max_attempts, last_error, updated_at from jobs where state = 'dead' order by updated_at desc limit 20;
select id, kind, lease_owner, lease_epoch, lease_expires_at from jobs where state = 'leased' order by lease_expires_at;
```
A growing `ready` count for `judge` with no leased jobs means no active node. Dead jobs keep their last
error; the matching submission is `failed_system` and the participant is told it is not their fault.

## 3. Enrolling a judge node (platform administrator)
1. Sign in as a platform administrator and confirm with your passkey (fresh check).
2. `POST /api/v1/admin/judge-nodes/enrollments` → `{ token, expires_at }`. The token is shown once and
   works once, within an hour. Only its SHA-256 is stored.
3. On the node: `aura-judge enroll --control-plane https://<host>/api/judge/v1 --token <token> --name <node-name> --key-file /etc/aura/node.key`.
   The key file is created exclusively (mode 0600) and never overwritten.
4. The node becomes `active` after its first heartbeat with a passing self-test; a failing self-test
   drains it.

## 4. Revoking a node
`POST /api/v1/admin/judge-nodes/{id}/revoke` (platform administrator, fresh passkey check). The node's
next request gets 401; its leased jobs expire and are retried elsewhere. Revoked nodes cannot return;
enroll a new one. Do this first when a node is suspected compromised, then rotate nothing else: the node
held no credentials but its own key.

## 5. A node's results look wrong
Rejected results show as `invalid result: ...` in `jobs.last_error` and the job goes to another node.
Many of these from one node means it is faulty or hostile: revoke it. Compare:
```sql
select (payload->>'submission_id') as submission, last_error, attempt from jobs where last_error like 'invalid result:%' order by updated_at desc limit 20;
```

## 6. Before a node may take real work
1. Run the escape suite on the node: `AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/isolate -run TestEscape` (from `judge/`).
2. Every program must be contained; any "ESCAPED" line means the node does not go live.
3. The sandbox configuration needs the external review (cutlist F32) before public use.

## 7. Replaying signatures and fixtures
`node apps/api/src/judge-fixtures-cli.ts` rewrites `judge/fixtures/signature.json`; the Go and
TypeScript tests must both pass afterwards.

## 8. Rollback
Migrations 0015 to 0019 are additive (new tables and functions, a widened role set, column grants).
Switching judging off without a deploy: revoke or drain every node; submissions then queue (and the
queue sheds at 1,000 ready jobs with a 503). The worker is a separate process: stopping it only pauses
housekeeping.

## 7. Task validation (Stage 4B)
- **Enrolling a node with an attestation.** `POST /api/v1/admin/judge-nodes/enrollments` takes an optional
  body `{"attestation": "development" | "production"}`; no body means `development`. The node keeps it
  for life. Use `production` only for a node whose sandbox has been independently reviewed (F32).
- **Node prerequisites for validation.** Pinned Node under `/opt/aura/node`, the built opener
  (`pnpm build:opener`, installed next to the agent and passed as `--opener-file`), `g++` and `python3`.
  Run `go test -tags isolate ./internal/bundles ./internal/validate` on the node after the escape suite.
- **Asking for validation.** A reviewer, admin or owner presses "Request validation" on a version in
  review (`POST /api/v1/task-versions/:id/validate`). The version becomes `validating` and a
  `task.validate` job is queued on the `validate` queue (at most 100 ready).
- **Looking at it.** `select kind, state, attempt, last_error from jobs where queue = 'validate' order by created_at desc limit 20;`
  and `select task_version_id, attestation, passed, score, created_at from validation_reports order by created_at desc limit 20;`
- **A version stuck in `validating`.** If its job died (no node, attempts used), housekeeping returns it
  to `uploaded` within a pass (`validations_aborted` in the cleanup log). No report is written then.
- **A report that did not pass** lists the failing checks; the setter fixes the bundle and uploads a new
  version. Reports are never edited or deleted.
- **The joined check.** On a development machine with Colima running, `pnpm build && pnpm build:opener`
  then `node apps/api/src/validate-e2e-cli.ts` starts the built API against a throwaway database and
  local S3, builds and enrolls the agent in the VM, requests a validation and prints the stored report. It
  exits 0 only when the report is a `development` report whose failed checks are exactly the two the
  test bundle is built to have. It needs the VM; it is not run in CI.

## 8. Delivery watermarks (Stage 4C)
- **A node that takes watermark jobs** is started with `--rewriter-file .../packages/bundle/dist/rewrite-bundle.cjs`
  as well as `--opener-file`; without it the node never leases the `watermark` queue. Both programs are built
  by `pnpm build:opener`.
- **What happens at placement.** `place_order` queues one `delivery.watermark` job per ordered version; the
  manifest build is queued automatically when the last version has its delivered bundle. Looking at it:
  `select kind, state, attempt, last_error from jobs where queue = 'watermark' order by created_at desc limit 20;`
  and `select delivery_id, task_version_id, answers_marked, solutions_marked, verdicts_checked, attestation from delivery_bundles order by created_at desc limit 20;`
- **A delivery stuck pending** with its watermark jobs dead (no node, or a node that keeps failing, or a bundle
  the validator now refuses) is visible as dead jobs in the queue; nothing recovers it automatically (F39). Fix
  the cause, then re-place the order or ask engineering to re-queue the jobs.
- **Tracing a leak.** Unpack nothing yourself: a leaked archive is untrusted input, so open it in a box first.
  With loose leaked files (`*.ans`, `*.cpp`, `*.py`) in a directory, export the delivery records and run
  `node packages/bundle/src/trace-leak-cli.ts --leaked <dir-or-file> --candidates candidates.json`
  (the file's header comment has the `psql` export). `STRONG` means an exact solution tag or 24 or more
  agreeing answer bits; `POSSIBLE` means 8 to 23 agreeing bits and is a lead, not a finding. Then look at the
  customer's download log for that delivery (`delivery_access`) and decide with the owner. The trace never
  decides anything.
- **The acceptance check.** `node apps/api/src/pack-e2e-cli.ts` (needs the VM, like the joined check above)
  places a 20-version pack and a 3-version pack, runs the real agent, downloads over HTTP as the buyers, runs
  the customer verification script and checks the log, the tags and that the two customers' copies differ.
