# 0002 — TigerStyle adaptation (diff against the original)
Status: accepted
Date: 2026-10-10

## Context
docs/kit/02 was written from secondary summaries. The original `docs/TIGER_STYLE.md` was fetched
from the TigerBeetle repository on 2026-10-10 and compared rule by rule.

## Decision
Confirmed as written in the kit: priorities (safety, performance, developer experience); 70-line
function limit; 100-column limit; no recursion; limits on everything; at least two assertions per
function on average; pair assertions; assert positive and negative space; split compound assertions;
push `if`s up and `for`s down; centralize state mutation; state invariants positively; all errors
handled; do not act directly on external events; pass options explicitly; say why; descriptive
commit messages; units and qualifiers last in names; `index`/`count`/`size` kept distinct; test
valid, invalid and valid-to-invalid transitions; simulation testing; 4-space indentation.

Additions the kit missed, now adopted:
- `if (a) assert(b);` expresses an implication. Assert relationships between constants at module
  load where they exist (a limit that must be smaller than another).
- Related names have equal length where possible (`source`/`target`, not `src`/`dest`); callbacks
  go last in parameter lists; options objects when arguments could be confused; acronyms keep
  their capitalization (`HTTPException`, not `HttpException`).
- Do not duplicate state or create aliases; compute or check values near their use.
- Scripts are written in the project language (TypeScript), long-form flags only.
- Convert `else if` chains into nested `else { if }` where it clarifies which cases are handled.

Deliberate deviations:
| Original | Ours | Reason |
|---|---|---|
| `snake_case` for functions, variables, files | `camelCase` identifiers in TypeScript, `kebab-case` files, `snake_case` in JSON and SQL | Idiomatic TypeScript; the wire and database formats stay snake_case |
| Zero dependencies | Dependency budget enforced by `depcheck` | A web product cannot reasonably reimplement TLS-adjacent and framework code; budget, ADRs and exact pins limit the risk |
| Static allocation, no dynamic memory after init | Bounded queues, caches and pools | A garbage-collected runtime offers no static allocation; we bound sizes instead |
| Explicitly sized integer types | `number` with safe-integer assertions, `bigint` where overflow matters | No fixed-width integers in TypeScript |
| `zig fmt` | Biome formatter | Language tooling |

## Consequences
tigerlint enforces what Biome cannot; Biome enforces formatting and general lint.

## Verification
tools/tigerlint.test.ts, tools/depcheck.test.ts; `pnpm check`.

## Revisit trigger
A rule proves unenforceable or causes repeated waivers.
