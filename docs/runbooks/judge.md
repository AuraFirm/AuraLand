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
