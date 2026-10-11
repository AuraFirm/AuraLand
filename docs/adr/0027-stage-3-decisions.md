# 0027 — Stage 3 decisions (queue, submissions, judge)
Status: accepted
Date: 2026-10-11

## Context
The owner approved Stage 2 and asked for Stage 3 to be planned and built without waiting, delegating
every decision. `docs/stages/stage-3-plan.md` section 3 lists them.

## Decision
1. Queue in PostgreSQL with `SKIP LOCKED`, one queue, fencing epochs (kit).
2. Node authentication: Ed25519-signed requests with an enrollment token; mTLS added at the edge later
   without protocol change. Reason: the kit's mTLS needs infrastructure that does not exist yet, and a
   signature check in the app is testable now.
3. The agent is Go in a new top-level folder `judge/` (kit); wire contract hand-written and checked by
   shared JSON fixtures instead of a generator.
4. Code runs only behind a `Sandbox` interface (fake and `isolate`).
5. C++ and Python first.
6. Bundle validation runs inside a sandbox box on a judge node using the existing TypeScript validator
   under a pinned Node runtime; the Go port is deferred.
7. Practice submissions only.
8. No sandbox claim is made without observation: what cannot be run on the development machine
   (macOS) is written, tested at the pure-function level, and reported as unverified until a Linux
   node exists. No public use before the external sandbox review.

## Alternatives considered
Redis or a broker for the queue (a second system to run and fail); mTLS first (blocks all progress on
infrastructure); porting the validator to Go now (large, and the TypeScript one is the fuzzed code);
running user code in a Docker container on the developer machine for tests (violates the rule that
untrusted code runs only on judge nodes).
