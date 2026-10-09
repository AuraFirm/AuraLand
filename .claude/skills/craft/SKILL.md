---
name: craft
description: Behavioral and style discipline for writing, reviewing, or refactoring code. Use this any time you are about to write new code, edit existing code, review a diff, plan a multi-step coding task, or fix a bug, regardless of language or project size. Especially make sure to consult this before making changes to an existing codebase (to stay surgical) and before starting anything non-trivial (to define success criteria up front).
---

# Craft

A generic set of principles for how to think, write, and modify code — language- and stack-agnostic,
scaling from a 3-line fix to a large multi-service project. The goal is deliberate, minimal,
load-bearing changes, not sprawling ones.

**Tradeoff:** this biases toward caution, rigor, and restraint over speed. For trivial, one-off
tasks, use judgment — don't apply ceremony to a 3-line fix.

---

## 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions explicitly before implementing. If genuinely uncertain, ask — don't guess and
  proceed silently.
- If multiple reasonable interpretations exist, present them rather than silently picking one.
- If a simpler approach exists than the one implied by the request, say so. Push back when
  warranted rather than complying with something you think is a mistake.
- If something is unclear, stop and name specifically what's confusing rather than working around
  it.
- **Always motivate, always say why.** Explaining the rationale for a decision — in a comment, a
  commit message, or in conversation — does two things: it helps the reader understand, and it
  gives them the criteria to evaluate whether the decision was right.

## 2. Simplicity Is the Hardest Revision, Not the First Draft

Simplicity isn't a shortcut — it's earned through iteration, not skipped to.

- Write the minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked. No abstractions for single-use code. No "flexibility" or
  "configurability" that wasn't requested. No error handling for scenarios that can't occur.
- If you write 200 lines and it could be 50, rewrite it. Ask: "Would a senior engineer call this
  overcomplicated?" If yes, simplify.
- Spend the thinking upfront. An hour of design is worth weeks of production fallout — it's much
  cheaper to ask "what could go wrong?" during design than to ask "what's wrong?" in production.
- Treat unresolved showstoppers (a race condition, an unbounded loop, an unhandled error path) as
  zero-tolerance. Don't let a known problem ship "for now" — the second pass to fix it often
  doesn't happen.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting while making an unrelated change.
- Don't refactor things that aren't broken as a side effect of a different task.
- Match the existing style of the codebase, even if you'd personally do it differently.
- If you notice unrelated dead code or pre-existing issues, mention them — don't silently delete or
  fix them unless asked.
- Do remove imports, variables, or functions that _your own_ change made unused. Don't touch
  pre-existing dead code.
- **The test:** every changed line should trace directly to the request. If you can't explain why a
  line changed, revert it.

## 4. Goal-Driven Execution

Define success criteria before starting. Loop until verified, not until it "looks done."

- Turn vague tasks into verifiable goals:
  - "Add validation" → "Write tests for invalid inputs, then make them pass."
  - "Fix the bug" → "Write a test that reproduces it, then make it pass."
  - "Refactor X" → "Confirm tests pass before and after; behavior is unchanged."
- For multi-step work, state a brief plan up front:
  ```
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]
  3. [Step] → verify: [check]
  ```
- Weak success criteria ("make it work") force constant back-and-forth. Strong criteria let you
  work and verify independently.
- **Tests must be exhaustive, not just happy-path.** Test invalid data, boundary conditions, and the
  moment valid data becomes invalid — that boundary is where the interesting bugs live.

## 5. Defensive Coding: Fail Fast, Fail Loud

- **Every function should validate what it operates on.** Check preconditions on arguments,
  postconditions on return values, and invariants that must hold throughout. A function shouldn't
  operate blindly on data it hasn't checked.
- Check both directions: assert the _positive space_ you expect (valid states) and the _negative
  space_ you don't (invalid states). Bugs cluster at the boundary between the two.
- Prefer several simple checks over one compound one: `check(a); check(b);` reads more clearly and
  fails more informatively than `check(a and b)`.
- **All errors must be handled explicitly.** Never silently swallow an exception or ignore a
  non-zero exit code / rejected promise / error return. Most catastrophic production failures trace
  back to incorrectly handled — not unhandled — error paths.
- Put a bound on everything that _should_ be bounded: loops, queues, retries, recursion depth,
  request sizes. An unbounded loop or queue is a design gap, not an edge case — surface it rather
  than letting it fail unpredictably later. Where something genuinely must run unbounded (e.g. an
  event loop), say so explicitly rather than leaving it ambiguous.
- Avoid unbounded recursion in particular, since it's the easiest way to accidentally build
  something with no bound.
- Explicitly pass important options/config to library or API calls instead of relying on silent
  defaults — protects against surprising behavior if the default ever changes upstream.

## 6. Structure and Control Flow

- **Keep functions short.** Pick a limit appropriate to your language/domain (the point where a
  function stops fitting comfortably on one screen is a good rule of thumb) and treat it as a real
  limit, not a suggestion.
- Good function shape is an hourglass inverted: few parameters, a simple return type, and the bulk
  of the logic in the body.
- **Push `if`s up, `for`s down.** Centralize branching logic in a "parent" function; keep helper
  functions non-branchy and focused on one job. Similarly, centralize state mutation in the parent;
  let helpers compute _what_ should change rather than applying the change themselves. This keeps
  control flow legible in one place instead of scattered.
- Split compound conditionals into nested `if`/`else` rather than one dense boolean expression — it
  makes it obvious which cases are and aren't handled.
- State invariants positively where possible (`if (index < length)`) rather than negated
  (`if (index >= length)`) — negations are harder to reason about correctly.
- Declare variables at the smallest scope possible, and minimize how many are in scope at once —
  fewer things to accidentally misuse.
- Compute or check a value as close as possible to where it's used. A gap in time or space between
  "check" and "use" is exactly the shape of many real bugs.
- Watch for off-by-one errors around `index` vs. `count` vs. `size` — treat them as distinct
  concepts even when they're the same primitive type (index is 0-based, count is 1-based, size is a
  count times a unit).

## 7. Naming

- Get the nouns and verbs right — a good name captures what a thing _is_ or _does_ and shows you
  understand the domain.
- Don't abbreviate. Use descriptive full names for variables, functions, and flags (`--force`, not
  `-f`, outside of truly interactive/short-lived contexts).
- Don't overload a name with multiple context-dependent meanings — if a concept shifts meaning
  partway through a codebase's life, rename it rather than stretching the old name to cover both.
- Add units or qualifiers to variable names and put them _last_, ordered from most to least
  significant: `latency_ms_max`, not `max_latency_ms`. This groups and sorts related variables
  naturally and avoids unit-confusion bugs.
- Prefix a helper/callback with the name of the function that calls it, to show call history:
  `read_file()` / `read_file_callback()`.
- Order matters for readability even when it doesn't affect behavior — put the most important things
  near the top of a file; a reader scans top-down.

## 8. Comments and Commit Messages

- Code alone is not documentation. Comments should explain **why**, not what — the reasoning,
  the rejected alternative, the constraint that shaped the decision.
- For non-trivial tests, add a short comment on the goal and method so a reader can decide whether
  to dive in or skip past.
- Write comments as real sentences: capitalized, punctuated, readable prose — not fragments.
- Write descriptive commit messages. They're read far more often than they're written, and a PR
  description doesn't substitute for one — it isn't stored with the code and won't show up in
  version-control history later.

## 9. Performance (When It Matters)

- Think about performance during design, not after profiling — the largest wins come from
  architectural choices made before a line of code exists, not from micro-optimizing what already
  works.
- Do a rough back-of-the-envelope estimate for the resources you'll touch (network, disk, memory,
  CPU — roughly in order from slowest to fastest) before committing to an approach. Being roughly
  right early beats being precisely right too late.
- Batch operations where possible instead of reacting to every individual event; batching amortizes
  overhead and keeps the system's own pacing under your control rather than being dictated by
  external event timing.

---

## Summary Checklist

Before finishing any change, confirm:

- [ ] Did I state my assumptions / ask when genuinely unclear, instead of guessing silently?
- [ ] Is this the simplest solution that satisfies the actual request — nothing speculative added?
- [ ] Does every changed line trace back to the request (no drive-by refactors)?
- [ ] Do I have a concrete, verifiable way to confirm this works (a test, a repro case, a check)?
- [ ] Are all error paths handled, and are preconditions/invariants checked, not assumed?
- [ ] Are functions short and single-purpose, with branching centralized rather than scattered?
- [ ] Are names precise, unabbreviated, and free of unit ambiguity?
- [ ] Do my comments and commit message explain _why_, not just _what_?
