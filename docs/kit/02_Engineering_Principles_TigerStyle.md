# 02 — Engineering Principles (TigerStyle, adapted for TypeScript, Go and SQL)

> TigerStyle is TigerBeetle's coding philosophy: **safety → performance → developer experience**, "zero technical debt", assertion-dense, everything bounded, simulation-tested.
> The rules below are **adapted from our reading of TigerStyle** (secondary summaries and TigerBeetle's public docs). At Stage 0, fetch the original `TIGER_STYLE.md` from the TigerBeetle repository (`docs/TIGER_STYLE.md`), diff it against this file, and record deliberate deviations in `docs/adr/0002-tigerstyle-adaptation.md`. ⚠️VERIFY

TigerBeetle writes Zig with static allocation. We write TypeScript and Go, so we **keep the intent, not the letter**: bounded resources, explicit invariants, simple control flow, deterministic testing.

## 1. Design goals, in order

1. **Safety.** Correct or loudly stopped. Never silently wrong.
2. **Performance.** Design for it up front (back-of-envelope sketches on network, disk, memory, CPU), not as an afterthought.
3. **Developer experience.** Readability, naming, small surface, uncluttered repo root.

"Zero technical debt": do it right the first time; do not leave a known-bad shortcut for later. Fix the cause, not the symptom. Prefer a smaller feature done right.

## 2. Rules (each has an enforcement mechanism)

### 2.1 Control flow and size
| Rule | Why | Enforcement |
|---|---|---|
| Functions ≤ **70 lines**; files ≤ **600 lines** (excluding generated and tests) | Fits in a head | `tools/tigerlint.ts` (CI fails) |
| Line width ≤ **100 columns** | Reviewability | Biome formatter |
| **No recursion** (except provably bounded, documented parsers with an explicit depth argument) | Bounded stack | tigerlint + review |
| **All loops have a bound** (`for` over bounded arrays, or explicit `max_iterations`) | No runaway | review + assertions |
| Simple, explicit control flow; split compound conditions into nested `if`s when it clarifies; every `if` considers its `else` | Fewer hidden paths | review |
| Use `switch` over a discriminated union with an **exhaustiveness check** (`assertNever`) | Compiler proves completeness | tsc + Biome |
| No `any`, no `as` casts except at one documented parse boundary, no `!` non-null assertions, no `@ts-ignore` | Types are assertions | Biome + tsc `strict` flags |
| No default exports; named exports only | Greppable | Biome |
| No classes unless modelling a resource with lifecycle; prefer plain functions and data | Simplicity | review |
| No dynamic `eval`, `new Function`, dynamic `require`, reflection tricks | Security | Biome + Semgrep |

### 2.2 Limits on everything
Every queue, buffer, cache, page size, retry loop, string, upload, array in a request, SQL `LIMIT`, in-memory map and fan-out has an explicit named constant in `limits.ts` of its module, with a comment of the reasoning and unit (`MAX_SOURCE_BYTES = 256 * 1024 // 256 KiB`). Exceeding a limit returns a typed error; it never truncates silently (except documented log truncation).

### 2.3 Assertions (the "second layer of code")
- Assert **preconditions, postconditions and invariants**. Target density: **≥ 2 assertions per non-trivial function**.
- Assert both the **positive space** (what must be true) and the **negative space** (what must not be). **Pair assertions**: check a property at write time and again at read time / on the other side of a boundary (e.g. validate at API parse, assert again before the DB write; DB `CHECK` constraint as the third pair).
- Use one helper: `assert(condition, message)` that throws `InvariantError` (never caught except at the process top level, where we log, flush, and **exit** so the supervisor restarts clean). Go: `assert.True(...)` helper that panics.
- Assertions stay **on in production**. If one is too expensive for a hot path, move it behind a build flag, keep it on in tests/DST/fuzz, and record that in the code comment.
- Pure functions take already-validated types. External data enters through a Zod `parse` once; then it is typed and branded.
- Database `CHECK`, `NOT NULL`, `FOREIGN KEY`, `UNIQUE`, exclusion constraints and RLS policies are part of the assertion system. Prefer a constraint over a comment.
- **Crash on corruption.** If an invariant breaks, stop that unit of work (transaction rollback, job nack) and alert. Do not "log and continue" with possibly corrupt state.

### 2.4 Errors
- Anticipated failures are **values**: `Result<T, E>` with a closed union of error codes (`packages/contracts/errors.ts`). Unanticipated failures are exceptions and are bugs.
- **Handle every error** at the call site or deliberately propagate it. No empty `catch`. No `catch (e) { log }` that swallows. ESLint-equivalent Biome rule `noUselessCatch` + tigerlint check for `catch` bodies without rethrow/return.
- Every error has a stable machine code, a safe user message and an internal detail (never leaked to clients).

### 2.5 Naming, comments, structure
- **Say what you mean.** Descriptive names, no abbreviations except universal ones (`id`, `url`, `sha256`). Put **units and qualifiers last**, sorted by significance: `latency_ms_max`, `source_bytes_max`, `deadline_unix_ms`. Variable/field names `snake_case` in SQL/Go-JSON/API fields; `camelCase` in TS identifiers; `PascalCase` types; `SCREAMING_SNAKE` constants. (API JSON uses `snake_case`; mapping is done once at the contract layer.)
- Prefer **nouns over verbs for data**, verbs for functions. Related names share length so they align (`source_bytes`/`output_bytes`).
- **Comments say why**, not what. Every non-obvious constant, trade-off and invariant has a "why" comment. Start comments with a capital and end with a period. A reader should not need git history to understand a decision.
- **Newspaper order**: important things first (exports and the main function at the top; helpers below).
- Declare variables at the **smallest scope**, close to use. Avoid shadowing. Avoid reassigning (`const` by default).
- Do not duplicate state or create aliases; one source of truth (**no derived state stored** unless measured as necessary, and then with a recompute-and-compare test).
- Don't react directly to external events inside the handler's call stack; **batch and process at your own pace** (queues, tick loops, coalesced updates). E.g. scoreboard recompute runs on a tick, not once per submission.

### 2.6 Functions and abstraction
- Small, **pure** functions where possible; push side effects (I/O, clock, randomness) to the edges and **inject them** (`Clock`, `Rng`, `Db`, `Storage`, `Net`). This is what makes deterministic simulation possible.
- Hot-path functions take a few primitives, not big objects (helps the optimizer and the reader). Pass options as one typed object only when ≥ 3 optional arguments.
- Avoid premature abstraction: three similar blocks beat a wrong abstraction. Abstract only at a boundary that tests or a second implementation already demand (e.g. `Storage`, `Clock`, `IdentityVerifier`, `LlmProvider`).
- Build for **explicit options**: no booleans-in-a-row argument lists; use named object fields or string-literal unions.

### 2.7 Performance (designed in)
- Do a **back-of-envelope** for every new feature and write it at the top of the design note: requests/s, bytes, rows, p99 target. Name the bottleneck resource (network → disk → memory → CPU, in that order of cost).
- **Batch** work (SQL `INSERT ... SELECT`, `unnest`, COPY for telemetry), amortize round-trips, use **set-based SQL** over N+1 loops.
- Optimize for **tail latency** (p99), not mean. Bounded queues and load-shedding beat unbounded buffering.
- Measure before and after; keep micro-benchmarks for hot code (`vitest bench`, Go `testing.B`). A claimed speedup without a benchmark is rejected.

### 2.8 Dependencies
- **Minimize dependencies and tools.** Dependencies are a supply-chain and complexity liability (and 2026 supply-chain incidents in the npm ecosystem are real). Every addition needs an ADR: what it replaces, its size, maintainers, license, last release, install scripts, and an exit plan.
- Prefer the platform (Node built-ins, Web APIs, Postgres features, Go stdlib) over libraries.

### 2.9 Testing (as part of the style)
- **Deterministic simulation testing (DST)** for every stateful protocol: judge queue/leases, scoreboard, rating, exam session sync, credential issuance. Seeded PRNG + fake clock + fake network/disk with fault injection (drops, duplicates, reordering, crash-restart). A failing run prints its **seed**; the seed reproduces the failure exactly. See file 10.
- Property-based tests for parsers and scoring. Fuzz anything that parses untrusted bytes (bundles, archives, checker output, markdown).
- "Test the negative space": invalid input, boundaries at limit-1/limit/limit+1, authorization denials, and the failure paths.

### 2.10 Tooling hygiene
- Use **one** formatter+linter (Biome) and `tsc --noEmit --strict`. Warnings are errors in CI.
- Keep the **repo root uncluttered** (<= 12 entries). Scripts live in `tools/` and are written in TypeScript. No Makefile+shell+npm-script sprawl: `package.json` scripts are the single entry points.
- Compiler/linter are the first reviewers; **zero warnings policy**.

## 3. Go-specific (judge agent only)
- Standard library first. `context.Context` everywhere I/O happens; every goroutine has an owner and a shutdown path; bounded channels; no `init()` side effects; no global mutable state.
- Errors wrapped with `%w`, compared with `errors.Is/As`; no `panic` except invariant assertions (`assert` package) which crash the process by design.
- `go vet`, `staticcheck`, `govulncheck`, `-race` in tests, native fuzzing for parsers (`go test -fuzz`).
- Static binary (`CGO_ENABLED=0`), reproducible builds, signed releases.

## 4. SQL-specific
- Hand-reviewed migrations; **expand → migrate → contract** (never destructive in the same release as the code that stops using the column).
- Every table: primary key `uuid DEFAULT uuidv7()`, `created_at timestamptz NOT NULL DEFAULT now()`, relevant `CHECK`s, explicit `ON DELETE` behavior, and `org_id` + RLS policy where tenant data.
- Every query that can return many rows has `ORDER BY` with a unique tiebreaker and a `LIMIT`. Every FK has an index. Run `EXPLAIN (ANALYZE, BUFFERS)` for any query on the hot-path list and keep the plan in the PR.
- No ORM magic in hot or security-critical paths: write SQL via Drizzle's `sql` tag with parameters. **No string-concatenated SQL anywhere** (tigerlint + Semgrep rule).

## 5. Review checklist (use on every PR, human or Claude)
1. Which invariant does this protect or rely on? Is it asserted?
2. What are the limits? Are they named and enforced?
3. What happens on failure at each I/O step? Is it handled and tested?
4. Could a different tenant/user reach this data or action? Is it enforced in the DB, too?
5. What is the back-of-envelope cost? Is the tail bounded?
6. Is any new dependency justified by an ADR?
7. Is the test deterministic, does it fail first, and does it cover the negative space?
8. Would a new engineer understand the *why* from the comments alone?
9. Does every changed line trace to the request or stage plan (craft §3)? Anything speculative or drive-by is removed.
10. Are assumptions stated, and is there a concrete, verifiable success check (craft §1, §4)?

## 6. Integration with the `craft` skill

The user has a personal skill named **`craft`** (`~/.claude/skills/craft/SKILL.md`). It is a generic, language-agnostic distillation of the same philosophy as TigerStyle plus working-method rules. **Invoke it (Skill tool) at the start of every implementation session and before every review**; it is part of the definition of "how we work". The kit says *what* the system must be; `craft` governs *how each individual change is made*.

### 6.1 Mapping (so nothing is applied twice or contradicted)
| `craft` section | Where the kit already covers it | Net effect |
|---|---|---|
| §1 Think before coding; state assumptions; always say why | Stage plan step (file 13 P1) | Every plan has an **Assumptions** section; ambiguous requirements list the interpretations considered |
| §2 Simplicity, nothing speculative; zero tolerance for known showstoppers | §2.6 (no premature abstraction), §1 "zero technical debt" | Stronger: see 6.3 (ports are created in the stage that first needs them) |
| §3 Surgical changes | New | See 6.2 |
| §4 Goal-driven execution; exhaustive tests incl. the valid→invalid boundary | File 10 | Plans state success criteria as verify-steps; boundary tests (limit-1/limit/limit+1) are mandatory |
| §5 Defensive coding, explicit errors, bounds, explicit options | §2.2–2.4 | Adds: prefer several simple checks over one compound; **pass important options explicitly** (no reliance on library defaults) |
| §6 Structure: short functions, push `if`s up / `for`s down, positive conditions, smallest scope, check-near-use, index/count/size | §2.1, §2.5, §2.6 | Adds the rules in 6.2 |
| §7 Naming: no abbreviations, units last, helper prefixed by caller, important things first | §2.5 | Adds: helper/callback prefix, and **long CLI flags** (`--force`, not `-f`) in all our scripts |
| §8 Comments explain why; descriptive commit messages (a PR description is not a substitute) | §2.5 | Adds the commit-message rule in 6.2 |
| §9 Performance: back-of-envelope early, batch | §2.7 | Same |

### 6.2 Rules adopted from `craft` that are new to this kit
1. **Surgical changes.** Touch only what the task requires. No drive-by refactors, reformatting or "improvements" to adjacent code. Mention unrelated issues in the PR/stage report instead of fixing them. Remove only the imports/functions *your* change made unused. **Test:** every changed line traces to the request; if you cannot say why a line changed, revert it. (Generated files and the stage's planned renames are the only exceptions.)
2. **Push `if`s up, `for`s down.** Branching lives in the parent function (service/handler); helpers are non-branchy and do one job. Likewise **state mutation is centralized in the parent**: helpers/`rules.ts` compute *what* should change; the parent applies it (this is exactly why `rules.ts` is pure).
3. **Positive conditions.** Write `if (index < count)` rather than `if (index >= count)` for invariants and guards where possible; split compound conditionals into nested `if`s when it clarifies which cases are handled.
4. **Check near use.** Validate or compute a value as close as possible to where it is used; any gap between check and use is a TOCTOU shape (matters for authz, quota, lease checks).
5. **`index` vs `count` vs `size`** are distinct: index is 0-based, count is 1-based, size is count × unit. Name them so (`test_index`, `test_count`, `source_bytes_size`) and never mix them; boundary tests cover both ends.
6. **Several simple assertions over one compound one**: `assert(a); assert(b);`, so failures are informative.
7. **Explicit options.** Pass security- and behavior-relevant options explicitly at every library/API call (timeouts, TLS verify, cookie flags, `strict` parsers, `redirect: 'error'`, SQL `LIMIT`, S3 `ContentLength` bounds) instead of trusting defaults that may change upstream. A wrapper that sets them once is fine; scattered reliance on defaults is not.
8. **Helper naming:** prefix a helper/callback with its caller (`readBundle` / `readBundleOnChunk`). Do not give one name two meanings; rename when a concept shifts.
9. **Commit messages** are descriptive and explain *why* (Conventional Commits subject + body). The PR description does not replace them, because it is not stored with the code.
10. **Non-trivial tests** begin with a one-to-three-line comment stating goal and method (and, for DST scenarios, the invariant under test).
11. **State assumptions; present alternatives; push back.** If a simpler approach exists than the one requested, say so. If something is unclear, name precisely what is unclear instead of working around it.

### 6.3 Resolving the tension between "the kit is big" and "nothing speculative"
- The kit describes the **destination**. Each stage builds **only its own scope**; "Out of scope" lists in file 12 are binding. Do not pre-build later stages' modules, tables, ports or abstractions "for flexibility".
- **Ports and adapters** (`MailPort`, `BillingPort`, `LlmProvider`, `IdentityVerifier`, `AuthPort`, `ContaminationIndex`, …) are created **in the stage that first has a real consumer** (and at least one real + one fake implementation). Stage 0 creates only the ports needed for determinism: `Clock`, `Rng`, `Db`, `Storage`, `Net`.
- Vendor choices that are *not yet needed* stay as decisions in file 15, not as code.
- The same applies to configuration: no option without a present need.

### 6.4 Precedence when guidance conflicts
1. Security rules (file 08) and domain invariants (file 01 §6) always win.
2. Then `craft` (how to make each change) and this file (TigerStyle numeric rules).
3. Then convenience. Existing code in a *pre-existing* repo: match its style (craft §3); in this new repo the kit **is** the style.
4. **Asking vs. proceeding:** `craft` says to ask when genuinely uncertain. The kit's earlier "ask only when blocked" means: do not ask about things the kit already decides, or low-stakes choices (pick the default, state the assumption, record an ADR). **Do** ask (or present the options in the stage plan and wait) when requirements are ambiguous in a way that changes the design, when a human-owned decision is involved (file 15 §3), or when an action is destructive/irreversible.
