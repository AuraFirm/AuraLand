# Stage 5 plan (draft): contests, Arena, ratings

Status: **draft for your review. No Stage 5 code starts until you approve it.** Kit: `docs/kit/12` Stage 5,
`05` sections 6 to 9 (contest tables, state machine, scoreboard, rating), `06` section 6 (realtime), `09`
(Arena screens), `10` (scoreboard and rating simulations, load tests), `08` (abuse).

## 1. Where this starts, and what is true about it
Stage 4 is approved. Practice submissions work end to end (queue, signed judge nodes, verdicts), but:
- a submission needs **membership of the task's organization** (`submissions_insert`), and the only
  readable visibilities for plain members are `org`; `public` exists as a value but no policy reads it, so
  **a stranger cannot see or submit to anything yet**. Contests and the Arena cannot work until that is
  designed, and it is the riskiest part of this stage (hidden tests must stay hidden);
- there is no realtime channel at all (no SSE, no `LISTEN/NOTIFY`), no scoreboard, no rating, no public
  page that shows people;
- the judge has only been run on a development VM and never reviewed (F32): **nothing here may be called a
  real contest until a production node exists.**

## 2. Honest limits of this stage
The kit's acceptance includes "5k concurrent viewers + 100 submissions/s meets SLO" and "first real contest
(200+ participants) as a pilot with a rollback plan". **Neither can be met by building**: both need a
deployment (F1), an edge (F33), a reviewed production judge fleet (F32) and real people. What I can deliver
and verify: the logic (folds, ticks, ratings, state machines) under simulation, the realtime path under a
**scaled-down** local load test with its numbers reported as what they are, and a pilot runbook.

## 3. Decisions I need from you (my default in bold; "defaults" accepts all)
1. **Formats.** **ICPC and IOI, rated or unrated; plus `cf_rated`-style decay scoring later only if you ask.**
   `centaur`, `hack_verify` and `agent_ladder` are Stage 8+ in the kit and stay out.
2. **Who may take part without belonging to the host organization.** **Registration to a contest grants
   read of exactly its problems' statements and the right to submit to them, while the contest allows it,
   and nothing else.** Practice gets the same through a new platform problem bank: released versions of
   `public` tasks owned by a `platform` organization become readable and submittable by any signed-in
   person (statements and samples only; hidden tests, solutions and bundles never). Alternative: only
   members of the host organization take part (no open Arena).
3. **Contest problems come from the host organization's own released versions, or from the platform bank.**
   Submissions keep the task's organization as their `org_id` (the existing foreign key), and add
   `context_id` pointing at the contest; a contest can therefore mix its own and bank problems.
4. **Teams.** **Individuals only.** `registrations.team_id` stays null; ICPC team contests wait.
5. **Assurance and AI policy.** **Only assurance level 0 (no identity proof) and no AI enforcement:** the
   fields exist and are displayed ("AI policy: not enforced, no telemetry"), because identity proofs and
   telemetry are Stage 6/7. The scoreboard says so.
6. **Scoring details.** ICPC: solved count, then penalty = minutes to the first accepted run + 20 for each
   rejected run before it; compile errors do not count; ties broken by time of the last accepted run, then
   by registration order. IOI: best score per problem, ties by time of the last improvement. Penalty and
   decay numbers are contest `rules`, validated, not constants.
7. **Rating.** **Elo-MMR-style, one dimension ("contest"), parameters in configuration**, deterministic,
   idempotent per contest, only for `rated` contests with at least 20 registered participants who submitted.
   I will implement it from the published description and test properties (monotone in rank, bounded change,
   stable under permutation of ties, no NaN); I have **no independent implementation to take golden vectors
   from**, and will say so rather than invent some.
8. **Scoreboard publishing.** **Public contests expose a cacheable snapshot (`s-maxage=1`) with display names
   and handles of public profiles only;** unlisted and private profiles appear as "participant N".
9. **Judge capacity.** **Contest submissions are leased before practice submissions** (a higher queue
   priority) and practice submission is shed first when the queue is long.
10. **More language profiles.** **Add C (gcc) and Java 21,** each with a profile and escape-suite programs;
    Rust and Go later. Alternative: skip new languages this stage.
11. **Daily challenge.** **A deterministic pick from the bank by date;** no streaks.
12. **Clarifications.** Plain text questions to the organizers, answers visible to everyone or to the asker
    only, append-only, rate limited; no Markdown from contestants.

## 4. Work breakdown (one pull request each, tests first; report after each part)
**5A: contests and the right to take part**
| # | Slice | Verify |
|---|---|---|
| 0 | ADR 0031; contracts (format, rules, states); the open-participation design with its RLS and a threat-model section | review; contract tests |
| 1 | Migration: contests, contest_problems, registrations, submissions `context_id`; platform bank visibility; state machine with a worker tick | RLS matrix, db tests, state-machine simulation |
| 2 | Organizer API and screens (create, schedule, add problems, publish); registration with limits | HTTP tests, authz matrix, browser test |
| 3 | Contest submission rules (window, registration, per-problem rate, queue priority, verdict visibility) | HTTP tests, queue simulation |

**5B: scoreboard and realtime**
| # | Slice | Verify |
|---|---|---|
| 4 | `foldScoreboard` (pure; ICPC and IOI; freeze; ties) | property tests; incremental equals recompute |
| 5 | Snapshots and the 1 s tick (delta since last seq); the scoreboard simulation scenario | simulation, many seeds |
| 6 | SSE with `LISTEN/NOTIFY`, ring buffer, caps; cacheable snapshot with ETag | integration tests, caps and resume tests |
| 7 | Freeze, unfreeze, rejudge, clarifications | simulation of late verdicts and rejudges; HTTP tests |
| 8 | ICPC-tools-compatible export (I will check the format against its public specification first) | golden test against the spec's examples |

**5C: ratings and profiles**
| # | Slice | Verify |
|---|---|---|
| 9 | `rateContest` (pure) and the idempotent rating job after finalization | property tests, rating simulation |
| 10 | Public profiles with rating history and colors; privacy rules | HTTP tests, browser test |

**5D: Arena and the rest**
| # | Slice | Verify |
|---|---|---|
| 11 | Arena screens (home, lobby with server-synced countdown, virtualized scoreboard, problem workspace); accessibility | browser tests, axe |
| 12 | Practice bank, daily challenge, platform status banner | HTTP and browser tests |
| 13 | C and Java profiles and escape-suite programs | real-sandbox runs on the development VM |
| 14 | Scaled load harness (`contest-start-spike`), pilot runbook, threat model v7, ASVS rows, Stage 5 report | the harness's numbers, reported as scaled |

## 5. Security notes
Hidden tests, reference solutions and bundles never reach a participant (response schemas stay
allowlists); the open-participation rule is enforced in Postgres policies and tested in the RLS matrix for
a stranger, a registered participant before, during and after the window, and a participant of another
contest; a frozen scoreboard never reveals post-freeze events to the public view (simulation); registration
and submission are rate limited per person and per contest, and bursts are measured, not trusted to Turnstile
(no account yet, F7); rating inputs are only judged contest submissions; ratings are never edited by hand,
only recomputed; plagiarism or similarity is a later signal, not a decision (Stage 6); the SSE stream
re-authorizes on every reconnect and closes at 30 minutes.

## 6. What this still will not do
No identity proof, no proctoring, no AI-policy enforcement, no teams, no cf_rated or agent ladders, no real
pilot, no SLO claim at 5,000 viewers. Contest-day support (D11) is a human decision.

## 7. Things only you can provide
The decisions above; for any real contest, the production judge node and its review (F32), a deployment and
edge (F1, F33), and a decision on who is on call (D11).
