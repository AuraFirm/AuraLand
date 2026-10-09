# 05 — Architecture and Data Model

## 1. System context

```
 Browser (Next.js UI, CodeMirror, IndexedDB drafts)
        │ HTTPS (same origin)           ┌──────────────────────────┐
        ▼                               │ Cloudflare: DNS, WAF,    │
 ┌────────────────┐   /api/*            │ rate limit, Turnstile    │
 │ Edge (CF + ALB)│────────────────────▶│                          │
 └──────┬─────────┘                     └──────────────────────────┘
        │ /          │ /api/*
        ▼            ▼
 ┌────────────┐  ┌───────────────────────────────┐        ┌──────────────┐
 │ web        │  │ api  (Hono, modular monolith) │───────▶│ PostgreSQL   │
 │ Next.js    │─▶│  role=http                    │◀───────│ (RDS, RLS)   │
 │ (SSR only) │  │  role=worker (same image)     │        └──────┬───────┘
 └────────────┘  └──────┬─────────────▲──────────┘               │ jobs table
                        │ S3 (bundles, │ outbound-only            │ (SKIP LOCKED)
                        │ artifacts)   │ mTLS lease/complete      │
                        ▼              │                          │
                 ┌────────────┐   ┌────┴────────────────────────────────┐
                 │ S3 + KMS   │   │ Judge fleet (bare metal, KVM)       │
                 └────────────┘   │  aura-judge (Go) → isolate (Tier-1) │
                                  │                  → Firecracker (T2) │
                                  │  SQLite spool (never lose a result) │
                                  └─────────────────────────────────────┘
 External: Stripe · SES · IDV vendor · LLM provider(s) · KMS · Sentry/Grafana
```

Trust zones (a compromise in a zone must not give the next one for free):
`Internet` → `Edge` → `Web (SSR, no secrets besides session forwarding)` → `API (secrets: DB, KMS, Stripe)` → `DB/S3/KMS` ; `Judge fleet` is an **untrusted-ish zone**: it holds no long-lived secrets, can only pull jobs it is authorized for, and its results are treated as *claims to be validated* (shape, bounds, fencing), not as trusted truth for anything except the verdict itself.

## 2. Process roles (one image, `AURA_ROLE`)
- `http`: serves `/api/v1/*`, SSE, judge-node protocol endpoints. Stateless; horizontally scalable.
- `worker`: runs the tick loops and job handlers: lease reaper, scoreboard tick, rating compute, mail, webhooks, credential issuance, bundle validation, retention/cleanup, outbox relay. Safe to run N instances (all coordination through Postgres leases/advisory locks).
- Tick-loop rule (TigerStyle "run at your own pace"): derived state (scoreboards, leaderboards) is recomputed by **coalesced ticks** (e.g. every 1 s per active contest), never per event.

## 3. Time, IDs, money, text
- Time: `timestamptz` in UTC; code uses injected `Clock` (`now()`: unix ms bigint-safe `number`). Monotonic deadlines (`deadline_unix_ms`) for exam/contest are computed server-side and stored; the client timer is cosmetic and re-synced with server time (`Date` header offset).
- IDs: `uuid DEFAULT uuidv7()` (time-ordered → index-friendly). Public text form `<prefix>_<uuid>`; prefixes: `usr org mem ses key tsk tsv bnd sub job nod ver con reg exm xss cre ord dlv aud`.
- Money: `amount_minor bigint` + `currency char(3)`; never floats. Tax/VAT via the billing provider.
- Text: UTF-8, NFC-normalized on write for handles/names; case-insensitive uniqueness via `citext` or lower() index; length caps in `limits.ts`.
- Randomness: `crypto.randomUUID`/`randomBytes` in prod, injected seeded `Rng` in DST.

## 4. Capacity targets (binding for design; revisit per stage)

| Dimension | Stage-5 target | Design headroom |
|---|---|---|
| Concurrent contestants in one contest | **5,000** (stretch 20,000 with CDN-cached scoreboard) | 4× |
| Peak submissions | **100/s** sustained 10 min; 1 k/s burst (queued) | 10× via queue |
| Verdict latency (Tier-1, simple problem, warm node) | **p50 < 1.5 s, p95 < 4 s** from submit to verdict | — |
| Scoreboard freshness | ≤ 2 s behind verdicts; push to clients ≤ 1 s after computation | — |
| API read p99 | < 150 ms (excluding network) | — |
| Exam: concurrent sessions per institution | **2,000**; autosave write p99 < 200 ms | 3× |
| Telemetry ingest | 20 events/s/session × 2,000 sessions = 40 k/s via batches | batch COPY |
| Judge node | ≥ 40 Tier-1 judgments/s per 16-core node (typical CP problem) | scale out nodes |
| Availability | API 99.9 % monthly; contest window 99.95 % | — |

Back-of-envelope notes for Claude: verdict path is dominated by **judge CPU time and S3/bundle cache hit rate**, not by Postgres. Postgres load during a contest ≈ submissions insert + job lease + verdict update + scoreboard tick queries; at 100 sub/s this is trivially within one modest RDS instance if every query is indexed and the scoreboard is computed in memory from a per-contest fold.

## 5. Core data model (DDL sketches — authoritative column semantics; Drizzle schema must match)

Conventions: all tables have `id uuid PK DEFAULT uuidv7()`, `created_at`, and (mutable ones) `updated_at` + `version int` for optimistic concurrency. `org_id` on every tenant-owned row. RLS enabled on all tenant tables (see §6).

```sql
-- Identity & tenancy (Better Auth owns user/session/account/passkey/verification tables;
-- we add profile and tenancy tables and never edit Better Auth's tables by hand.)
CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('personal','university','company','ai_lab','community','platform')),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  data_region text NOT NULL DEFAULT 'eu' CHECK (data_region IN ('eu','us','ap')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  org_id uuid NOT NULL REFERENCES orgs ON DELETE CASCADE,
  user_id uuid NOT NULL,                       -- FK to auth user
  role text NOT NULL CHECK (role IN ('owner','admin','instructor','setter','reviewer','analyst','member','candidate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE profiles (
  user_id uuid PRIMARY KEY,
  handle citext NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  country char(2), visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
  locale text NOT NULL DEFAULT 'en'
);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(), org_id uuid NOT NULL REFERENCES orgs,
  prefix text NOT NULL UNIQUE,                 -- first 8 chars, shown in UI
  secret_hash bytea NOT NULL,                  -- SHA-256 of high-entropy secret (not a password KDF; 256-bit random)
  scopes text[] NOT NULL, expires_at timestamptz, revoked_at timestamptz,
  last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

-- Tasks & bundles (immutable versions)
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT uuidv7(), org_id uuid NOT NULL REFERENCES orgs,
  slug citext NOT NULL, kind text NOT NULL CHECK (kind IN ('algorithmic','function','repo_env','sql','agent_env')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','org','public','licensed')),
  current_version_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE TABLE task_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7(), task_id uuid NOT NULL REFERENCES tasks, org_id uuid NOT NULL,
  seq int NOT NULL CHECK (seq >= 1), bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256)=32),
  bundle_bytes bigint NOT NULL CHECK (bundle_bytes BETWEEN 1 AND 536870912),
  spec jsonb NOT NULL,                          -- validated TaskSpec (contracts)
  state text NOT NULL CHECK (state IN ('draft','in_review','validating','validated','released','retired','rejected')),
  difficulty_est real, ungameability_score real CHECK (ungameability_score BETWEEN 0 AND 1),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);
-- A released version is immutable: enforced by trigger (UPDATE/DELETE of released rows raises).

-- Submissions & judging
CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT uuidv7(), org_id uuid NOT NULL, user_id uuid NOT NULL,
  task_version_id uuid NOT NULL REFERENCES task_versions,
  context_kind text NOT NULL CHECK (context_kind IN ('practice','contest','exam','forge_eval','validation')),
  context_id uuid,                              -- contest_id / exam_session_id / ...
  language text NOT NULL, source_sha256 bytea NOT NULL, source_bytes int NOT NULL CHECK (source_bytes BETWEEN 1 AND 262144),
  ai_mode text NOT NULL DEFAULT 'none' CHECK (ai_mode IN ('none','allowed_unlogged','allowed_logged','agent')),
  state text NOT NULL CHECK (state IN ('queued','judging','judged','failed_system','cancelled')),
  verdict text CHECK (verdict IN ('AC','WA','TLE','MLE','OLE','RTE','CE','PARTIAL','SE')),
  score numeric(9,3), judged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='judged') = (verdict IS NOT NULL))     -- pair assertion with the code path
);
CREATE INDEX ON submissions (user_id, created_at DESC);
CREATE INDEX ON submissions (context_kind, context_id, created_at);

CREATE TABLE jobs (                              -- the ONE queue
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL,                            -- 'judge.tier1','judge.tier2','mail.send','webhook.deliver','credential.issue',...
  org_id uuid, payload jsonb NOT NULL CHECK (pg_column_size(payload) <= 65536),
  queue text NOT NULL,                           -- routing key: 'judge-linux-x86', 'default', ...
  priority smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),  -- 0 = highest
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','leased','done','dead')),
  attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0), max_attempts int NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text, lease_epoch bigint NOT NULL DEFAULT 0,   -- FENCING TOKEN, increments on every lease
  lease_expires_at timestamptz,
  dedupe_key text, result jsonb, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('ready','leased');
CREATE INDEX jobs_ready ON jobs (queue, priority, run_after, id) WHERE state='ready';
CREATE INDEX jobs_expiry ON jobs (lease_expires_at) WHERE state='leased';

CREATE TABLE judge_nodes (
  id uuid PRIMARY KEY DEFAULT uuidv7(), name text NOT NULL UNIQUE, pubkey bytea NOT NULL,
  tier smallint[] NOT NULL, labels jsonb NOT NULL DEFAULT '{}', state text NOT NULL CHECK (state IN ('enrolled','active','draining','revoked')),
  agent_version text, kernel text, last_seen_at timestamptz, canary_ok_at timestamptz
);
CREATE TABLE verdict_details (                   -- per-test results; partitioned monthly later
  submission_id uuid NOT NULL, test_id text NOT NULL, verdict text NOT NULL,
  cpu_ms int NOT NULL CHECK (cpu_ms >= 0), wall_ms int NOT NULL, memory_kib int NOT NULL,
  output_hash bytea, checker_msg text CHECK (char_length(checker_msg) <= 2048),
  PRIMARY KEY (submission_id, test_id)
);

-- Contests & ratings
CREATE TABLE contests (
  id uuid PRIMARY KEY DEFAULT uuidv7(), org_id uuid NOT NULL, slug citext NOT NULL, title text NOT NULL,
  format text NOT NULL CHECK (format IN ('icpc','ioi','cf_rated','centaur','hack_verify','agent_ladder')),
  assurance_level smallint NOT NULL CHECK (assurance_level BETWEEN 0 AND 3),
  ai_policy text NOT NULL CHECK (ai_policy IN ('none','allowed_logged','agents_only')),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, freeze_at timestamptz,
  rated boolean NOT NULL DEFAULT false, state text NOT NULL CHECK (state IN ('draft','scheduled','running','frozen','ended','finalized')),
  rules jsonb NOT NULL,                          -- penalty minutes, scoring, etc. (validated)
  UNIQUE (org_id, slug), CHECK (ends_at > starts_at), CHECK (freeze_at IS NULL OR (freeze_at > starts_at AND freeze_at < ends_at))
);
CREATE TABLE contest_problems (contest_id uuid NOT NULL, label text NOT NULL, task_version_id uuid NOT NULL, points int, PRIMARY KEY (contest_id,label));
CREATE TABLE registrations (contest_id uuid NOT NULL, user_id uuid NOT NULL, team_id uuid, assurance_proof uuid, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (contest_id,user_id));
CREATE TABLE scoreboard_snapshots (contest_id uuid NOT NULL, seq bigint NOT NULL, frozen boolean NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (contest_id, seq));
CREATE TABLE rating_events (user_id uuid NOT NULL, contest_id uuid NOT NULL, dimension text NOT NULL, rank int NOT NULL, rating_before real NOT NULL, rating_after real NOT NULL, volatility real NOT NULL, PRIMARY KEY (user_id,contest_id,dimension));

-- Exams & integrity
CREATE TABLE exams (id uuid PRIMARY KEY DEFAULT uuidv7(), org_id uuid NOT NULL, title text NOT NULL, mode text NOT NULL CHECK (mode IN ('ai_free','ai_allowed_logged')),
  assurance_level smallint NOT NULL CHECK (assurance_level BETWEEN 1 AND 3), duration_s int NOT NULL CHECK (duration_s BETWEEN 300 AND 28800),
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, rubric jsonb NOT NULL, state text NOT NULL);
CREATE TABLE exam_sessions (id uuid PRIMARY KEY DEFAULT uuidv7(), exam_id uuid NOT NULL REFERENCES exams, org_id uuid NOT NULL, user_id uuid NOT NULL,
  started_at timestamptz, deadline_at timestamptz, submitted_at timestamptz, consent_at timestamptz NOT NULL, state text NOT NULL,
  integrity_score real, integrity_state text NOT NULL DEFAULT 'unreviewed' CHECK (integrity_state IN ('unreviewed','clear','needs_review','confirmed','dismissed')),
  UNIQUE (exam_id, user_id));
CREATE TABLE draft_saves (session_id uuid NOT NULL, problem_label text NOT NULL, seq int NOT NULL, content_sha256 bytea NOT NULL, content text NOT NULL CHECK (octet_length(content) <= 262144), saved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (session_id, problem_label, seq));
CREATE TABLE telemetry_events (session_id uuid NOT NULL, ts timestamptz NOT NULL, seq int NOT NULL, kind text NOT NULL, data jsonb NOT NULL CHECK (pg_column_size(data) <= 1024), PRIMARY KEY (session_id, ts, seq)) PARTITION BY RANGE (ts);
CREATE TABLE oral_defences (id uuid PRIMARY KEY DEFAULT uuidv7(), session_id uuid NOT NULL, submission_id uuid NOT NULL, questions jsonb NOT NULL, answers jsonb, score real, reviewer_id uuid, state text NOT NULL);

-- Passport
CREATE TABLE signing_keys (kid text PRIMARY KEY, kms_key_arn text NOT NULL, alg text NOT NULL CHECK (alg IN ('EdDSA','ES256')), status text NOT NULL CHECK (status IN ('active','retired','revoked')), not_before timestamptz NOT NULL, not_after timestamptz);
CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT uuidv7(), subject_user_id uuid NOT NULL, issuer_org_id uuid NOT NULL,
  kind text NOT NULL, assurance_level smallint NOT NULL CHECK (assurance_level BETWEEN 0 AND 3),
  evidence jsonb NOT NULL, ai_mode text NOT NULL, vc_jwt text NOT NULL, kid text NOT NULL REFERENCES signing_keys,
  status_index int NOT NULL UNIQUE,              -- position in the public revocation bit-list
  issued_at timestamptz NOT NULL, expires_at timestamptz, revoked_at timestamptz
);

-- Forge
CREATE TABLE customers (org_id uuid PRIMARY KEY REFERENCES orgs, plan text NOT NULL, billing_ref text, contract_ref text);
CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT uuidv7(), customer_org_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('task_pack','environment','private_eval','red_team')),
  license text NOT NULL CHECK (license IN ('non_exclusive','exclusive_time_limited','evergreen')), state text NOT NULL, spec jsonb NOT NULL);
CREATE TABLE deliveries (id uuid PRIMARY KEY DEFAULT uuidv7(), order_id uuid NOT NULL REFERENCES orders, manifest jsonb NOT NULL, manifest_sha256 bytea NOT NULL, watermark_id text NOT NULL UNIQUE, expires_at timestamptz);

-- Cross-cutting
CREATE TABLE audit_log (
  seq bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor_user_id uuid, actor_kind text NOT NULL, org_id uuid,
  action text NOT NULL, target text, ip inet, detail jsonb NOT NULL DEFAULT '{}',
  prev_hash bytea NOT NULL, hash bytea NOT NULL   -- hash = SHA-256(prev_hash || canonical(row)); verified by a nightly job
);
CREATE TABLE outbox (id uuid PRIMARY KEY DEFAULT uuidv7(), topic text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE TABLE idempotency_keys (key text NOT NULL, actor text NOT NULL, request_sha256 bytea NOT NULL, response jsonb, status int, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (actor, key));
```

The `audit_log` is append-only: `REVOKE UPDATE, DELETE`, no role has `TRUNCATE`; a trigger rejects updates; a nightly job re-verifies the hash chain and ships a chain head to S3 Object Lock (WORM).

## 6. Row-Level Security (defence in depth for tenant isolation)

- Application DB role `aura_app` is **not** a superuser and not the table owner; it has no `BYPASSRLS`. Migrations run as `aura_migrator`.
- Every request/job opens a transaction and runs `SELECT set_config('app.user_id', $1, true), set_config('app.org_ids', $2, true), set_config('app.role', $3, true)` (**`true` = transaction-local**). Pool connections therefore never leak identity.
- Policy pattern:
```sql
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;  ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_tenant ON tasks
  USING (org_id = ANY (string_to_array(current_setting('app.org_ids', true), ',')::uuid[])
         OR visibility = 'public')
  WITH CHECK (org_id = ANY (string_to_array(current_setting('app.org_ids', true), ',')::uuid[]));
```
- Cross-tenant sharing (e.g. a licensed task to a customer) is an explicit `grants` table consulted by policies, with audit entries.
- A dedicated `aura_judge_protocol` role with narrow `SECURITY DEFINER` functions handles judge-node endpoints (lease/complete) so those endpoints cannot read arbitrary tenant rows.
- **Tests:** a generated test iterates every tenant table × every operation × two orgs and asserts denial (the "RLS matrix test"). New tenant table without a policy fails CI.

## 7. State machines (implemented as pure `rules.ts` functions + DST scenarios)

**Submission:** `queued → judging → judged | failed_system(→queued, bounded retries) | cancelled`.
**Job (lease protocol):** `ready → leased(epoch n) → done | ready(on expiry or nack, attempt+1) | dead(attempt > max)`. `complete(job, epoch)` succeeds **iff** `job.lease_epoch = epoch AND state='leased'`; otherwise the result is discarded and the event logged (stale worker).
**Task version:** `draft → in_review → validating → validated → released → retired`; `rejected` from review/validating. Released ⇒ immutable.
**Contest:** `draft → scheduled → running → (frozen) → ended → finalized`; transitions are time-driven by the worker with idempotent handlers and recorded in the audit log.
**Exam session:** `invited → consented → started → submitted | expired`; autosave until `deadline_at`; late saves rejected server-side.
**Credential:** `issued → (revoked | expired)`; revocation flips a bit in the status list.

## 8. Scoreboard design (contest-day critical path)
- Source of truth: ordered log of `(submission_id, verdict, judged_at, team/user)` per contest.
- Pure fold: `rules.ts: foldScoreboard(rules, problems, events[]) → Scoreboard`. ICPC: solved count, penalty = minutes + 20 × wrong attempts before first AC; IOI: best partial score per problem; both with freeze (events after `freeze_at` hidden from public snapshot, visible to staff/own team).
- Worker tick (1 s) loads only the **delta since last seq**, applies it to an in-memory scoreboard for each running contest, writes a `scoreboard_snapshots` row **only if changed**, and publishes `seq` over `LISTEN/NOTIFY`. API instances serve the latest snapshot from a bounded in-memory cache and push over SSE. Clients receive full snapshot (compressed, ETag) then deltas by `seq`.
- Recompute-from-log test: for any contest, `fold(all events)` equals the incrementally maintained state (property test + DST).

## 9. Rating (Elo-MMR family; dimensions later)
- Pure function `rateContest(prior_ratings, standings) → new_ratings` in `contests/rules.ts`; deterministic, tested with golden vectors and property tests (monotonic in rank; sum-conservation properties where applicable).
- Run by a worker job after `finalized`; writes `rating_events`; idempotent by `(contest_id, dimension)`.
- Penalty/anti-inflation parameters are configuration with A/B evaluation, per the plan (do not hardcode the old 1.45× penalty).
- IRT difficulty/discrimination for non-contest tasks is computed offline in Stage 9+; the schema keeps `difficulty_est`.

## 10. Observability model
Every request/job has `trace_id`; logs carry `org_id` (hashed), `actor_id`, `module`, `latency_ms`. Metrics: RED per route, USE per node, queue depth/age per `queue`, verdict latency histogram, lease expiry rate, scoreboard lag, RLS denials, assertion failures (must be zero and page when non-zero).

## 11. Data lifecycle & privacy
- Retention: telemetry 180 days (configurable per institution, shorter allowed), drafts 1 year, submissions until account deletion or org policy, audit 7 years, hidden tests/verifier code per contract.
- Deletion: user deletion anonymizes profile/rating history per policy (rating events retain pseudonymous id), hard-deletes telemetry and drafts, and revokes credentials only if requested.
- Export: `GET /api/v1/me/export` produces a signed ZIP job.
- Data residency: `orgs.data_region` routes storage buckets; Postgres region split is a later stage (keep region in the model now).
