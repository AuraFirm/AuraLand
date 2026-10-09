# 0006 — Deviations from the implementation kit (Stage 0)
Status: accepted
Date: 2026-10-10

| # | Kit says | Stage 0 does | Why |
|---|---|---|---|
| 1 | Repository root has at most 12 visible entries | Limit raised to 14 | The planned root also holds `judge/`, `infra/` and `vitest.config.ts`; the intent (uncluttered) holds. Compose file lives in `infra/` and golden tasks in `judge/` |
| 2 | `assert` lives in `apps/api/src/platform` | Lives in `@aura/contracts/assert` | `packages/db` needs it and may import only contracts |
| 3 | Middleware order puts the access log last | Access log is second, after the request id | In an onion model it must wrap the rest to observe the final status; same intent |
| 4 | Create `Clock`, `Rng`, `Db`, `Storage`, `Net` ports | Only `Clock` and `Rng` | Others have no consumer yet (craft: nothing speculative) |
| 5 | OpenTelemetry skeleton | Deferred | Logs carry `request_id`; add the SDK with the first multi-hop flow |
| 6 | `.npmrc` holds `ignore-scripts` and build allowlist | `pnpm-workspace.yaml` holds all supply-chain settings | pnpm reads only auth and registry settings from `.npmrc` |
| 7 | `AURA_ROLE` is `http` or `worker` | Only `http` | The worker has no jobs until Stage 3 |
| 8 | Staging deploys a hello endpoint (Stage 0 acceptance) | **Deferred** (ADR 0008) | Needs an AWS account, region and domain decisions (D1, D3, D8) and credentials |
| 9 | Testcontainers for integration tests | A PostgreSQL URL from the environment | ADR 0004 |
| 10 | `tasks/` top-level folder | Omitted until Stage 2 | No golden tasks exist yet |

## Revisit trigger
Each row is closed by the stage named in the stage report.
