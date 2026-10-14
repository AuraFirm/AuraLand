# 0031 — Stage 5 decisions (contests, Arena, ratings)
Status: accepted
Date: 2026-10-14

## Context
The owner accepted the defaults of `docs/stages/stage-5-plan.md` ("defaults, go ahead"). Contests and the
Arena are the first place where strangers take part in something an organization owns, so the central
question is who may read a problem and submit to it without belonging to the owning organization.

## Decisions
1. Formats: ICPC and IOI, rated or unrated. Other formats wait for Stage 8.
2. **Open participation, as a rule the database enforces.** A person who registered for a contest may read
   the released versions of that contest's problems and submit to them, only while the contest allows it:
   - *read* the statement from the moment the contest is `running` until it is `finalized`; never while it
     is `draft` or `scheduled`, not even for registered people (problems stay secret until the start);
   - *submit* only while it is `running` or `frozen` and the clock is inside `[starts_at, ends_at)`;
   - everything else about the task stays closed: bundles, tests, solutions, the validation report, the
     reviewers' comments. Response schemas stay allowlists (statement, limits, samples).
   Contest submissions are created only through a SECURITY DEFINER function that takes the injected clock,
   checks registration, state, window, the problem's membership in the contest and the per-problem
   submission interval, inserts and queues in one step; the `aura_app` insert policy for submissions stays
   limited to practice. Contest state is moved by the worker, so the function (not the state alone) checks
   the time: a worker that is down at the end of a contest must not extend it.
3. **Who competes.** Anyone signed in, except people who could know the answers: owners, admins, setters and
   reviewers of the host organization or of the organization of any of the contest's problems cannot
   register as competitors (they may watch the public scoreboard).
4. **Whose problems.** A contest uses released versions of the host organization or of the platform bank.
   The problem set is frozen when the contest leaves `draft`. A submission keeps its task's organization as
   `org_id` and gains `context_id` (the contest); host owners and admins read their contest's submissions
   through a policy on the contest, not through the task's organization.
5. **Teams:** individuals only; `team_id` is left out of the Stage 5 schema (not added and ignored).
6. **Assurance and AI policy:** only level 0; `ai_policy` is stored and displayed as "not enforced".
7. **Scoring:** ICPC (solved, penalty = minutes to first AC + a fixed penalty per rejected run, compile
   errors free; ties by last accepted time, then registration order); IOI (best score per problem, ties by
   last improvement). Penalty and interval are validated `rules`.
8. **Per-test results are hidden from contestants while the contest runs** (they see the verdict and, in
   IOI, the score): per-test verdicts would let a contestant probe the hidden tests one by one. They
   become visible when the contest ends.
9. **Rating:** an Elo-MMR-style, one-dimension rating; deterministic; idempotent per contest; only for
   `rated` contests with at least 20 participants who submitted; parameters in configuration. Property
   tests only: no independent implementation exists to take golden vectors from.
10. **Scoreboard:** pure fold, 1 s coalesced worker tick over the delta since the last sequence number,
    snapshot rows written only when changed, `LISTEN/NOTIFY` to wake the API instances, SSE with a bounded
    ring buffer, a cacheable snapshot with an ETag. Public views show handles and display names of public
    profiles only ("participant N" otherwise) and, while frozen, never an event after the freeze.
11. **Queue:** contest submissions are leased before practice ones (priority 1 against 5); practice is shed
    first when the queue is long.
12. **Languages:** add C and Java 21 with profiles and escape-suite programs; Rust and Go later.
13. Daily challenge: a deterministic pick from the bank by date, no streaks. Clarifications: plain text,
    append-only, answers public or to the asker only, rate limited.
14. No dependencies are planned for the stage.

## What the tests must prove about decision 2 (RLS matrix rows, slice 1)
A stranger, a registered person before the start, during the contest, after it ended and after it was
finalized, a person registered for another contest, an organizer who tried to register, and a host admin:
each against statement reads, bundle and validation-report reads, submission creation and submission reads.
No row of the matrix may let a contestant read a hidden test, a reference solution or a bundle.

## Alternatives considered
Only members of the host organization take part (no open Arena; rejected: it is the product); letting the
`aura_app` role insert contest submissions under a policy (rejected: the policy cannot see the injected
clock, and a stalled worker would keep a contest open); showing per-test verdicts during the contest
(rejected: test probing).

## Amendment (slice 5): rebuild from the log, not from a delta

Decision 10 said the tick folds "the delta since the last sequence number". Judging finishes out of order
and a rejudge rewrites old verdicts, so a delta can miss a change. The tick instead rebuilds a contest's
board from its judged log whenever the contest's input stamp (state, judged count, newest `updated_at`)
differs from the stored board's stamp, and writes a row only when its etag changes. The fold is
order independent and tested to equal incremental application, so a delta can replace the rebuild if a
contest ever outgrows it; until then the simpler design is always correct. The public view keeps hiding
what follows the freeze even after the contest ends, until slice 7 adds the unfreeze.

## Amendment (slice 6): streams carry pings, not boards, and need no ring buffer

The plan called for SSE with a bounded ring buffer. A stream instead carries only "version n exists" pings
(`{version, etag}`); the board is fetched from the cacheable snapshot (`ETag`, `s-maxage=1` for the public
board of a public contest). Missed pings collapse into the newest one, so each stream holds one slot and a
client that missed anything reads the snapshot, which is always the truth: a ring buffer would only replay
what the snapshot already gives. Bounds: 5,000 streams per instance, 3,000 per contest, 5 per signed-in
person, 20 per address for anyone else, a 15 s keepalive, and a 30 min lifetime after which the client
reconnects and is authorized again. `NOTIFY` is sent by the storing function with contest, view, version
and etag only; when the listener's connection is re-established every open stream re-reads as its caller.
