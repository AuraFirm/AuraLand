# 0030 — Stage 4C decisions (per-delivery watermarks)
Status: accepted
Date: 2026-10-14

## Context
The owner accepted the defaults of `docs/stages/stage-4c-plan.md` ("pick best opinions and options; and
proceed"). A delivered bundle is today the original bytes, identical for every customer, so a leaked
bundle names nobody. Test inputs cannot be perturbed without risking a changed verdict for a customer's
model, which we cannot prove away.

## Decision
1. Carriers: trailing spaces on jury answer lines (only for `tokens` and `float` checkers, which ignore
   whitespace by definition), a comment line at the end of each file under `solutions/`, and the 4A
   statement canary. Test inputs are never touched. Tasks with none of the first two say
   "watermark: statement only" in the manifest.
2. A 32-bit tag whose top bit is always 1 (so an unmarked bundle is not mistaken for a mark; 31 bits of identity), derived on the control plane from the delivery's `watermark_id` with a server-side key
   (HMAC-SHA-256 from the standard library), is all a node ever learns; the key and the id stay home.
3. Answer carrier: every non-empty answer line of every `tests/*.ans` first loses its trailing spaces and
   tabs, then carries bit `(line number + offset of the test id) mod 32` as one trailing space (1) or
   none (0). Indexing is per file, so a partial leak still decodes the bits it holds. Used only when the
   bundle has at least 64 non-empty answer lines.
4. Solution carrier: a final line `// aura-wm:<8 hex>` (C++) or `# aura-wm:<8 hex>` (Python).
5. The rewrite happens on a judge node inside a box (parsing and rebuilding an archive is untrusted-input
   work), followed by the 4B harness on the rewritten bundle; any verdict difference from the original
   validation fails the build. Delivered bytes get their own hash; the original's hash stays as
   `source_sha256`.
6. The leak trace is an operator tool that names candidate deliveries; a person decides.
7. Claim: a verbatim copy, a partial copy and a copy with files dropped decode. A leaker who normalizes
   whitespace and strips comments erases the marks; the methodology page says so.

## Alternatives considered
Perturbing inputs (wider capacity, but an unprovable risk to the customer's results); rewriting in the
API worker (breaks the rule that untrusted archives are parsed only in a sandbox); a 128-bit tag (needs
far more answer lines than typical tasks have).
