# Stage 0 plan (as executed)

Process note: the kit asks for a plan checkpoint before code. The request was "start Stage 0 …
then proceed", which was taken as approval to proceed, so this plan was written alongside the work
rather than approved beforehand. Review it as a record, and tell us if you want the checkpoint
enforced for later stages.

## Assumptions
1. The repository lives at `AuraLand/AuraLand`, beside `Production_Details/` and `New_Plan/`.
2. "Verify the ⚠️VERIFY items" means resolving those needed by Stage 0 and deferring the rest.
3. No cloud account, domain or GitHub repository exists yet, so deployment is out of reach.
4. The developer machine has no Docker; PostgreSQL 18 is installed locally via Homebrew.

## Scope
In: repo skeleton, tooling and lint rules with tests, platform primitives, API shell, web shell,
database client with the RLS context pattern and migration runner, simulation harness, CI files,
ADRs, threat model v0. Out: any product feature, authentication, tables, cloud deployment.

## Success criteria (step → verify)
1. Tooling → `pnpm check` green; tigerlint and depcheck each fire on seeded violations in tests.
2. RLS context → cross-organization isolation and no-leak-on-reused-connection tests pass on
   PostgreSQL 18; the leak test fails when `set_config` is made session-wide.
3. API shell → health, readiness, problem+json, body limit, headers tested; built bundle runs.
4. Web shell → build succeeds; headers and per-request nonce observed on the running server.
5. Simulation → a seeded failure reproduces identically from its seed.
6. Fresh copy → install from the lockfile, check, test and simulation all pass.
7. Supply chain → exact pins, 3-day release age, no unreviewed install scripts, audit clean.

## Invariants asserted
Config valid before serving; request id charset/length; migration contiguity, checksum and
version floor; RLS context identities are lowercase UUIDs within a bound; pipeline order; limits
within bounds in the simulation runner.

## Failure modes covered
Database down (503), oversize body (413), malformed request id, unknown route, assertion failure
(process asked to stop), ordinary exception (500, process continues), modified or missing
migration, parse errors in lint input.

## Not planned here
Staging deployment, SBOM and signing, OpenTelemetry, rate limiting, browser-level CSP checks.
