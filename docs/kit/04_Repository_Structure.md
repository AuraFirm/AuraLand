# 04 — Repository Structure and Dependency Rules

> Goal: the **smallest structure that keeps boundaries enforceable**. Four code packages, one Go module, one infra folder. No `utils/` dumping grounds, no deep nesting, no barrel-file chains, no circular imports.

## 1. Layout (final; do not add top-level folders without an ADR)

```
auraland/
├─ CLAUDE.md                  # instructions for Claude (from file 14)
├─ README.md                  # 1-screen: what, how to run, where docs are
├─ package.json               # root scripts only (dev, check, test, build)
├─ pnpm-workspace.yaml        # apps/*, packages/*
├─ pnpm-lock.yaml
├─ tsconfig.base.json
├─ biome.json
├─ apps/
│  ├─ api/                    # Hono modular monolith (+ worker entrypoint)
│  └─ web/                    # Next.js thin renderer
├─ packages/
│  ├─ contracts/              # Zod schemas, error codes, ids, limits shared across layers
│  └─ db/                     # Drizzle schema, migrations, RLS policies, typed query helpers
├─ judge/                     # Go module: agent, isolate driver, firecracker driver
├─ infra/                     # compose.yml, OpenTofu, edge rules, bootstrap scripts
├─ tools/                     # tigerlint.ts, depcheck.ts, gen-contracts.ts, seed.ts
├─ docs/
│  ├─ kit/                    # copy of Production_Details (read-only)
│  ├─ adr/                    # 0001-stack.md ... + deps.json
│  ├─ runbooks/               # incident, judge-node, restore, key-rotation
│  └─ threat-model.md
└─ tasks/                     # example & golden task bundles used by tests
```

Root has ≤ 14 visible entries (TigerStyle "uncluttered root"; raised from 12 in Stage 0, ADR 0006). The compose file lives in `infra/compose.yml`; `vitest.config.ts` sits at the root; `tasks/` is created in Stage 2 (golden tasks later move under `judge/`). Hidden config (`.github/`, `.gitignore`, `.npmrc`, `.nvmrc`, `.editorconfig`) is exempt.

## 2. `apps/api` (the modular monolith)

```
apps/api/src/
├─ main.ts                    # process entry: role = "http" | "worker" (env AURA_ROLE)
├─ app.ts                     # builds the Hono app, mounts module routers, global middleware
├─ config.ts                  # parses env with Zod ONCE; exports frozen Config
├─ platform/                  # cross-cutting adapters (ports + real implementations)
│  ├─ clock.ts  rng.ts  log.ts  otel.ts  assert.ts  result.ts
│  ├─ storage.ts              # S3 port + impl
│  ├─ mail.ts  billing.ts  llm.ts  idv.ts   # ports
│  ├─ jobs.ts                 # Postgres queue: enqueue/lease/heartbeat/complete (+fencing)
│  └─ authz.ts                # authorize(actor, action, resource)
├─ modules/
│  ├─ identity/               # users, sessions, passkeys, orgs, memberships, api keys
│  ├─ tasks/                  # task, versions, bundles, validation reports
│  ├─ judge/                  # submissions, judge jobs, verdicts, judge-node protocol endpoints
│  ├─ contests/               # contests, registrations, scoreboard, clarifications, rating
│  ├─ exams/                  # exams, sessions, telemetry, oral defence, grading
│  ├─ forge/                  # customers, orders, deliveries, licensing, evals
│  ├─ passport/               # credentials, signing, status list, verify, employer reports
│  ├─ billing/                # plans, invoices, entitlements (via BillingPort)
│  └─ admin/                  # moderation, rejudge, audit, support tools
└─ sim/                       # DST harness: fake clock/net/db faults + scenarios (test-only)
```

> The tree above is the **destination**. Per the `craft` skill (no speculative code), a module, table or `platform/` port is created **in the stage that first needs it** (file 12; file 02 §6.3). Stage 0 created only `result, clock, rng, log, config, problem` in `platform/` (`assert` lives in `@aura/contracts/assert`; OpenTelemetry and the other ports wait for their first consumer, ADR 0006).

Each `modules/<name>/` contains **at most** these files (create only what is needed):
```
routes.ts      # Hono router: parse → authorize → call service → map result. No business logic.
service.ts     # use-cases: orchestrates; owns transactions
rules.ts       # PURE functions: domain logic and state machines (no I/O)
queries.ts     # SQL for this module only (the only place that touches its tables)
limits.ts      # named constants with units and reasons
*.test.ts      # unit tests beside code; *.sim.ts for DST scenarios
```

### Import rules (enforced by `tools/tigerlint.ts` via an import graph check)
1. `routes.ts` → `service.ts` → (`rules.ts`, `queries.ts`, `platform/*`). Never the reverse.
2. A module may import another module **only through its `service.ts` public functions** (never `queries.ts` or tables of another module). Cross-module data needs go through an explicit function.
3. `rules.ts` imports nothing with I/O (no `platform/*` except types, no `db`).
4. `platform/*` imports no module.
5. `packages/contracts` imports nothing from the repo. `packages/db` imports only `contracts`.
6. `apps/web` imports **only `packages/contracts`** (types/schemas/limits). It never imports `db` or `apps/api`.
7. No circular imports (CI check). No barrel `index.ts` re-export chains (import from the file).
8. A module's tables are written only by that module (table → module ownership map lives in `docs/adr/0003-table-ownership.md`).

## 3. `packages/contracts`
```
src/
├─ ids.ts          # branded ID types + prefixes (usr_, org_, sub_, tsk_, ...) + encode/decode
├─ errors.ts       # closed error-code union + problem+json mapping
├─ limits.ts       # global limits shared by client and server (source size, page size, ...)
├─ api/            # one file per module: request/response Zod schemas + OpenAPI metadata
├─ judge-protocol.ts   # the judge-node ⇄ control-plane messages (also emits JSON Schema for Go)
├─ events.ts       # SSE event schemas (discriminated unions)
└─ credentials.ts  # VC/Open Badges claim schemas
```
Build step `tools/gen-contracts.ts` writes `packages/contracts/dist/openapi.json` and `judge/internal/protocol/*.go` (generated, committed, with a CI "no diff" check).

## 4. `packages/db`
```
src/
├─ schema/         # one file per module's tables (Drizzle)
├─ migrations/     # generated SQL, reviewed, immutable once merged
├─ rls.sql         # RLS policies as reviewed SQL, applied by migrations
├─ client.ts       # connection factory with per-request "SET LOCAL app.org_id/app.user_id/app.role"
└─ test-helpers.ts # Testcontainers bootstrap, truncation, seed
```

## 5. `apps/web`
```
src/
├─ app/                       # Next.js routes (App Router), thin; one folder per URL segment
│  ├─ (public)/               # landing, problems, profiles, /verify/[credential], pricing
│  ├─ (app)/                  # signed-in: arena, exam, forge, passport, employer, bench, settings
│  └─ api/                    # NOT used (API is Hono); only health endpoint
├─ features/                  # one folder per product area: components + hooks + queries
│  ├─ arena/ exam/ forge/ passport/ employer/ bench/ identity/
├─ ui/                        # design-system primitives (button, dialog, table, toast, chip, ...)
├─ lib/                       # api client (typed fetch), sse client, i18n, a11y helpers, telemetry
├─ styles/tokens.css          # design tokens (CSS variables)
└─ messages/                  # en.json, bn.json ...
```
Rules: `features/*` may import `ui/` and `lib/`, never each other (shared things move to `ui/` or `lib/`). No data fetching in `ui/`. Server Components only fetch via `lib/api` with forwarded cookies; no direct DB.

## 6. `judge/` (Go, one module)
```
judge/
├─ cmd/aura-judge/main.go       # entrypoint (flags, config, signal handling)
├─ internal/
│  ├─ protocol/                 # generated types + client (lease, heartbeat, complete)
│  ├─ spool/                    # SQLite outbox
│  ├─ cache/                    # content-addressed bundle cache with size cap and hash verify
│  ├─ tier1/                    # isolate driver, compile/run/check pipeline, meta parsing
│  ├─ tier2/                    # firecracker driver, vsock agent protocol, snapshots
│  ├─ assert/                   # invariant helpers
│  └─ node/                     # node health, self-test, canary, drain
├─ images/                      # language rootfs/build recipes (reproducible)
├─ go.mod  go.sum
└─ testdata/escape/             # sandbox-escape regression programs
```

## 7. `infra/`
```
infra/
├─ tofu/{network,data,compute,edge,iam,observability}/   # small OpenTofu modules
├─ edge/rules.md + cloudflare.tf                         # WAF/rate rules as code
└─ judge-node/bootstrap.sh + cloud-init.yaml + README.md
```

## 8. Naming and file conventions
- Files `kebab-case.ts`; one concept per file; tests `*.test.ts` beside the file; DST scenarios `*.sim.ts`.
- Branded IDs: `type UserId = Brand<string, "usr">`. API/public IDs are `prefix_` + UUIDv7 (text). DB columns store native `uuid`.
- Endpoints: `/api/v1/<plural-noun>[/<id>[/<sub-resource>]]`; actions that are not CRUD: `POST .../<id>:<verb>` (e.g. `POST /api/v1/submissions/{id}:rejudge`).
- Env vars `AURA_*`; parsed in `config.ts` only. No `process.env` elsewhere (tigerlint).
- Commits: Conventional Commits. One logical change per PR (<~400 changed lines excluding generated).

## 9. Scripts (root `package.json`, the only task entry points)
`dev` · `check` (biome + tsc + tigerlint + depcheck) · `test` · `test:sim` · `test:e2e` · `build` · `db:generate` · `db:migrate` · `gen` (contracts) · `audit` (supply-chain checks).
A single command, `pnpm check && pnpm test`, must be what CI runs and what a developer (or Claude) runs before declaring work done.
