# Runbook: tasks, bundles and storage (Stage 2)

Commands assume the repository root, a populated `.env` (see `.env.example`) and, for SQL, a
superuser connection (`psql "$AURA_DATABASE_URL"`). Never run these against production without a
second person looking at the statement first.

## 1. Local storage
- Start: `docker compose -f infra/compose.yml up -d seaweedfs` (S3 API on `http://127.0.0.1:8333`).
- Create the development bucket once: `pnpm storage:init` (safe to repeat).
- The credentials in `infra/seaweedfs-s3.json` are fixed development values for this machine only.
  Never reuse them anywhere else.
- The storage tests and the end-to-end tests need this server running; they fail, not skip, without it.

## 2. A bundle upload is refused ("does not match")
Meaning: the bytes in storage did not have the size or SHA-256 the uploader declared, or parts were
missing. Nothing was recorded and the staging object was removed. The uploader starts a new upload from
the version page. If it keeps happening for one person, compare the file's SHA-256 on their machine
(`shasum -a 256 file`) with the hash in the `task_version.upload_started` audit entry; a mismatch means
the file changed between hashing and sending (an editor, a sync client).

## 3. Storage is down
Finalize answers 503 and rolls back; the person retries. Upload URLs keep working for 15 minutes and
the plan for 1 hour. Check `AURA_S3_ENDPOINT` and the server's health. Nothing needs repair afterwards:
a half-finished upload is simply an open staging upload.

## 4. List releases that skipped sandbox validation (waived)
```sql
select v.id, t.slug, v.seq, v.released_at, v.released_by, v.bundle_sha256
from task_versions v join tasks t on t.id = v.task_id
where v.waived and v.state in ('released', 'retired') order by v.released_at;
```
The reviewer's written reason is in the audit log (`task_version.released`, `detail.waiver_reason`).
Stage 3 re-validates this list (F26).

## 5. Retire a bad release quickly
A reviewer with a fresh passkey check uses "Retire this version" on the version page, or
`POST /api/v1/task-versions/{id}/retire`. A retired version stays readable and keeps its bundle; a new
version is made and released instead. There is no way to edit or delete a released version, by design.

## 6. A person cannot release because they made the version
By design: the creator can neither review nor release their own version. Ask another reviewer, owner or
admin of the organization.

## 7. Validate a bundle by hand
```
node -e 'import("./packages/bundle/src/validate.ts").then(({validateBundle})=>{const r=validateBundle(require("fs").readFileSync(process.argv[1]));console.log(JSON.stringify(r.ok?{ok:true,files:r.value.files.length,tarSha256:r.value.tarSha256}:r,null,2))})' path/to/bundle.tar.zst
```
Only on a machine where parsing an untrusted archive is acceptable (not the API host in production).
The answer is one of 20 codes (`packages/bundle/src/errors.ts`); the format is `docs/bundle-format.md`.

## 8. Fuzz the validator or replay a failure
`node packages/bundle/src/fuzz-cli.ts --seed=<n> --iterations=<count>`. A failure prints the seed and
iteration; the same pair replays the same input. The nightly workflow runs 200,000 inputs.

## 9. Rollback
Migrations 0012 to 0014 are additive (new tables, a widened role check, two column grants). Older code
ignores the new tables. To switch task authoring off without a deploy, remove the setter and reviewer
roles from members; reading released tasks keeps working. The storage driver is configuration
(`AURA_STORAGE_DRIVER`); the in-memory driver is refused outside `AURA_ENV=test`.
