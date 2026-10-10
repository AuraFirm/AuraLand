# Runbook: identity, sessions and access

For the people who operate AuraLand. Commands that change data are marked **(writes)**. Run them
against production only with a second person watching, and write down what you ran. Connect with the
operations role, never the application roles. `psql "$AURA_DATABASE_URL"` below stands for that.

## 1. Someone says their account was taken over
1. Confirm who is asking by a route the attacker does not control (not by replying to an email they
   could have initiated). Ask for a recent action only the owner would know.
2. End every session of that person: a platform administrator calls
   `POST /api/v1/admin/users/<usr_id>/revoke-sessions` (needs a fresh passkey check; the result is
   audited as `admin.sessions_revoked`). If no administrator is available, **(writes)**:
   ```sql
   update sessions set revoked_at = now(), revoked_reason = 'admin'
   where user_id = '<uuid>' and revoked_at is null;
   ```
3. Look at what happened: `select at, action, target, ip from audit_log where actor_user_id = '<uuid>'
   order by seq desc limit 100;`. Look for `auth.passkey_added`, `auth.identity_linked`,
   `org.member_role_changed`, `api_key.created`, `account.exported`.
4. Remove whatever the attacker added: passkeys they registered, provider identities, API keys
   (see section 4), organization roles they were given. The person can do the first two from their
   account page after signing in; you can also **(writes)** delete the rows.
5. If the person's mailbox was the way in, they must secure it first; until then suspend the account
   (section 3).
6. Record the incident (severity per docs/kit/08 section 13).

## 2. An API key leaked
1. Find the organization and key: keys show as `aura_<prefix>_…`. `select id, org_id, name, created_by,
   last_used_at from api_keys where prefix = '<12 characters>';`
2. Revoke it: an owner or admin of the organization uses the organization page (needs a passkey check),
   or **(writes)** `update api_keys set revoked_at = now() where prefix = '<prefix>' and revoked_at is null;`
   Revocation takes effect on the next request; there is no cache.
3. Check what it could do: Stage 1 keys can only read their organization (`org:read`).
4. Ask the owner to issue a replacement and update their systems.

## 3. Suspending and restoring an account
There is no screen for it yet. **(writes)**
```sql
update users set status = 'suspended' where id = '<uuid>';   -- every request of theirs now fails
update users set status = 'active'    where id = '<uuid>';   -- to restore
```
A suspended person's sessions stop working at once, they cannot sign in by any method, and their
provider logins answer "suspended". Also end their sessions (section 1, step 2) so nothing lingers.
**End every session for everyone** (a suspected key compromise, see section 5): **(writes)**
`update sessions set revoked_at = now(), revoked_reason = 'admin' where revoked_at is null;`

## 4. Removing someone from an organization in an emergency
The last owner can never be removed (a database rule). To take power from a compromised owner when
another owner exists: an owner uses the organization page. Without an available owner, **(writes)**
set the role directly: `update memberships set role = 'member' where org_id = '<uuid>' and user_id =
'<uuid>';` (the database refuses it if that would leave no owner).

## 5. Rotating `AURA_LOGIN_TOKEN_SECRET`
This key hashes sign-in links, codes, browser bindings, invitation links and OAuth state. Rotate it if
it may have leaked together with a database dump.
1. Generate a new value: `openssl rand -base64 32`.
2. Deploy with the new value. Effects: every sign-in, invitation and OAuth flow in progress stops
   working (they live 5 to 10 minutes, invitations 7 days; re-send invitations). Sessions and API keys
   are not affected: they use different hashes.
3. Optionally delete pending rows: `delete from login_challenges; delete from oauth_flows;`
   and revoke pending invitations (**writes**): `update org_invitations set revoked_at = now() where
   accepted_at is null and revoked_at is null;`

## 6. Platform administrators
There is no sign-up path. The person first signs in normally and adds a passkey (they need it for every
admin action). Then, with a second person watching **(writes)**:
```sql
update users set platform_role = 'admin' where email = '<their email>';
```
Record who approved it. To remove: set `platform_role = 'none'` and end their sessions. Review the list
quarterly: `select email from users where platform_role = 'admin';`.
Verifying an organization: the administrator calls `POST /api/v1/admin/orgs/<org_id>/verify`.

## 7. Verifying the audit log
`pnpm audit:verify` recomputes the hash chain and exits 1 if any row was changed or removed from the
middle. It prints the chain head (`<seq>:<hash>`). Store each printed head somewhere the database
cannot change (object storage with object lock, once it exists) and pass the latest to the next run:
`pnpm audit:verify --expect-head=<seq>:<hash>` also detects deletion of the newest rows. Until the
external anchor exists (cutlist F8), run it by hand weekly and keep the printed head in the ops notes.

## 8. Sign-in email is not arriving
Production uses the `disabled` mail driver until a provider adapter exists, so email sign-in answers
"could not send" (503). Passkeys, GitHub and Google keep working. In staging or development check
Mailpit (`AURA_MAIL_API_URL`), the mail service status page, and the API log lines
`sign-in email not sent`.

## 9. A provider (GitHub or Google) is down or misconfigured
People see "The provider could not be reached" or a refusal reason on `/auth/done`; nothing is half
created. To switch a provider off, unset both its `AURA_OAUTH_*` variables and restart; its buttons
disappear (`/auth/methods`). Callback URL to register with the provider:
`<AURA_PUBLIC_ORIGIN>/api/v1/auth/oauth/<provider>/callback`.

## 10. Handling a deletion request
`select email, deletion_requested_at from users where deletion_requested_at is not null;` The account
is marked and its sessions are ended; the person can cancel by signing in. The purge itself is not
automated yet (Stage 3 worker). Do it by hand only after the grace period you set, and never for an
account that is the last owner of an organization: the database refuses, so transfer ownership first.

## 11. Rolling back a release
Migrations are additive, so older code runs against a newer schema. Roll back by redeploying the
previous image. Do not run down-migrations; there are none by design. If a migration itself failed
half way, it ran in a transaction and left nothing behind; fix it forward.
