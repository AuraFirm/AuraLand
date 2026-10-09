# 0009 — Distroless runtime images and Trivy scanning
Status: accepted
Date: 2026-10-10

## Context
The first Trivy scan of the Stage 0 images (built on `node:24-slim`) reported fixable HIGH
advisories: four in npm's bundled `brace-expansion`, `ip-address`, `tar` and `undici`
(`/usr/local/lib/node_modules/npm/…`), and seven in Debian 12 packages (perl-base). The app never
runs npm or perl, so these were unreachable, but they sat in the shipped image.

## Decision
- The runtime stage of both images is `gcr.io/distroless/nodejs24-debian13` pinned by digest, run as
  uid 65532. It has no shell, package manager or perl. The build stage keeps `node:24-slim` and is
  not shipped.
- CI scans both images and the Dockerfiles with Trivy 0.75.0 (pinned by digest) through
  `tools/trivy-cli.ts` (`pnpm check:trivy` locally). HIGH and CRITICAL findings with a fix fail the
  build; unfixed ones are ignored until a fix exists.

## Alternatives considered
Delete npm and Debian packages from the slim image: fragile, the remaining image still carries a
shell and apt. Ignore the findings with a `.trivyignore`: hides real surface. Alpine: musl
differences risk subtle Node behavior changes.

## Consequences
Smaller images (API 225 MB, web 275 MB, down from 352 and 403). No `docker exec sh` for debugging;
use a debug image variant or `docker cp` when needed. The base digest must be refreshed on a
schedule (Dependabot can do Docker digests once configured).

## Verification
Rebuilt images: Trivy reports 0 vulnerabilities on every target and the Dockerfile check passes.
Both images ran with `--read-only --cap-drop ALL --security-opt no-new-privileges`: the API
answered `/api/readyz` against PostgreSQL, the web app served the nonce CSP, and `sh` does not exist.

## Revisit trigger
A new distroless major for Node 26, or Trivy findings the base image cannot fix.
