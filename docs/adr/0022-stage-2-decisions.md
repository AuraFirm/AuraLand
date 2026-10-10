# 0022 — Stage 2 decisions (tasks and bundles)
Status: accepted
Date: 2026-10-10

## Context
Stage 2 adds tasks, versioned bundles and the safe statement renderer. The owner approved the Stage 1
report and accepted every default in `docs/stages/stage-2-plan.md` section 2 ("i approve everything
that you think to be best suited"). This record fixes those choices so later slices can cite them.

## Decision
1. **Storage:** an S3-compatible server for development and CI, the S3 API in production. The exact
   local server is chosen in the storage slice by its own ADR (licence, maintenance, image provenance).
2. **Content address:** SHA-256 of the exact uploaded bytes. The canonical-tar hash is added by the
   Stage 3 sandbox validation, because the API host must not decompress untrusted data.
3. **Size cap:** 64 MiB until a worker exists (`BUNDLE_BYTES_MAX`).
4. **Roles:** `setter` and `reviewer` join owner, admin and member; nobody reviews a version they
   created.
5. **Release before sandbox validation:** a reviewer with a fresh passkey check may release on an
   audited waiver; the version is flagged `waived` so Stage 3 can re-validate it.
6. **Statements** are stored as Markdown text in the version; the bundle carries a copy that the sandbox
   cross-checks later.
7. **Kinds:** `algorithmic` and `function`; the other three are rejected by `supportedTaskKindSchema`.
8. **Visibility:** `private` and `org` are enforced; `public` and `licensed` grant nothing extra yet.
9. **Markdown:** `markdown-it` with raw HTML off, our own allowlist over its tokens, KaTeX with
   `trust: false`.
10. **Validator:** TypeScript in a new `packages/bundle`, with a language-neutral corpus.

Additions made while writing the contracts:
- The state list gains **`uploaded`** between `draft` and `in_review` (the plan's `finalize` step); the
  kit's list had no state for "bundle verified, not yet submitted".
- A `TaskSpec` accepts only the fields Stage 2 can act on (`env` and `difficulty` from the kit's
  abridged form come with the stages that use them); `.strict()` rejects them until then.
- Each new dependency gets its own ADR in the slice that installs it, not before, so `deps.json` never
  lists a package that is not present.

## Alternatives considered
Hashing the decompressed tar on the API host (violates the untrusted-archive rule); a 512 MiB cap now
(request-time hashing too slow); accepting all five task kinds (invites half-built paths).
