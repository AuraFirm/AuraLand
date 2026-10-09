# 0010 — Pull CI images from registries without Docker Hub's anonymous limit
Status: accepted
Date: 2026-10-10

## Context
On the Stage 0 wrap-up PR, `verify` (Postgres service container), `semgrep` (scanner image) and
`images` (Node base image) all failed, twice, with `toomanyrequests: You have reached your
unauthenticated pull rate limit`. GitHub's hosted runners share a small pool of IP addresses, so
anonymous Docker Hub pulls are throttled across many unrelated projects. The earlier green runs
were luck, not a property of our setup. Retrying did not help.

## Decision
Keep every image pinned by digest, and pull each from a registry that is not limited that way. The
digests were checked to be identical to the Docker Hub ones:
- Node and Postgres (official images): `public.ecr.aws/docker/library/<image>@sha256:…`.
- Trivy: `ghcr.io/aquasecurity/trivy@sha256:…` (the project's own registry).
- Semgrep: `mirror.gcr.io/semgrep/semgrep@sha256:…` (Google's Docker Hub mirror; no official
  alternative registry exists).
- Distroless Node already comes from `gcr.io`.

## Alternatives considered
Log in to Docker Hub in CI with a token stored as a repository secret: robust, but needs an account
and secret management for something that registries without a limit already solve. Remains the
fallback if a mirror starts failing. Caching images between runs: adds moving parts. Retrying: it
failed twice.

## Consequences
We now trust three more registries for the same content-addressed bytes. A digest pin makes the
source irrelevant to integrity: a pull whose digest differs fails. Amazon's anonymous quota and
Google's mirror have their own limits; if either bites, switch to authenticated Docker Hub.

## Verification
Pulled each reference by digest and confirmed the digest matches; rebuilt both images from the new
base, ran Semgrep (9 rules, 0 findings), Trivy (0 findings) and the compose Postgres locally.

## Revisit trigger
Any `toomanyrequests` or mirror failure in CI.

## Amendment (2026-10-10): retries and fallback sources
Google's mirror failed once with `error pulling image configuration: unknown blob` on a docs-only
pull request, even though it had worked on the two previous ones. The fallback named above was
needed sooner than expected. `tools/docker-pull.ts` now pulls each pinned scanner image with up to
3 attempts per source (2 s, then 4 s between attempts) and falls through an ordered list of
registries that serve the same digest: Semgrep from Google's mirror then Docker Hub; Trivy from
GitHub's registry, then Amazon's, then Docker Hub. A digest mismatch is impossible because Docker
verifies the pinned digest. The Node and Postgres base images in Dockerfiles and the Postgres
service container are pulled by Docker itself and keep a single Amazon source for now; if they
show the same flakiness we will add a Docker Hub login with a repository secret.
