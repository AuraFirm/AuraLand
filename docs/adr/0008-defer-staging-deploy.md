# 0008 — Defer the Stage 0 staging deploy
Status: accepted
Date: 2026-10-10   Deciders: founder (delegated to Claude to record), implemented by Claude

## Context
The kit's Stage 0 acceptance includes deploying a hello endpoint to staging. That needs an AWS
account, a region (D3), a domain (D8), a legal entity (D1) and credentials. None exist yet. Nothing
in Stage 1 depends on a deployed environment: identity, tenancy and the audit log are developed and
tested locally and in CI.

## Decision
Defer the staging deploy. Stage 0 is signed off without it, with this item tracked as open. It
becomes its own small task as soon as D1, D3 and D8 are decided (infrastructure as code with
OpenTofu, GitHub OIDC to the cloud, no static keys, SBOM and image signing at that point).

## Alternatives considered
Block Stage 1 on the deploy: rejected, it would stall product work on non-technical decisions.
Deploy somewhere throwaway: rejected, it would create infrastructure we would have to redo.

## Consequences
No live host exists to header-check, scan with a dynamic scanner, or load-test. The images are
verified locally and in CI, and run hardened under Docker. SBOM, signing and provenance wait.

## Verification
The Stage 0 report lists the item as deferred, with this ADR as the reason.

## Revisit trigger
D1, D3 and D8 decided, or the first need for a shared environment (customer demo, end-to-end tests
against a real host).
