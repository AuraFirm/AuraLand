# AuraLand — instructions for Claude

AuraLand = verification & trust layer for software capability (people and AI agents).
Products: Forge (tasks/envs/evals), Exam & Contest, Arena, Passport (verifiable credentials), on one Engine (judge, sandbox, verifiers, integrity, rating).
Full context: `docs/kit/` (start with 00_START_HERE.md, 01, 02). Stage plan: `docs/kit/12`. We build ONE stage at a time; the current stage is in `docs/stages/CURRENT.md`.

## Priorities (TigerStyle): 1 Safety  2 Performance  3 Developer experience. Never trade a lower for a higher.

## Skill: always invoke `craft` first (Skill tool; copy lives in `.claude/skills/craft/`)
State assumptions, simplest thing that works, SURGICAL changes (every changed line traces to the task; report unrelated issues, don't fix them), verifiable success criteria, fail fast/loud, explain WHY in comments and commits. Build only the current stage's scope: no speculative ports, options or modules. Security rules and domain invariants override everything.

## Commands
- `pnpm i` · `pnpm dev` · `pnpm check` (biome + tsc + tigerlint + depcheck) · `pnpm test` · `pnpm test:sim [--scenario=<name> --seed=<n> --seeds=<count>]` · `pnpm build` · `pnpm db:migrate` · `pnpm audit` · `pnpm check:semgrep` (needs Docker; runs in CI too)
- Database tests need PostgreSQL 18 at `AURA_TEST_DATABASE_URL` (see README). They fail, not skip, without it.
- Definition of done: `pnpm check && pnpm test && pnpm test:sim` green, plus the stage gates in `docs/kit/12`.
- Format fixes: `pnpm format`. Tools run with Node's type stripping: `node tools/<file>.ts`.

## Stack (do not deviate without an ADR in docs/adr/)
TypeScript 7 strict everywhere; Go only for `judge/` (later stage). Node 24 LTS · Hono · Zod · PostgreSQL 18 (RLS, SKIP LOCKED queue later) · Next.js (thin renderer: NO Server Actions, NO auth in proxy.ts, NO image optimizer, NO next/og, NO ISR or `use cache`) · React · Tailwind v4 · pnpm · Biome · Vitest · esbuild (API bundle) · Better Auth, Drizzle, Radix, CodeMirror arrive with the stage that needs them.
Versions are pinned in `docs/adr/0001-stack-and-pins.md`. Deviations from the kit: `docs/adr/0006-deviations-from-kit.md`.

## Structure rules (docs/kit/04)
- `apps/api/src/modules/<m>/`: routes.ts → service.ts → rules.ts (pure) / queries.ts. Cross-module calls only via service.ts. rules.ts has NO I/O. `platform/` imports no module. `apps/web` imports only `@aura/contracts`. `@aura/db` imports only `@aura/contracts`.
- `assert` lives in `@aura/contracts/assert` (shared by api and db).
- No barrel files, no utils dumping grounds, no import cycles, no `process.env` outside `config.ts` / `*-cli.ts`.
- New top-level folder or new dependency ⇒ ADR first. `docs/adr/deps.json` lists every dependency with its ADR; `pnpm check:deps` enforces exact versions and the budget.

## Code rules (docs/kit/02) — enforced by Biome + `tools/tigerlint.ts`
- Functions ≤ 70 lines, files ≤ 600, lines ≤ 100 cols, 4-space indent. No recursion. Every loop bounded (`// unbounded: <why>` for event loops). Name every limit (constant with unit + reason).
- ≥ 2 assertions per non-trivial function (positive + negative space; pair assertions across boundaries). Assertions stay on in prod. Crash on corrupted invariants.
- No `any`, no `as` (waive with `// tigerlint-allow: no-as-cast -- <reason>` only where a library forces it), no `!`, no `@ts-ignore`, no default exports (except framework-required files), no empty catch.
- Expected failures are values (Result + closed error-code union in `@aura/contracts/errors`); unexpected are bugs.
- Inject Clock/Rng so logic is simulatable. Batch and tick; don't react per event.
- Comments explain WHY. Names: units last (`latencyMsMax`), no abbreviations, helper prefixed by its caller. JSON/SQL snake_case; TS camelCase; files kebab-case. Long CLI flags only.
- Push `if`s up, `for`s down. Positive conditions. Keep index/count/size distinct. Pass important options explicitly. Descriptive commit messages that explain why.
- SQL: tagged templates only (`sql\`...\``), never string-built; `ORDER BY` with unique tiebreaker + `LIMIT` on lists; indexes for FKs; constraints are assertions.

## Security rules (docs/kit/08) — non-negotiable
- Untrusted code runs ONLY on judge nodes in isolate/Firecracker. Never on API/web hosts. Parse untrusted archives only in the sandbox.
- Authorization server-side AND in Postgres RLS (`withRequestContext`, transaction-local settings). Every tenant table has `org_id` + RLS + a row in the RLS matrix test. Every route has an authz-matrix row.
- Parse all input with Zod `.strict()` at the boundary; size limits everywhere; never `select *` into responses; hidden tests/verifiers never serialized to clients.
- No secrets in code/logs/env files committed. No custom crypto. Credential signing keys only in KMS.
- Markdown only via `renderMarkdownSafe()`. No `dangerouslySetInnerHTML` elsewhere. Outbound HTTP only via the egress client (SSRF-safe).
- LLM output is never the sole authority; candidate text is hostile input to LLMs. Never use an "AI-text detector" as evidence.
- Telemetry only after recorded consent. Integrity flags are evidence with explanations, human-decided, appealable.

## Workflow
1. Plan first for anything non-trivial (`docs/stages/stage-N-plan.md`) and wait for approval.
2. Tests first (failing), small vertical slices (< ~400 changed lines), Conventional Commits.
3. Run checks before claiming done. Report failures/skips honestly. Never weaken a test to pass.
4. Migrations: expand → migrate → contract; reviewed SQL; RLS + matrix updated in the same PR.
5. Ask the human when requirements are ambiguous in a design-changing way, for human-owned decisions (docs/kit/15 §3), or before anything destructive. Otherwise follow the kit, state the assumption, and record an ADR.
6. Do not edit `docs/kit/`; propose changes through an ADR + patch.
7. Never run destructive commands against shared/prod infra, never force-push, never commit secrets.

## When unsure
Choose the simpler, more explicit, easier-to-verify design. Delete before you add. Make it fail loudly rather than silently.
