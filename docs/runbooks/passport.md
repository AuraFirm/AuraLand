# Passport runbook (credentials, keys, employers)

For the person operating Passport. **Everything here was exercised on a development machine with an in-memory development signer.
No production signer exists (no KMS, F62), so Passport issues and publishes nothing in staging or production, and no
credential signed here may be called a production credential.** Read `docs/adr/0033-stage-7-decisions.md` first.

## 1. What runs
The worker's passport tick (every 10 s): (1) in development and test, registers its in-memory key (retiring the previous one);
(2) signs the credentials of keys that were revoked again with the active key; (3) turns the next finished event (a rated,
finalized contest; a released exam) into credentials; (4) publishes `did.json`, the key set, one signed revocation list per
list in use, one file per public credential and one file per live share link, writing only what changed.
Public endpoints (no database): `/api/public/credentials/<id>[?s=<link secret>]`, `/api/public/status-lists/<n>`,
`/api/public/jwks.json`, `/api/public/did.json`; `/.well-known/did.json` is a rewrite to the last. Page: `/verify/<id>`.

## 2. Watching it
```sql
select kid, status, environment, not_before from signing_keys order by not_before;          -- exactly one 'active' per environment
select kind, count(*) from passport_events_done group by 1;                                   -- events turned into credentials
select count(*) from credentials where revoked_at is null and kid in (select kid from signing_keys where status = 'revoked');  -- should be 0 shortly after a key revocation
select name, published_at from passport_artifacts order by published_at desc limit 10;        -- what was last written
```
If `/api/public/credentials/<id>` says `status_known: false`, the revocation list file is missing or fails its signature: check
the worker log for "passport tick error" and that the active key is the one that signed the list.

## 3. Routine key rotation (yearly, or by choice)
1. A platform administrator, with a fresh passkey check, registers the new public key with `rotate_signing_key` (the signer for
   it must already exist; with a KMS this is a new key version). The old key becomes `retired`: it still verifies what it signed.
2. The next tick publishes the new key set; check `/api/public/jwks.json` lists both keys.
3. New credentials are signed with the new key. Nothing needs re-issuing.
Rehearsal: `apps/api/src/modules/passport/rotation.database.test.ts` runs steps 1 and 2 and checks every credential verifies.

## 4. A key may be compromised (incident)
Severity: SEV1 (kit 08). Page immediately.
1. **Revoke the key**: `revoke_signing_key(<kid>, <reason>)` as a platform administrator. The key leaves the published key set at
   the next tick, so everything it signed shows as invalid. If it was the active key, there is no active key: register a new one
   first or immediately after (`rotate_signing_key` works from any state).
2. **Re-sign**: the tick signs every non-revoked credential of the revoked key again with the active key (same id, claims and
   place in the revocation list, new signature). Check the query in section 2 reaches 0.
3. **Check** a sample on `/verify/<id>` and with an independent verifier.
4. **Publish an incident note** (what, when, which credentials were affected, that they were re-signed). Tell affected hosts.
5. **Review** how the key leaked. A credential signed by the leaked key between its leak and its revocation may have been forged:
   decide with the host whether to revoke credentials issued in that window.
Rehearsal: `rotation.database.test.ts` steps 2 and 3.

## 5. Revoking one credential
The issuer's owner or admin (or a platform administrator) calls `revoke_credential(<id>, <reason>)`. The next tick rebuilds the
list; the page shows "revoked" within a minute (cache). The credential is never deleted; a revocation is not undone.

## 6. Holders and links
Credentials start **private**. A holder chooses private, link or public on `/passport`. Links last 1 to 30 days (default 7), five
live per credential, secret shown once; revoking a link or making the credential private ends it at the next tick, and a link file
carries its own expiry so it stops on time regardless.

## 7. Employers (v0; do not enable for real employers before legal review)
A platform administrator approves a company organization (`PUT /admin/employers/<org>` with a fresh passkey check; `DELETE`
revokes). Members, with a fresh passkey check, list public credentials (they name no one) and open reports for a stated
purpose; each report is recorded and shown to the holder as the organization's name, purpose and time. There is no replay or
evidence in a report.

## 8. Not done (so nobody assumes it)
A production signer (KMS) and everything that depends on it (F62); identity verification and assurance above the event's own
(no event requires it yet); QR codes and share cards; serving the static files from an edge or CDN (F1, F33; the "works with
the database down" claim is tested at the API against the files); `Idempotency-Key` on link creation; Data Integrity proofs and
wallets (out of scope); a human review of the signing code.
