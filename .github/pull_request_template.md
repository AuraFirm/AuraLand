## What and why
<!-- The reason for the change, not a restatement of the diff. Commit messages explain why too. -->

## Checklist (docs/kit/02 section 5, docs/kit/08 section 14)
- [ ] Every changed line traces to the task; unrelated findings are listed below, not fixed here
- [ ] Failing test first; `pnpm check`, `pnpm test`, `pnpm test:sim` green
- [ ] Invariants asserted; limits named with units; errors handled (no empty catch)
- [ ] New endpoint: authz matrix row, rate-limit class, idempotency decision
- [ ] New tenant table: RLS policy and RLS matrix row; row added to docs/adr/0003
- [ ] New dependency: ADR and entry in docs/adr/deps.json
- [ ] Security gate items that apply (inputs, logging, privacy, rate limits)
- [ ] Rollback plan: feature flag or revert-safe migration

## Rollback
## Unrelated issues noticed
