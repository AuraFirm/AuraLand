# Stage 4C plan (draft): per-delivery watermarks and the leak trace

Status: **draft for your review. No 4C code starts until you approve it.** Kit: `docs/kit/12` Stage 4
("per-delivery watermarking: per-customer test-data perturbations/canary strings logged by
`watermark_id`", security gate "watermark leak-trace test"), and the 4A/4B limits below.

## 1. Where this starts
4A puts a canary line in each delivered **statement** and logs every download. 4B validates tasks.
What a customer can still do undetected is leak the **bundle** (tests, answers, reference solutions):
those bytes are the originals, identical for every customer, so a leaked bundle points at nobody
(cutlist F41). 4C makes each delivered bundle different per delivery, in ways that cannot change any
participant's verdict, and ships a tool that names the delivery a leaked file came from.

## 2. The hard part, said plainly
A perturbation of **test inputs** can change what a correct program outputs or whether it crashes
(a solution that reads by line, a parser that dislikes a trailing space). We cannot prove arbitrary
solutions are unaffected, and the customer is *evaluating models on these tests*: a perturbation that
flips one correct solution to wrong would corrupt the product. So the design carries the mark only
where a verdict **cannot** change, and checks the rest empirically:

| Carrier | Why it cannot change a verdict | Works for |
|---|---|---|
| Trailing spaces on **jury answer** lines (`tests/*.ans`) | Participants never read answers; the `tokens` and `float` checkers ignore whitespace by definition | tasks with a `tokens` or `float` checker |
| A comment line at the end of each **reference/wrong solution** (`solutions/*`) | A comment is not code; participants do not run these files | every task whose bundle has solutions |
| The statement canary (4A) | Already shipped | every task |

Tasks with an `exact` or custom checker and no solutions in the bundle get the statement canary only,
and the manifest says so per item ("watermark: statement only"). We do **not** touch input files.

## 3. Decisions I need from you (my default in bold; "defaults" accepts all)
1. **Carriers.** **Only the three above; never test inputs.** Alternative: also perturb inputs (more
   capacity and robustness, but a wrong verdict for a customer's model is possible and unprovable).
2. **Who rewrites the bundle.** **A judge node, in a box**, because parsing and rebuilding an archive is
   untrusted-input work (kit rule). New job kind `delivery.watermark` on the `validate`-style path; the
   node uploads the rewritten bundle through a short-lived, single-object, content-length-bound URL for
   exactly that delivery. Alternative: the API worker (breaks the rule; refused).
3. **Equal-verdict check.** **The node re-runs the 4B harness on the rewritten bundle** (reference and
   wrong solutions on every test) and the control plane compares verdict vectors with the original
   validation report; any difference fails the delivery build (never ships). A `development` node's
   check is labelled as such. This is evidence, not a proof for solutions we have not seen; section 2
   is why only safe carriers are used.
4. **Encoding.** **A 32-bit tag derived from `watermark_id` with a server-side key, repeated across all
   answer lines and solution files, majority-decoded**, so a partial leak (some tests, one solution)
   still decodes. Tag capacity is bounded by the number of answer lines; a bundle with fewer than 64
   answer lines and no solutions is marked "statement only". Alternative: a full 128-bit id (needs
   far more lines).
5. **Trace tool.** **`tools/trace-leak-cli.ts`**: given a leaked file or bundle it decodes the tag and
   lists matching deliveries (with the 4A download log beside them); it never decides anything, a
   person confirms. It is operator-only (platform administrators); no route exposes watermark ids.
6. **Robustness claim.** **We claim only what the leak-trace test shows:** a verbatim copy, a partial
   copy, and a copy with some files dropped decode. A leaker who normalizes whitespace erases the
   answer carrier (the solutions comment and statement canary then remain, until stripped too). The
   methodology page says so.
7. **Delivered bytes.** **The manifest lists the per-delivery bundle hash and size** (the original's
   hash stays in the audit trail and in the manifest as `source_sha256`); `verify-delivery` checks the
   delivered bytes. Storage key: `deliveries/<org>/<delivery>/<sha256>`.
8. **Calibration and agent attacks** stay out of 4C (they need a provider account); the **20-task pack
   acceptance run** from the kit is added as a scripted check in the last slice.

## 4. Work breakdown (one pull request each, tests first)
| # | Slice | Verify |
|---|---|---|
| 0 | ADR 0030; `watermark` module (pure): tag derivation, embed into answers and solutions, decode, capacity rules; property tests (round trip, partial decode, no-op when no carrier) | rules tests, fuzz |
| 1 | Bundle rewriter in TypeScript (reuses the canonical tar writer and validator), run in a box by the opener-style program; refuses anything but a validated bundle | corpus tests, real isolate on the VM |
| 2 | `delivery.watermark` job: lease, rewrite, equal-verdict re-run, upload, report; delivery state `building` | HTTP tests with signed fake nodes, real-sandbox test |
| 3 | Delivery build uses the per-delivery bundle (manifest, `source_sha256`, storage key, download key); `verify-delivery` updated | db and tool tests, browser test |
| 4 | `trace-leak-cli` and the leak-trace test (verbatim, partial, dropped files, whitespace-normalized) | tool tests |
| 5 | The 20-task pack run (scripted, on the VM), report, threat model v6, methodology text | joined-run tool extended |

Acceptance (kit): a leaked file from a delivery decodes to that delivery; deliveries to two customers
differ byte for byte in at least one carrier; no verdict differs between original and delivered bundles
on the harness; a customer verifies what they hold with the script.

## 5. Security notes
Watermark ids stay secret (never in any response); the tag key lives in configuration like the other
keys (no custom crypto: HMAC-SHA-256 from the standard library); the rewritten bundle is produced only
from a bundle that passed validation; a node may upload only for a delivery it holds a lease for; an
upload larger than the declared size, or with a different hash than the node reported, is refused; the
original bundle is never overwritten.

## 6. What this still does not do
It does not stop a leak, only names the source when the carriers survive. It does not mark inputs. It
does not prove a customer's own solver is unaffected beyond the carriers' definitions. Real customers,
payment and a deployment do not exist yet (D1, F44, F1).

## 7. Things only you can provide
The decisions above. Nothing external is needed for 4C; a production node and the sandbox review (F32)
still gate calling any delivery "validated".
