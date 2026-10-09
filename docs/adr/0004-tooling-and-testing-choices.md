# 0004 — Tooling and testing choices made in Stage 0
Status: accepted
Date: 2026-10-10

## Context
Stage 0 builds the guardrails. Several kit defaults needed adjusting once checked against the
actual toolchain (TypeScript 7, pnpm 12, Node 24/26, no Docker on the first developer machine).

## Decision
1. **tigerlint parses with `oxc-parser`** (dev dependency). TypeScript 7 is the native compiler and
   its package exposes no usable JavaScript API (verified: only `version` exports). Biome plugins
   cannot express cross-file import rules. oxc-parser is a fast, maintained Rust parser with an
   ESTree-compatible JS API. Exit plan: replace the parse call only; rules operate on plain nodes.
2. **Dev and tests run TypeScript directly** with Node's type stripping (`erasableSyntaxOnly`,
   explicit `.ts` import extensions). **Production bundles with esbuild** into a single file with
   dependencies inlined, because Node refuses to strip types under `node_modules` and a workspace
   package is deployed there. Side benefit: the runtime image needs no `node_modules`.
3. **esbuild's install script is denied** (`allowBuilds: esbuild: false`). It only swaps the JS
   shim for the native binary as a speed optimization; the binary arrives via `@esbuild/*`.
4. **No Testcontainers.** Database tests read `AURA_TEST_DATABASE_URL` (PostgreSQL 18) and create a
   throwaway database per test file. CI provides a `postgres:18` service container; developers use
   `infra/compose.yml` or any PostgreSQL 18. Fewer dependencies, no Docker API client. A missing
   URL fails the run (no silent skip).
5. **Custom migration runner** (`packages/db/src/migrate.ts`, about 100 lines): contiguous numbered
   SQL files, one transaction each, SHA-256 checksums, advisory lock, refuses PostgreSQL < 18,
   refuses a database ahead of the code. Stage 1 revisits `drizzle-kit` once schema files exist.
6. **`next build` type validation is skipped** (`ignoreBuildErrors`), because it loads the
   TypeScript JS API. `pnpm check:types` (tsc 7) is mandatory in CI instead.
7. **Deferred to their first consumer** (craft: nothing speculative): OpenTelemetry SDK, the `Db`,
   `Storage` and `Net` ports, the `worker` process role, self-hosted fonts, Drizzle.

## Consequences
tigerlint depends on oxc-parser. The dev loop needs Node >= 24 (type stripping unflagged).

## Verification
tools/*.test.ts; the built API bundle was run against PostgreSQL and passed health, readiness,
error and graceful-shutdown checks.

## Revisit trigger
TypeScript ships a stable JS API; Biome gains cross-file rules; Drizzle schema work begins.
