# 0025 — Object storage for task bundles
Status: accepted
Date: 2026-10-11

## Context
Stage 2 stores task bundles (up to 64 MiB) outside PostgreSQL. Browsers upload straight to storage
with presigned URLs, and the API verifies size and hash. The kit names MinIO for local development;
ADR 0022 left the choice open pending a check.

## Decision
- **Local and CI server: SeaweedFS 4.48** (Apache 2.0), image pinned by digest from
  `ghcr.io/chrislusf/seaweedfs` (a registry without Docker Hub's anonymous limit, ADR 0010). MinIO's
  community edition was archived in 2026 and no longer publishes images; Garage is AGPL with a narrower
  S3 surface; RustFS calls itself not production-ready. SeaweedFS passed our whole contract suite
  (multipart, presigned PUT with a signed content length, expiry, copy, ranged reads) unchanged.
  Its credentials in `infra/seaweedfs-s3.json` are fixed development values for this machine only.
- **Production: the AWS S3 API.** The adapter is endpoint-configurable, so staging can use real S3
  without code changes. No AWS account is needed until the first deployment.
- **Official AWS SDK v3** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, exact pins, 26
  transitive packages, past the 3-day release rule) instead of hand-rolled request signing: signing
  mistakes are security bugs, and the SDK is the reference implementation. This is the largest
  dependency tree so far; Trivy and `pnpm audit` cover it in CI.
- **A narrow port** (`platform/object-storage.ts`) with an S3 adapter and an in-memory adapter; one
  contract suite runs against both. The memory adapter is for tests and simulation only.
- **Uploads land in a staging key and are copied.** A browser uploads to `uploads/<org>/<upload id>`;
  after the server has re-read the object and checked size and SHA-256, it copies it to
  `bundles/<org>/<sha256>` and deletes the staging object. Without this, a setter who declares the hash
  of an existing bundle but sends other bytes would overwrite it before the check could refuse them.
- **The server lists the parts itself** when completing, so a client never reports part tags.
- **Part URLs sign the exact content length**, so a client cannot send a larger part than planned.
- The SDK's default checksum headers are switched to "when required": a browser cannot add the
  headers a presigned URL would otherwise demand.

## Not done here
Bucket CORS and the browser origin rules come with the upload screen (slice 7); lifecycle rules that
abort abandoned uploads are a deployment setting plus a cutlist item until the worker exists.

## Alternatives considered
MinIO (archived), Garage, RustFS, LocalStack (a heavier emulator for services we do not use),
presigning by hand with `node:crypto` (about 100 lines, but our own signing code to maintain).
