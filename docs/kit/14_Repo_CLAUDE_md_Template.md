# 14 — `CLAUDE.md` template for the new `auraland` repo

> Copy everything between the markers into `<repo>/CLAUDE.md` at Stage 0. Keep it short (it is loaded every session); the long form lives in `docs/kit/`. Update it through PRs.

<!-- BEGIN CLAUDE.md -->
```markdown
# AuraLand — instructions for Claude

AuraLand = verification & trust layer for software capability (people and AI agents).
Products: Forge (tasks/envs/evals), Exam & Contest, Arena, Passport (verifiable credentials), on one Engine (judge, sandbox, verifiers, integrity, rating).
Full context: docs/kit/ (start with 00_START_HERE.md, 01, 02). Stage plan: docs/kit/12. We build ONE stage at a time; the current stage is in docs/stages/CURRENT.md.

## Priorities (TigerStyle): 1 Safety  2 Performance  3 Developer experience. Never trade a lower for a higher.

## Skill: always invoke `craft` first (Skill tool; copy lives in .claude/skills/craft/)
State assumptions, simplest thing that works, SURGICAL changes (every changed line traces to the task; report unrelated issues, don't fix them), verifiable success criteria, fail fast/loud, explain WHY in comments and commits. Build only the current stage's scope: no speculative ports, options or modules. Security rules and domain invariants override everything.

## Commands
- `pnpm i` · `pnpm dev` · `pnpm check` (biome+tsc+tigerlint+depcheck) · `pnpm test` · `pnpm test:sim [--seed=N --scenario=name]` · `pnpm test:e2e` · `pnpm gen` (contracts→OpenAPI+Go) · `pnpm db:generate|db:migrate`
- Judge (Go): `cd judge && go test -race ./... && go vet ./... && staticcheck ./...`
- Definition of done: `pnpm check && pnpm test && pnpm test:sim` green, plus stage gates (docs/kit/12).

## Stack (do not deviate without an ADR in docs/adr/)
TypeScript strict everywhere; Go only for judge/. Node LTS · Hono · Zod · Drizzle · PostgreSQL (RLS, SKIP LOCKED queue, LISTEN/NOTIFY) · Better Auth · Next.js (thin renderer, NO Server Actions, NO auth in middleware) · React · Tailwind v4 · Radix · CodeMirror 6 · Vitest · Playwright · pnpm · Biome · OpenTofu · AWS (ECS Fargate, RDS, S3, KMS) · Cloudflare · bare-metal judges (isolate Tier-1, Firecracker Tier-2).

## Structure rules (docs/kit/04)
- apps/api modules: routes.ts → service.ts → rules.ts(pure) / queries.ts. Cross-module calls only via service.ts. rules.ts has NO I/O. platform/ imports no module. apps/web imports only packages/contracts.
- No barrel files, no utils dumping grounds, no circular imports, no process.env outside config.ts.
- New top-level folder / new dependency ⇒ ADR first.

## Code rules (docs/kit/02)
- Functions ≤ 70 lines, files ≤ 600, lines ≤ 100 cols. No recursion. Every loop bounded. Name every limit (constant with unit + reason).
- ≥ 2 assertions per non-trivial function (positive + negative space; pair assertions across boundaries). Assertions stay on in prod. Crash on corrupted invariants.
- No `any`, no `as` (except the one parse boundary), no `!`, no `@ts-ignore`, no default exports, no empty catch.
- Expected failures are values (Result + closed error-code union); unexpected are bugs.
- Inject Clock/Rng/Db/Storage/Net so logic is simulatable. Batch and tick; don't react per event.
- Comments explain WHY. Names: units last (`latency_ms_max`), no abbreviations, helper prefixed by its caller. JSON/SQL snake_case; TS camelCase. Long CLI flags only.
- Push `if`s up, `for`s down; parents branch and apply state changes, helpers compute. Positive conditions; several simple asserts over one compound. Keep index/count/size distinct. Pass important options explicitly (never rely on library defaults). Descriptive commit messages that explain why.
- SQL: parameterized only; ORDER BY with unique tiebreaker + LIMIT on lists; indexes for FKs; constraints are assertions.

## Security rules (docs/kit/08) — non-negotiable
- Untrusted code runs ONLY on judge nodes in isolate/Firecracker. Never on API/web hosts. Parse untrusted archives only in the sandbox.
- Authorization server-side AND in Postgres RLS. Every tenant table has org_id + RLS + a row in the RLS matrix test. Every route has an authz-matrix row.
- Parse all input with Zod `.strict()` at the boundary; size limits everywhere; never `select *` into responses; hidden tests/verifiers never serialized to clients.
- No secrets in code/logs/env files. No custom crypto. Credential signing keys only in KMS.
- Markdown only via renderMarkdownSafe(). No dangerouslySetInnerHTML elsewhere. Outbound HTTP only via the egress client (SSRF-safe).
- LLM output is never the sole authority; candidate text is hostile input to LLMs. Never use an "AI-text detector" as evidence.
- Telemetry only after recorded consent. Integrity flags are evidence with explanations, human-decided, appealable.

## Workflow
1. Plan first for anything non-trivial (docs/stages/stage-N-plan.md) and wait for approval.
2. Tests first (failing), small vertical slices (< ~400 changed lines), Conventional Commits.
3. Run checks before claiming done. Report failures/skips honestly. Never weaken a test to pass.
4. Migrations: expand → migrate → contract; reviewed SQL; RLS + matrix updated in the same PR.
5. Ask the human when requirements are ambiguous in a design-changing way, for human-owned decisions (docs/kit/15 §3), or before anything destructive. Otherwise follow the kit, state the assumption, and record an ADR.
6. Do not edit docs/kit/; propose changes through an ADR + patch.
7. Never run destructive commands against shared/prod infra, never force-push, never commit secrets.

## When unsure
Choose the simpler, more explicit, easier-to-verify design. Delete before you add. Make it fail loudly rather than silently.
```
<!-- END CLAUDE.md -->

## Supporting files to create at Stage 0

`.nvmrc` (Node LTS), `pnpm-workspace.yaml` holding ALL supply-chain settings (`minimumReleaseAge` in minutes, `blockExoticSubdeps`, `strictDepBuilds`, `trustPolicy`, `allowBuilds`; verified for pnpm 12: pnpm reads only auth/registry settings from `.npmrc`, and `onlyBuiltDependencies` was replaced by `allowBuilds`), `.editorconfig`, `.gitignore`, `.github/CODEOWNERS` (judge/, packages/db, infra/, modules/identity, modules/passport owned by the security reviewer), `.github/pull_request_template.md` (checklist = file 02 §5 + file 08 §14 + rollback), `docs/stages/CURRENT.md`, `docs/adr/0000-template.md`.

### ADR template
```markdown
# NNNN — Title
Status: proposed | accepted | superseded by NNNN
Date: YYYY-MM-DD   Deciders: …
## Context   (forces, constraints, links to kit files)
## Decision  (what we will do, precisely)
## Alternatives considered (and why not)
## Consequences (positive, negative, security/privacy impact, operational impact)
## Verification (how we will know it works: tests, metrics)
## Revisit trigger (measurable condition)
```
