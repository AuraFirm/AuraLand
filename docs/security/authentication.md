# Authentication, sessions and authorization: what is enforced

The reference for ASVS V6.1, V7.1 and V8.1 (documentation requirements) and for reviewers. Every
number below is a named constant in `apps/api/src/modules/identity/limits.ts` and is covered by a
test; the test named in the right-hand column fails if the number or behaviour changes.

## 1. Ways in (V6.1.3, V6.3.4)
| Way | Strength | Who can use it | Controls |
|---|---|---|---|
| Passkey (WebAuthn) | Phishing-resistant, user-verified (possession plus biometric or PIN) | Anyone with a registered passkey | Attestation `none`, user verification required, single-use 5-minute challenges, counter never decreases (ADR 0015) |
| Email link | Possession of the mailbox, plus the requesting browser | Anyone | Link 10 minutes, single use, bound to the browser that asked by an HttpOnly cookie, keyed-hash storage (ADR 0014) |
| Email code (8 digits) | Same, typed | Anyone | 5 minutes, 5 wrong guesses lock the challenge, bound to the browser, keyed-hash storage |
| GitHub, Google | Whatever the provider enforces; a provider-verified email is required | Anyone | State plus PKCE, fixed redirect, identity by provider id; never links to an existing email silently (ADR 0016) |

There is no password and no SMS. No other pathway exists; the authorization matrix test fails on any
route that is not declared, so an undocumented way in cannot ship unnoticed.

**Stronger proof for powerful actions.** Email and OAuth sign-ins are single-factor by product
decision. Anything that hands out or uses power needs a passkey check in the last 15 minutes
(`STEP_UP_FRESH_S`): changing roles, removing owners or admins, inviting admins, creating or revoking
API keys, verifying organizations, ending someone's sessions, removing a passkey, disconnecting a
sign-in provider (when the person holds a passkey). A person with no passkey cannot do these until
they add one. Recovery from a lost passkey is the email route, which therefore never reaches the
powerful actions on its own (V6.4.3).

## 2. Abuse limits (V6.1.1, V6.3.1)
Fixed windows kept in PostgreSQL (hashed keys). The red-team drill `http-red-team.test.ts` plays the
attacker against each row.

| Limit | Value | Per |
|---|---|---|
| Sign-in emails started | 10 / minute | address |
| Sign-in emails started | 5 / hour | target email |
| Sign-in proofs tried (link or code) | 30 / minute | address |
| Wrong code guesses | 5 | challenge (all addresses together) |
| Passkey sign-in and step-up options | 30 / minute | address |
| OAuth starts and callbacks | 10 / minute | address |
| Organizations created | 5 / day | person |
| Invitations sent | 20 / hour | organization |
| Request body | 256 KiB | request |

The address is the socket address, or the last `X-Forwarded-For` entry when a trusted edge is
configured (`AURA_TRUST_EDGE_REQUEST_ID`). Sign-in answers are the same for existing and unknown
emails and the start step never looks the address up (V6.3.8).

## 3. Sessions (V7.1.1, V7.1.2)
Opaque 256-bit token, only its SHA-256 stored; cookie `__Host-aura_session` in staging and
production (`Secure; HttpOnly; SameSite=Lax; Path=/`).

| Property | Value |
|---|---|
| Idle timeout, ordinary | 7 days |
| Idle timeout, people who hold power (platform admins, owners and admins of any team) | 30 minutes, applied on every request, so a promotion takes effect at once |
| Absolute timeout | 30 days |
| Concurrent sessions per person | 20; the 21st sign-in ends the oldest, never the new one |
| Activity write | at most once a minute |
| New token | on every sign-in (the browser's previous session is ended) and on promotion (the promoted person's other sessions end) |
| Ended by | logout, logout everywhere, revoking a device, deletion request, suspension, platform admin ending a person's sessions |
| Cross-site writes | refused unless the custom header, a matching Origin and `Sec-Fetch-Site` agree; API-key requests are exempt because they carry no ambient credential |

Justification: the 7-day idle limit balances sign-in friction against exposure for ordinary people,
whose strongest actions need a passkey check anyway; people who hold power get the short limit that
the kit specifies.

## 4. Authorization (V8.1.1, V8.1.2)
Enforced twice: `authorize()` in code (deny by default) and PostgreSQL row-level security using the
caller's role read inside the database (`app_org_role`). Outsiders get 404 for organization data, so
existence is not revealed.

| Action | Owner | Admin | Member | Outsider |
|---|---|---|---|---|
| Read organization and members | yes | yes | yes | no (404) |
| Rename organization | yes | yes | no | no |
| Change a member's role | yes | no | no | no |
| Remove a member | anyone | plain members | themselves | no |
| Invite | admins and members | members | no | no |
| Create, list, revoke API keys | yes | yes | no | no |

An API key acts for one organization and can only read it (`org:read`). A platform administrator can
verify organizations and end a person's sessions; the routes answer 404 to everyone else.

**Field level.** Every response goes through a strict allowlist schema. Secrets (token and key
hashes, public keys, counters, provider ids, the invitation hash) are not in any list and the
application database role has no column privilege on them.
