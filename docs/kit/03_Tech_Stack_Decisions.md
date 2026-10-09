# 03 — Tech Stack Decisions

> Selection criteria, in order: **(1) battle-tested in production, (2) security track record and small attack surface, (3) convenience for a small TypeScript-first team, (4) long-term viability/portability, (5) performance.** "Fastest" is not a criterion; "predictably fast enough and boring" is.
> Versions below are *lines*, not pins. At Stage 0 look up the current stable/LTS release, verify the claims marked ⚠️VERIFY, and **pin exact versions** in the lockfile and in `docs/adr/0001-stack.md`.

## 1. The stack in one table

| Layer | Choice | Why this | Rejected (why) |
|---|---|---|---|
| **Language (≈95 %)** | **TypeScript** (7.x native compiler as of Stage 0; it exposes no JS compiler API, so tools parse with `oxc-parser`, ADR 0004), `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | One language across web, API, workers, tools; shared types/schemas; huge hiring pool; AI-assist friendly | JS (no types), Python backend (slower, weaker typing at scale), Java/Kotlin (heavier for this team) |
| **Language (judge agent)** | **Go** (current stable) | Static binary, great concurrency/syscall story, mature Firecracker/containerd/seccomp ecosystem, easy to audit; the per-node daemon is small | Rust (excellent but slower to iterate; reconsider for a future microVM VMM shim), C++ (memory-unsafe), TS (poor for syscalls/cgroups) |
| **Sandbox Tier-1** | **`isolate`** (IOI sandbox) + cgroups v2 + seccomp, driven by the Go agent | The de-facto standard in IOI/Codeforces-class judges; proven | Docker-per-submission (slow, large attack surface), nsjail (fine alternative; keep as fallback) |
| **Sandbox Tier-2** | **Firecracker microVMs** (+ `jailer`), KVM on bare metal; gVisor as a documented fallback for non-KVM hosts | Hardware-isolated kernel per run; the model used by AWS Lambda/Fargate and many agent-sandbox vendors | gVisor-only (userspace kernel on a shared host kernel; larger kernel-exploit exposure), containers-only |
| **Runtime (TS)** | **Node.js current Active LTS** (⚠️VERIFY: 24.x LTS; 26.x enters LTS around Oct 2026) | Most compatible, longest support, best security response; native TS type-stripping removes a build step for dev; Hono runs unchanged on Bun/Deno later | Bun (promising, ~98 % compat and real-world DB-bound gains are small; revisit), Deno |
| **HTTP framework (API)** | **Hono** + `@hono/zod-openapi` (or equivalent) | Tiny, web-standard APIs, typed RPC client, portable across runtimes; OpenAPI emitted from the same Zod schemas | Express (maintenance mode), Fastify (good; heavier plugin model), NestJS (too much magic), tRPC (internal-only typing, no public API story) |
| **Validation/contracts** | **Zod 4** (single source of truth), JSON Schema emitted from it for Go codegen and OpenAPI | One library for runtime validation + types + docs | Valibot (fine, smaller; Zod's ecosystem wins), io-ts, ajv (second system) |
| **Database (remote)** | **PostgreSQL 18** (⚠️VERIFY latest stable major; do not adopt a new major before its .1+) | Native `uuidv7()`, RLS, partitioning, `SKIP LOCKED`, `LISTEN/NOTIFY`, JSONB, FTS, `pg_trgm`, `pgvector`: one engine does OLTP+queue+search+vector at our scale | MySQL, MongoDB, DynamoDB, separate queue/search/vector stores (premature) |
| **ORM/query** | **Drizzle ORM** (+ `drizzle-kit` for SQL migrations, reviewed) with raw `sql` for hot paths | SQL-first, typed, no codegen step, thin | Prisma (heavier engine, less SQL control), Kysely (good alt), TypeORM |
| **DB driver** | **`postgres` (porsager)** or `pg` ⚠️VERIFY; pick one | Mature, prepared statements, pipelining | — |
| **Local DB (dev/test)** | Postgres of the **identical major** (compose locally, a `postgres:18` service container in CI) reached through `AURA_TEST_DATABASE_URL`; each test file creates a throwaway database. **No Testcontainers** (ADR 0004) | Dev/prod parity | SQLite as stand-in for Postgres (behavior drift) |
| **Local DB (judge node)** | **SQLite (WAL)** via `modernc.org/sqlite` (pure Go) as the agent's durable **outbox/spool** | A result is never lost if the control plane is unreachable | Embedded KV (bbolt) is fine; SQLite is more inspectable |
| **Client local storage** | **IndexedDB** (via `idb`) for exam drafts/offline buffer; nothing sensitive in `localStorage` | Survives refresh/crash | localStorage (sync, small, XSS-exposed) |
| **Object storage** | **S3-compatible** (AWS S3 in prod, MinIO locally); content-addressed keys; SSE-KMS | Boring, durable | Self-managed disks |
| **Queue/jobs** | **Postgres table + `FOR UPDATE SKIP LOCKED`**, our own ~300-line module with leases + fencing tokens (judge jobs and general jobs share it) | Transactional enqueue with the business write; no extra system; judge needs custom lease semantics anyway | Redis/BullMQ (second durable system), pg-boss (generic; policy sharp edges reported), NATS JetStream (**revisit trigger** below), Kafka (overkill) |
| **Realtime** | **Server-Sent Events (SSE)** for scoreboards, verdict streams, notifications; fan-out by snapshot-per-tick | One-way push fits ours; plain HTTP, proxy/CDN-friendly, auto-reconnect with `Last-Event-ID` | WebSockets (stateful, more attack surface; only if a true bidirectional need appears) |
| **Cache / rate limit** | In-process LRU (bounded) + Postgres + **Cloudflare** edge; **Valkey** only after a measured trigger | Fewer moving parts | Redis from day 1 |
| **Search** | Postgres FTS + `pg_trgm` (+ `pgvector` for similarity/dedup) | Enough for years | Elasticsearch/Typesense (later trigger) |
| **Analytics/telemetry store** | Postgres partitioned tables (by day) at first; **ClickHouse** at trigger | Keep one engine until volume forces change | Kafka+warehouse early |
| **Web framework** | **Next.js (App Router) as a *thin renderer***, pinned and promptly patched; **no Server Actions, no middleware-based auth, no image optimizer** (details §3) ⚠️VERIFY | SSR/SEO for public pages (problems, profiles, `/verify`), huge ecosystem/hiring, mature RSC | TanStack Start (promising; younger RSC; revisit at Stage 9), SvelteKit/Remix (smaller talent pool), pure SPA (poor SEO for public pages) |
| **UI** | **React 19**, **Tailwind CSS v4**, **Radix UI primitives** (shadcn/ui-style copy-in components), **lucide** icons, `motion` (sparingly) | Accessible primitives, tokens, no heavy component library | MUI/Chakra (heavy), CSS-in-JS runtime |
| **Server state (client)** | **TanStack Query** | Caching, retries, optimistic updates | SWR (ok), Redux (not needed) |
| **Code editor** | **CodeMirror 6** | Small, accessible, mobile-capable, easy to hook paste/edit telemetry | Monaco (large, heavy; mobile-poor) |
| **Math/markdown** | `markdown-it` (or `micromark`) + **KaTeX**, sanitized with a strict allowlist | Statements with formulas | MathJax (heavy) |
| **Auth** | **Better Auth** (passkeys/WebAuthn, OAuth, TOTP, org plugin) on our Postgres ⚠️VERIFY features and security history; DB-backed sessions | Successor ecosystem to Lucia/Auth.js; passkey-first; self-hosted so identity data stays ours | Lucia (unmaintained), Auth.js (passkeys experimental), Clerk/Auth0 (cost/lock-in; keep as swap-in `AuthPort` for enterprise SSO, e.g. WorkOS) |
| **Authorization** | In-house **RBAC + resource policies** in TS (`authorize(actor, action, resource)`), enforced again by **Postgres RLS** | Small, auditable, DB-enforced | Cedar/OpenFGA (revisit when policies exceed ~50 rules) |
| **Credentials** | **W3C VC / Open Badges 3.0 as VC-JWT** (`jose`, EdDSA/ES256), `did:web` issuer, keys in **AWS KMS** ⚠️VERIFY algorithm support; Data Integrity (`eddsa-rdfc-2022`) later if buyers require | JWT proofs are simpler and battle-tested; OB3 permits them | Rolling our own format |
| **Payments** | **Stripe** (Billing + Invoicing) via a `BillingPort`; evaluate a Merchant-of-Record (Paddle/Polar) if entity/tax constraints demand (see file 15) | Standard | Custom billing |
| **Email** | **Amazon SES** (or Resend) via `MailPort`; React-Email templates | Cheap, reliable | Self-hosted SMTP |
| **ID verification** | Vendor behind `IdentityVerifier` port (Persona/Veriff/Stripe Identity: pick at Stage 7) | Never build IDV | In-house |
| **LLM access** | One `LlmProvider` port (Anthropic first, others pluggable); prompts versioned in repo; every call logged (redacted) with cost | Avoid vendor lock-in; auditable | Scattered SDK calls |
| **Hosting (control plane)** | **AWS**: ECS Fargate (web/api/worker), RDS PostgreSQL (Multi-AZ, PITR), S3, KMS, SES, Secrets Manager, CloudFront/**Cloudflare** in front | Compliance story (SOC 2), managed durability, no Kubernetes tax | Kubernetes early, serverless-only (cold starts, vendor quirks) |
| **Hosting (judge fleet)** | **Dedicated bare-metal** (Hetzner/OVH/Latitude-class, or AWS `.metal`) with KVM; outbound-only to the control plane over mTLS/WireGuard | Determinism (pinned cores, no noisy neighbor), KVM, cost | Shared cloud VMs for timing-critical judging |
| **Dev/staging DB** | **Neon** branches for previews and staging ⚠️(vanilla-Postgres features only so prod stays portable) | Instant DB branch per PR | Shared dev DB |
| **IaC** | **OpenTofu** (Terraform-compatible) in `infra/`; no Terraform Cloud lock-in | Battle-tested | Pulumi/SST (fine; second language ecosystem) |
| **CI/CD** | **GitHub Actions** with OIDC to AWS (no static cloud keys) | Standard | — |
| **Observability** | **OpenTelemetry** SDK → Grafana Cloud (or self-hosted LGTM later); **pino** JSON logs; **Sentry** for errors | Vendor-neutral signals | Proprietary agents |
| **Edge/WAF** | **Cloudflare** (DNS, WAF, rate limiting, bot management, Turnstile) | Contest-day DDoS/absorb | — |
| **Package manager** | **pnpm** (workspaces) with `minimumReleaseAge`, `onlyBuiltDependencies`, frozen lockfile, `ignore-scripts` by default ⚠️VERIFY settings | Supply-chain controls | npm/yarn without those controls |
| **Lint/format** | **Biome** + `tsc --noEmit` + `tools/tigerlint.ts` | One fast tool | ESLint+Prettier sprawl |
| **Tests** | **Vitest** (+ `fast-check`), **Playwright**, **k6** (load), Go `testing`+fuzz, custom **DST harness** | Standard + TigerBeetle-style simulation | Jest |
| **Security tooling** | Semgrep, gitleaks, osv-scanner, Trivy, CodeQL, OWASP ZAP baseline, `govulncheck`, Socket/`npm audit signatures` | Layered | — |

## 2. Why this shape (architecture-level rationale)

- **Modular monolith, not microservices.** One deployable TS service (`apps/api`) with strict internal module boundaries, plus a `worker` role of the same image, plus the Go judge agent. Fewer network hops, one transaction boundary, trivial local dev. Modules can be split out later only if a measured trigger fires.
- **Postgres as the system of record and the queue.** The most valuable property is **transactional enqueue**: "create submission + enqueue judge job" is one commit. No dual-write bug class.
- **Outbound-only judge nodes.** Judge hosts pull work; the control plane never connects in. Compromised judge → no inbound path to pivot, smaller blast radius.
- **Pull + lease + fencing** gives exactly-once *effects* on at-least-once delivery.
- **Same-origin API** (`/api/*` routed by the edge to Hono; everything else to Next.js) → `__Host-` cookies, SameSite=Lax, no CORS surface, simple CSRF story.
- **Contracts first.** `packages/contracts` (Zod) → OpenAPI for public customers → generated Go types for the agent. One definition, three consumers.

## 3. Next.js hardening rules (because the framework had serious 2026 advisories)

Public records in 2026 include XSS, DoS in Server Actions, and an auth-bypass of middleware-based authentication in specific configurations (⚠️VERIFY on the Next.js security advisories page). Therefore:

1. Next.js renders UI only. **All business data and auth enforcement live in the Hono API and Postgres.** A bypass of Next.js middleware must not expose data.
2. **No Server Actions.** Mutations call the API (`fetch` to `/api/v1/...`) from client components via TanStack Query.
3. **No auth in `middleware.ts`.** Middleware may only do cosmetic redirects and security headers.
4. Image optimizer off (`images.unoptimized: true`) or served from a separate static origin; no remote image patterns from user input.
5. Self-host in a container (`output: 'standalone'`); never expose Next's internal endpoints to untrusted headers (strip `x-middleware-*`, `x-nextjs-*` at the edge).
6. CSP with per-request nonces **and** cache rules that never cache nonce-bearing HTML at shared caches.
7. Subscribe to Next.js security advisories; patch within **72 hours** for high/critical (CI job fails when a known-vulnerable version is in the lockfile).
8. Keep the front end portable: no Next-specific APIs in feature code beyond routing/metadata, so a move to TanStack Start/Vite stays a bounded task.

## 4. Dependency budget (enforced by ADR)

Target direct runtime dependencies (excluding devDependencies):
- `apps/api`: ≤ **25** (hono, zod, drizzle-orm, postgres driver, better-auth, jose, pino, otel packages, markdown-it/katex/sanitizer, AWS SDK v3 clients (s3, kms, ses), stripe).
- `apps/web`: ≤ **30** (next, react, tailwind, radix subset, tanstack-query, codemirror packages, lucide, motion, next-intl/lingui, zod via contracts).
- `packages/contracts`: ≤ **3** (zod, plus tiny utils).
- `packages/db`: ≤ **4**.
- `judge/` (Go): stdlib + ≤ **8** modules (sqlite, firecracker SDK or direct API client, cgroups helper, otel).

`tools/depcheck.ts` fails CI if a package.json adds a direct dependency not listed in `docs/adr/deps.json` with an ADR link.

## 5. Revisit triggers (when we *are allowed* to change the choice)

| Trigger (measured) | Change |
|---|---|
| Judge/general queue sustained > ~2–3 k jobs/s, or Postgres vacuum pressure from queue churn | Move **queue transport** to NATS JetStream (keep Postgres as source of truth for state) |
| Read-heavy scoreboard/profile traffic p99 breached after caching | Add read replica, then Valkey |
| Telemetry rows > ~2 B or analytic queries > 5 s | Add ClickHouse for telemetry/analytics |
| Search relevance/latency complaints at > ~5 M documents | Typesense/Meilisearch |
| WebSocket-only need (collaborative editing, live pair-exam) | Add WS for that feature only |
| Judge CPU-timing variance > 3 % on equal hardware | Re-evaluate isolation config, then hardware |
| Next.js advisory cadence unacceptable, or RSC maturity of TanStack Start proven | Re-evaluate web framework (Stage 9 review) |
| Customer demands SAML/SCIM at volume | Add WorkOS (or similar) behind `AuthPort` |
| Team > 15 engineers or independent scaling pain per module | Extract one module as a service |

## 6. Local development parity

`docker compose up` brings: Postgres (same major), MinIO (S3), Mailpit (SMTP), an OTel collector, and (Linux only) an optional judge-agent container in "dev mode" (isolate without Firecracker). `pnpm dev` runs web+api+worker. macOS developers use the dev-mode judge in a Linux container; real judge tests run in CI on Linux runners and on the staging bare-metal node.
