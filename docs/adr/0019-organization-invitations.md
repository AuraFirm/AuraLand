# 0019 — Organization invitations
Status: accepted
Date: 2026-10-10

## Context
People join organizations by invitation. The invitee may not have an account yet, and the inviter must
not be able to use the feature to find out who has one.

## Decision
- **An invitation names an email address, not a person.** The inviter never looks the address up. The
  person accepts by signing in with that verified address and presenting the secret link (token in the
  URL fragment, so it is not sent to servers or logs). The secret is stored only as an HMAC under the
  server key, like sign-in links; the invitation is spent in one statement that checks the hash, the
  accepting person's verified email, that it is pending and that it has not expired.
- **Roles.** Owners invite admins and members; admins invite members; nobody invites an owner (the
  owner role is given by an owner changing a role). Inviting an admin hands out power, so it needs
  the passkey step-up (ADR 0018). The policy is both in `authorize()` and in the database policy.
- **Lifetime and limits.** Seven days. Re-sending to the same address replaces the earlier pending
  invitation. 100 pending per organization and 20 sent per organization per hour. A personal space
  cannot invite (and, by trigger, never has a second member); an organization holds at most 5,000
  members. A person at the 20-organization limit cannot accept; the invitation stays usable.
- **Atomic acceptance.** Spending the invitation and adding the membership happen in one `aura_auth`
  transaction, so a failure (already a member, a limit) leaves the invitation pending.
- **Email goes out before the commit.** If sending fails the invitation is not saved. The cost is a
  pooled connection held for the mail call (5 s at most); invitations are rare, so this is simpler
  than a send-after-commit retry loop. Revisit with the worker (Stage 3).
- **No pre-check for existing membership at send time**, because the answer would reveal who has an
  account; acceptance simply fails for someone who is already a member.

## Alternatives considered
Adding people directly by handle or email (an account-existence oracle). Invitations that bind to a
user id (cannot invite someone without an account). Sending after commit with a retry queue (needs the
worker, which Stage 1 does not have).

## Consequences
An invitation link is a bearer secret for one specific verified address: forwarding it does nothing
for anyone else. An email provider outage blocks invitations (503, nothing saved).

## Verification
`invitations.test.ts` (8 database cases, six migration mutations caught) and `http-invites.test.ts`
(12 end-to-end cases, ten injected faults caught), plus the authorization matrix rows.

## Revisit trigger
The worker arrives (move sending out of the request), or enterprise SSO (then invitations may be
replaced by domain-based joining).
