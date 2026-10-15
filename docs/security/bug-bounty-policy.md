# Vulnerability disclosure and bug bounty policy (draft)

**Status: a draft for the owner. Nothing here is live: there is no security contact address, no `security.txt` is served, and no bounty
platform or budget exists (owner tasks, section 3.11).**

## Scope
In scope: the AuraLand web app and API at the production address once it exists, the judge node software, the signed documents
(credentials, status lists), and webhooks and SCIM endpoints. Out of scope: denial of service by volume, social engineering of staff,
physical attacks, third-party services we use, findings from automated scanners without a demonstrated impact, and anything on a
machine that is not ours.

## Rules for researchers
Test only accounts and organizations you own. Do not read, change or keep other people's data; stop and tell us if you reach it. Do not
run code on judge nodes outside the submission and environment features. Give us a reasonable time (90 days) before telling anyone.
We will not take legal action against good-faith research that follows these rules.

## What we promise
Acknowledge within 3 working days, confirm or explain within 10, tell you when it is fixed, and credit you if you wish. Reports about
the sandbox (escape from a Tier-1 or Tier-2 run) are the most valuable and go to the front of the queue.

## Rewards
Not decided. A private programme with invited researchers first (kit 08: private by month 6, public by month 12), with amounts set by
the owner. A sandbox reviewer or pentester is a separate, paid engagement (cutlist F73).

## To publish this
1. Choose the contact address and a PGP key or a form. 2. Serve `/.well-known/security.txt` (template in `docs/security/security.txt.template`).
3. Pick a platform (or none) and a budget. 4. Have a lawyer read the safe-harbour sentence.
