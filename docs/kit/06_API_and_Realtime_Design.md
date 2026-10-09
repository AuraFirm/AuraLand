# 06 — API, Contracts and Realtime Design

## 1. Principles
- **One style:** JSON over HTTPS, resource-oriented REST at `/api/v1`, OpenAPI 3.1 generated from Zod schemas. No GraphQL, no gRPC (the judge protocol is plain HTTPS+JSON with generated types).
- **Same origin** for the web app (`/api/*` routed by the edge). Public/customer API uses the same routes with bearer API keys.
- **Contract-first:** schemas in `packages/contracts/src/api/*.ts`. Handlers receive parsed, typed, branded values. Responses are validated against the response schema in tests (and in dev builds) to catch drift.
- **Every endpoint** declares: auth requirement, required role/permission, rate-limit class, idempotency requirement, request/response schema, error codes, max body size.

## 2. Conventions
| Topic | Rule |
|---|---|
| Field naming | `snake_case` JSON; IDs as prefixed strings (`sub_…`); timestamps RFC 3339 UTC; durations as integer `*_ms`/`*_s`; money `{amount_minor, currency}` |
| Errors | RFC 9457 `application/problem+json`: `{type, title, status, code, detail?, request_id, errors?[]}`; `code` from the closed union in `errors.ts`; never leak stack traces, SQL, or internal IDs |
| Pagination | Cursor-based: `?limit=` (default 25, max 100) & `?cursor=` (opaque, signed); stable order with unique tiebreaker; response `{items, next_cursor}` |
| Filtering/sorting | Explicit allowlisted params only; no arbitrary field expressions |
| Idempotency | `Idempotency-Key` header **required** on POSTs that create money-, credential-, or judge-affecting resources; stored 24 h in `idempotency_keys` with request hash; mismatch → 422 |
| Concurrency | Mutable resources return `ETag`/`version`; `PUT/PATCH` require `If-Match`; mismatch → 412 |
| Bulk | Max 100 items per bulk call, all-or-nothing per transaction |
| Methods | `GET` safe & cacheable; `POST` create/action; `PATCH` partial update; `DELETE` idempotent; actions as `POST /x/{id}:verb` |
| Versioning | URL major (`/v1`); additive changes only inside a major; deprecations announced with `Deprecation`/`Sunset` headers ≥ 6 months for the public API |
| Body limits | Default 256 KiB JSON; source-code endpoints 320 KiB; bundle upload via presigned S3 (multipart, ≤ 512 MiB), never through the API |
| Compression | brotli/gzip at the edge |
| Caching | Public immutable content (`/tasks/{id}/versions/{n}/statement`) `Cache-Control: public, max-age=31536000, immutable` keyed by hash; private data `no-store` |
| Time source | Server time only; `Date` header lets clients compute offset |

## 3. Request pipeline (Hono middleware order — fixed)
1. `requestId` (accept inbound `X-Request-Id` only from edge; else generate) → 2. `accessLog` (wraps the rest to see the final status; implemented in Stage 0) → 3. `securityHeaders` → 4. `bodyLimit` → 5. `rateLimit(class)` → 6. `authenticate` (session cookie **or** API key **or** judge-node mTLS identity; mutually exclusive per route group) → 6. `csrf` (for cookie-authenticated unsafe methods: Origin/`Sec-Fetch-Site` check + custom header) → 7. `dbContext` (opens tx, sets RLS GUCs) → 8. route: `parse(schema)` → `authorize()` → service → `serialize(schema)` → 9. `errorMapper` → 10. access log + metrics.
Order is asserted at startup by a test that inspects the registered middleware list.

## 4. Representative endpoint catalogue (initial; extend per stage)

**Identity (S1)** — `POST /auth/*` handled by Better Auth mounted at `/api/auth/*`; `GET /api/v1/me`, `PATCH /api/v1/me/profile`, `GET /api/v1/orgs`, `POST /api/v1/orgs`, `POST /api/v1/orgs/{id}/members`, `POST /api/v1/orgs/{id}/api-keys`, `DELETE /api/v1/api-keys/{id}`, `GET /api/v1/me/export`, `DELETE /api/v1/me`.

**Tasks (S2)** — `POST /api/v1/tasks`, `GET /api/v1/tasks?org=&kind=`, `POST /api/v1/tasks/{id}/versions` (returns presigned upload URL), `POST /api/v1/task-versions/{id}:finalize` (server verifies hash/size, enqueues validation), `POST /api/v1/task-versions/{id}:submit-review`, `:release`, `:retire`, `GET /api/v1/task-versions/{id}/validation-report`.

**Judge/submissions (S3)** — `POST /api/v1/submissions` (idempotent; body: `task_version_id`, `language`, `source`, `context`), `GET /api/v1/submissions/{id}`, `GET /api/v1/submissions/{id}/stream` (SSE), `POST /api/v1/submissions/{id}:rejudge` (admin/setter).
**Judge-node protocol** (mTLS; separate router `/judge/v1`): `POST /judge/v1/enroll`, `POST /judge/v1/lease`, `POST /judge/v1/jobs/{id}/heartbeat`, `POST /judge/v1/jobs/{id}/complete`, `POST /judge/v1/jobs/{id}/fail`, `POST /judge/v1/node/heartbeat`, `GET /judge/v1/bundles/{sha256}` (302 to presigned S3 URL scoped to this job).

**Contests (S5)** — CRUD `/api/v1/contests`, `POST /contests/{id}/registrations`, `GET /contests/{id}/scoreboard` (ETag, snapshot), `GET /contests/{id}/stream` (SSE), `POST/GET /contests/{id}/clarifications`, `GET /contests/{id}/standings.icpc.json` (ICPC-tools-compatible export), `GET /api/v1/users/{handle}/ratings`.

**Forge (S4)** — `/api/v1/forge/orders`, `/forge/orders/{id}/deliveries`, `GET /forge/deliveries/{id}/manifest`, `GET /forge/deliveries/{id}/files/{path}` (short-lived signed URLs, watermark id logged), `/forge/evals` (private evals CRUD + run), `GET /forge/tasks/{id}/ungameability`.

**Exams (S6)** — `/api/v1/exams`, `POST /exams/{id}/roster` (CSV via upload job), `POST /exam-sessions/{id}:consent`, `:start`, `PUT /exam-sessions/{id}/drafts/{label}` (seq-versioned), `POST /exam-sessions/{id}/telemetry` (batched), `POST /exam-sessions/{id}:submit`, `GET /exam-sessions/{id}/replay`, `/oral-defences/{id}` (answer), instructor review endpoints; **LTI 1.3** launch endpoints (`/lti/login`, `/lti/launch`, JWKS) in Stage 6.

**Passport (S7)** — `GET /api/v1/me/credentials`, `POST /api/v1/credentials/{id}:share` (selective-disclosure link), **public**: `GET /verify/{credential_id}` (HTML), `GET /api/v1/public/credentials/{id}` (JSON VC), `GET /.well-known/did.json`, `GET /api/v1/public/status-lists/{n}`; employer: `/api/v1/employer/candidates`, `/employer/reports/{id}`.

**Billing (S9)** — `/api/v1/billing/portal-session`, Stripe webhooks at `/webhooks/stripe` (signature verified, replay window 5 min, idempotent by event id).

## 5. Outbound webhooks (for customers)
- Subscriptions per org; events: `submission.judged`, `delivery.ready`, `exam.session.submitted`, `credential.issued`, etc.
- Payload signed `X-Aura-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t.body)>`; consumers must reject `|now-t| > 5 min`. Retries exponential up to 24 h then dead-letter. Secrets rotatable with dual-valid period.
- **SSRF defence:** webhook targets resolved server-side, blocked if private/link-local/loopback/metadata IPs after resolution **and** again at connect time (DNS-rebinding safe), only `https`, port allowlist 443/8443, 5 s connect / 10 s total timeout, response body capped at 64 KiB, no redirects followed. Egress goes through a dedicated egress proxy with an allow/deny policy.

## 6. Realtime (SSE)
**Endpoints:** `/contests/{id}/stream`, `/submissions/{id}/stream`, `/me/notifications/stream`, `/exam-sessions/{id}/stream` (timer sync, instructor messages).
**Format:** `id: <seq>`, `event: <type>`, `data: <json validated by contracts/events.ts>`; `retry: 3000`. A comment heartbeat `: ping` every 15 s (survives proxies).
**Resume:** client sends `Last-Event-ID`; server replays from a bounded ring buffer (max 1,000 events / 2 min per stream) or sends `event: resync` instructing the client to refetch the snapshot.
**Fan-out design (TigerStyle: batch, don't react per event):**
1. Worker publishes `NOTIFY aura_events, '<stream>:<seq>'` after a snapshot commit.
2. Each API instance keeps **one** `LISTEN` connection, updates a bounded in-memory `latest[stream]` and wakes subscribers.
3. A subscriber loop writes the **already-serialized, shared byte buffer** to each connected response (no per-client JSON encoding).
4. Slow clients: per-connection write buffer cap 64 KiB; exceeding it closes the stream (client reconnects/resyncs). Per-instance connection cap and per-user cap (3). Shed load by refusing new streams with 503 + `Retry-After` before degrading existing ones.
**Auth:** same cookie/API-key auth as REST; the stream path re-authorizes on every reconnect, and long-lived streams are closed after 30 min to force re-auth (client auto-reconnects).
**CDN:** public scoreboard snapshot is also fetchable as a cacheable GET with `s-maxage=1, stale-while-revalidate=2`, so huge audiences hit the edge, not the API.

## 7. Judge-node protocol details (summary; full spec in file 07)
- **Pull model:** `lease` is a long-poll (≤ 25 s). Response includes `job_id`, `lease_epoch`, `lease_ttl_s`, `task` (bundle sha256 + size), `submission` (source via short-lived URL or inline ≤ 64 KiB), `limits`, `profile`.
- **Heartbeat** every `ttl/3`; missing 3 → job returns to `ready` (attempt+1) and `lease_epoch` increments on next lease.
- **Complete** carries `lease_epoch`; server enforces `epoch == current` in the same SQL statement (`UPDATE ... WHERE id=$1 AND lease_epoch=$2 AND state='leased'`).
- All messages are validated by generated JSON-Schema-derived types on both sides; unknown fields are rejected.

## 8. Rate-limit classes
| Class | Limit (per actor, per window) | Notes |
|---|---|---|
| `auth` | 10/min/IP and 5/min/account on login/reset | plus Turnstile after 3 failures; account lockout is **soft** (step-up) to avoid DoS-by-lockout |
| `submit` | 6/min/user/problem practice; contest rules override (e.g. 1 per 10 s) | also queue-depth based load shedding |
| `read` | 600/min/user, 120/min/IP anon | |
| `write` | 120/min/user | |
| `export` | 3/day/user | heavy jobs |
| `apikey` | per-key plan quota | headers `RateLimit-*` per IETF draft |
Edge (Cloudflare) enforces coarse per-IP limits; the app enforces per-actor limits using an in-memory token bucket per instance **plus** a Postgres-backed counter for the strict classes (`auth`, `export`). Revisit with Valkey only when the trigger in file 03 fires.

## 9. Public API product notes (Forge & Passport customers)
- API keys scoped (`forge:read`, `deliveries:read`, `passport:verify`), org-bound, hashed at rest, shown once, rotation without downtime (two active keys).
- Sandbox/test mode keys that return synthetic data.
- OpenAPI spec published at `/api/v1/openapi.json` and a rendered reference at `/developers`; SDK generation (TS first) from the spec in a later stage.
- Verification API (`passport:verify`) is cacheable and has the highest availability target; it must work even if the main DB is degraded by serving signed JWTs + a cached status list (the credential is verifiable **offline**).
