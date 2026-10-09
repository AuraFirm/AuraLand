# 0001 — Stack and pinned versions
Status: accepted
Date: 2026-10-10   Deciders: founders (Stage 0 approval), implemented by Claude

## Context
docs/kit/03 chooses the stack by line, not by version, and marks several claims ⚠️VERIFY. Stage 0
must resolve what it can against primary sources and pin exact versions. Every dependency here is
at least 3 days old (`minimumReleaseAge: 4320` in pnpm-workspace.yaml).

## Decision
Pins (exact, in lockfile): Node 24.x LTS (`.nvmrc`), pnpm 12.10.1, TypeScript 7.0.2, Biome 2.5.15,
Vitest 5.0.3, esbuild 0.28.2, oxc-parser 0.153.0 (dev only), Hono 4.13.13, @hono/node-server 2.1.3,
Zod 4.6.5, pino 10.4.0, postgres (porsager) 3.4.9, Next.js 16.4.0, React 19.3.0, Tailwind 4.3.3,
PostgreSQL 18.6 (tested locally via Homebrew build).

Maturity guard events: `@hono/node-server@2.1.4` (published 2026-10-08) and `@types/node@24.19.2`
(published 2026-10-09) were rejected by the 3-day rule; we pinned 2.1.3 and 24.19.1 instead.

### ⚠️VERIFY items resolved in Stage 0
| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | TigerStyle original text | Fetched and diffed | ADR 0002 |
| 2 | Node LTS line | v24 is Active LTS until 2026-10-20, then Maintenance until 2028-04-30; v26 becomes LTS 2026-10-28. We target 24 now; move to 26 by a follow-up ADR after 2026-10-28. Local machine runs 26.11 (Current) and passes all checks | Node `Release/schedule.json`, fetched 2026-10-10 |
| 3 | PostgreSQL 18 and `uuidv7()` | `uuidv7()` works on 18.6; migration runner refuses < 18 | `migrate.test.ts` |
| 6 | Next.js advisories | 10 recent advisories listed; patched-version mapping for 16.4.0 not readable from the listing, but `pnpm audit` reports no known vulnerabilities for the lockfile | ADR 0005; `pnpm audit` 2026-10-10 |
| 7 | pnpm settings | Names verified: `minimumReleaseAge` (minutes), `blockExoticSubdeps`, `strictDepBuilds`, `trustPolicy`, `allowBuilds` (replaces `onlyBuiltDependencies`), `ignoreScripts` (camelCase). They live in `pnpm-workspace.yaml`, not `.npmrc` (kit file 14 was wrong) | pnpm.io/settings |

### Still open (not needed before their stage)
4 Drizzle (no tables yet; revisit Stage 1) · 5 Better Auth features and advisories (Stage 1) ·
8 KMS Ed25519 (Stage 7) · 9 Firecracker/jailer (Stage 8) · 10 OpenTofu state locking (infra) ·
11 Neon branching (preview envs) · 12 Radix/CodeMirror compatibility (first UI stage) ·
13 ASVS 5.0 IDs (Stage 1) · 14 Stripe entity (Stage 4) · 15 proctoring law (Stage 6).

## Alternatives considered
Pinning newer versions by waiving the maturity rule: rejected, the rule exists for supply-chain safety.

## Consequences
TypeScript 7 (native compiler) does not expose the JavaScript compiler API, which shapes ADR 0004.

## Verification
`pnpm install --frozen-lockfile`, `pnpm audit`, `pnpm audit signatures` (234 packages verified).

## Revisit trigger
Any advisory affecting a pinned package; Node 26 LTS date (2026-10-28).
