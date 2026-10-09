# 0007 — Semgrep with our own rules instead of CodeQL
Status: accepted
Date: 2026-10-10

## Context
The first CI run (2026-10-10) showed CodeQL analyzing all 54 TypeScript files and both workflow
files successfully, then failing to upload results: "Advanced Security must be enabled for this
repository to use code scanning." Uploading code-scanning results from a private organization
repository needs the paid GitHub Code Security feature. We want automated static analysis on every
push without a license, and the kit already lists Semgrep (docs/kit/08 section 12).

## Decision
- Run **Semgrep OSS** in CI (job `semgrep` in `ci.yml`) using the image
  `semgrep/semgrep@sha256:93963d92…` (1.179.0, published 2026-10-02, older than our 3-day rule),
  with **our own rules** in `tools/semgrep/` and metrics off. No external rule registry is fetched.
- Rules: no `sql.unsafe`, no string-built SQL, no raw HTML injection, no `eval`/`new Function`, no
  shell execution, no `Math.random`, no MD5/SHA-1, no TLS verification bypass, no direct outbound
  `fetch` outside the egress client. They mirror the bans enforced by tigerlint so a second tool
  with a different parser catches the same classes.
- Every rule has annotated positive and negative test cases, run by `semgrep --test` before each
  scan (`tools/semgrep-cli.ts`, `pnpm check:semgrep`). The same script runs locally and in CI.
- CodeQL stays in the repository as a **manual** workflow (`workflow_dispatch`) for the day the
  feature is enabled or the repository becomes public.

## Alternatives considered
Buy GitHub Code Security now (cost per active committer, deeper dataflow analysis): postponed.
Delete CodeQL: rejected, it works and costs nothing to keep ready.

## Consequences
Pattern-based rules find fewer classes of bug than CodeQL's dataflow analysis, so this is a floor,
not a replacement. Two text-pattern rules exclude `tools/tigerlint.test.ts`, whose strings contain
deliberately bad fixtures. Semgrep scans only git-tracked files, so a new file must be staged
before a local scan sees it. Running it locally needs Docker.

## Verification
`semgrep --test`: 9/9 rules pass. Full scan: 0 findings on 56 files. A deliberate `Math.random()`
in a staged throwaway file made the scan exit 1; the file was removed.

## Revisit trigger
GitHub Code Security enabled, or the repository made public: re-enable CodeQL alongside Semgrep.
