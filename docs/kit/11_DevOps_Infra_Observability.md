# 11 — DevOps, Infrastructure and Observability

> Principle: **boring, reproducible, small.** One cloud for the control plane, bare metal for judges, everything as code, no Kubernetes until a measured trigger.

## 1. Environments
| Env | Purpose | Data | Infra |
|---|---|---|---|
| `local` | Developer/Claude machine | synthetic seed | `docker compose` (Postgres, MinIO, Mailpit, OTel collector) + dev-mode judge container |
| `preview` | Per-PR | synthetic | Neon branch DB (vanilla Postgres features only) + ephemeral container deploy; torn down on merge/close |
| `staging` | Release candidate, load tests, ZAP | synthetic, prod-shaped | Same IaC as prod, smaller; one real bare-metal judge node with KVM |
| `prod` | Customers | real | AWS control plane + judge fleet |
Rule: **no real customer data outside prod**; staging data is generated. Config differences only via env vars parsed in `config.ts`.

## 2. Control plane on AWS (initial)
- Network: one VPC, 3 AZs, private subnets for ECS/RDS, NAT egress through a **controlled egress proxy** (webhooks/LLM/IDV), VPC endpoints for S3/KMS/Secrets Manager.
- Compute: **ECS Fargate** services `web` (Next.js standalone), `api-http`, `api-worker` (same image, `AURA_ROLE`). Autoscale on CPU + request count (+ SSE connection count). Min 2 tasks per service in prod.
- DB: **RDS PostgreSQL** (Multi-AZ, gp3, PITR 14–35 days, automated minor upgrades in a maintenance window, `rds.force_ssl=1`), parameter group reviewed (`log_min_duration_statement`, `idle_in_transaction_session_timeout`, `statement_timeout` via role defaults). **PgBouncer** (transaction pooling) only if connection counts demand it; note RLS GUCs are transaction-local so transaction pooling is safe.
- Storage: S3 buckets per purpose (bundles, artifacts, deliveries, exports, audit-WORM), versioning, block public access, SSE-KMS with separate keys, lifecycle rules, access logs.
- Secrets: Secrets Manager + KMS; ECS task roles scoped to exact secrets.
- Edge: Cloudflare (proxy, WAF managed rules, bot fight, rate limiting rules, Turnstile, caching rules per file 06) → AWS ALB (only Cloudflare IPs allowed + authenticated origin pulls).
- Email: SES with DKIM/SPF/DMARC; separate transactional vs notification streams.
- DNS & domains: `auraland.app` (app), `usercontent.auraland.app` (untrusted content, cookieless), `api` is same-origin `/api`, `status.` page external.

## 3. Judge fleet
- Provider: dedicated bare-metal with KVM and fast NVMe (Hetzner AX/OVH/Latitude class; or AWS `.metal` if procurement requires). Start with **2 nodes in 2 locations** (one primary pool, one canary/spare), scale by queue depth.
- Provisioning: `infra/judge-node/bootstrap.sh` + `cloud-init.yaml` (idempotent); immutable-image approach (Packer) is a Stage-8 improvement. Config: unattended security upgrades, node hardening (file 07 §3), install signed `aura-judge`, enroll (one-time token → mTLS cert), run self-test (escape + timing canary), then join pool.
- Network: outbound allowlist only; WireGuard/Tailscale-style mesh for operator access; no public inbound.
- Autoscaling: manual with a runbook initially; pre-scale before announced contests (scheduler computes expected load = registrations × expected submissions); later automation via provider APIs.
- Cost guard: dashboards for € per 1,000 judgments; idle-node alerts.

## 4. Infrastructure as Code
OpenTofu modules in `infra/tofu/*` (network, data, compute, edge, iam, observability). State in S3 with locking (DynamoDB or S3-native locking ⚠️VERIFY) and KMS. `tofu plan` posted on PRs; apply only from CI on main with approval. Drift detection nightly. Cloudflare rules live in code too. No console-click changes (break-glass must be audited and reconciled).

## 5. CI/CD
- GitHub Actions; reusable workflows; actions pinned by SHA; `permissions: read-all` default; OIDC to AWS (role per environment); fork PRs run with no secrets.
- Caches: pnpm store, Go build cache, Docker layers. Remote caching not needed at current size.
- Build: `web`, `api` images (distroless Node base, non-root, read-only FS), `aura-judge` static binary tarball signed with cosign; SBOM + provenance attestations.
- Deploy: staging automatically on merge; prod on manual approval; ECS rolling deploy with circuit breaker + automatic rollback on failed health checks; **DB migrations run as a separate pre-deploy job** (expand-only), contract migrations in a later release.
- Feature flags: simple DB-backed flags (`feature_flags` table, cached) with kill switches for risky features (e.g. oral defence, Tier-2 runs); flags are audited.
- Release cadence: trunk-based, small PRs, daily deploys; contest freeze windows (no deploys 2 h before/during major contests unless SEV fix).

## 6. Observability
- **Logs:** pino JSON → stdout → CloudWatch → shipped to Grafana Loki (or vendor). Required fields: `ts, level, msg, request_id, trace_id, org_hash, actor_id, module, route, status, latency_ms`. PII redaction list enforced by a test; log sampling for noisy debug.
- **Metrics (OTel → Prometheus-compatible):** RED per route; DB pool saturation; queue depth/age per queue and kind; lease expiries; verdict latency histogram; `SE` rate; scoreboard lag; SSE connections and dropped slow clients; RLS denials; assertion failures; judge node CPU/mem/temp, canary status; cost metrics.
- **Traces:** OTel spans across web → api → db → job → judge (trace context propagated in the job payload and returned in results).
- **Errors:** Sentry (web + api + worker; Go via sentry-go or logs-based) with `request_id` linkage; source maps uploaded privately.
- **Uptime/synthetics:** external probes for `/healthz`, login page, a scripted submit→verdict canary every minute (a "synthetic contestant" account in a hidden practice contest).
- **Dashboards:** one per SLO area (Contest, Judge, Exam, API, DB, Edge, Cost). **Alerts** page only on symptoms tied to SLOs or security (burn-rate alerts), everything else ticket-level.

## 7. SLOs (initial; refine with data)
| Service | SLI | SLO |
|---|---|---|
| API availability | successful (non-5xx) / total, excl. client errors | 99.9 % / 30 d |
| Verdict latency | submit → verdict p95 (warm, simple) | < 4 s for 99 % of 5-min windows |
| Contest window | scoreboard freshness ≤ 2 s and submissions accepted | 99.95 % within contest windows |
| Exam durability | acknowledged autosaves lost | 0 (hard) |
| Verification API | `/verify` success | 99.95 % |
| Judge correctness | known-answer canary mismatches | 0 |
Error budgets drive release pace: budget burned > 50 % ⇒ reliability work prioritized.

## 8. Backup, DR, business continuity
- RDS PITR + daily snapshots copied cross-region; S3 versioning + cross-region replication for bundles/deliveries/audit WORM.
- **RPO ≤ 5 min, RTO ≤ 2 h** for the control plane (documented target; test it). Quarterly **restore drill** into an isolated account, with verification queries and audit-chain verification; results logged.
- Judge fleet is stateless (SQLite spool is best-effort cache; control plane is authoritative). Losing all nodes = degraded service, not data loss.
- Region failover is a documented manual runbook initially; active-active is out of scope.
- Credential verification must survive control-plane outages: published JWKS/status lists are static files on S3+CDN with long cache and a stale-ok policy.

## 9. Operations
- On-call from the first paying customer: primary/secondary, escalation, PagerDuty/Opsgenie-class tool; runbooks linked from alerts. Weekly ops review; monthly game day (kill DB failover, expire all leases, drop a judge pool, revoke a signing key in staging).
- Change management: PR approvals as evidence; emergency changes logged and post-reviewed.
- Capacity review monthly against file 05 §4 targets; cost review monthly (budgets and alarms on AWS/Cloudflare/LLM usage).
- Status page: external, with incident templates; contest-specific status banner in-app.

## 10. Local developer experience
`pnpm i && docker compose up -d && pnpm db:migrate && pnpm seed && pnpm dev` must produce a working stack in < 10 minutes on a fresh Mac/Linux machine. `pnpm check && pnpm test` < 5 minutes locally on the changed packages. README documents it; CI tests the "fresh clone" path weekly.
