# 0003 — Table ownership
Status: accepted
Date: 2026-10-10

## Context
docs/kit/04: a module's tables are written only by that module, and other modules reach its data
through its `service.ts`.

## Decision
This file is the ownership map. Add a row in the same pull request that creates a table.

| Table | Owner | Notes |
|---|---|---|
| `schema_migrations` | `packages/db` (`migrate.ts`) | Migration ledger with SHA-256 checksums; written only by the migration runner |

No application tables exist yet. Stage 1 adds identity tables with RLS and the generated RLS matrix.

## Consequences
CI will gain a check that every table in the schema appears here (Stage 1, with the first tables).

## Revisit trigger
Module split into services.
