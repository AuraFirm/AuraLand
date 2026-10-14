# ASVS 5.0 mapping: exams, integrity, privacy (Stage 6)

Standard: OWASP ASVS 5.0.0 (ids as in the earlier matrices, with the `v5.0.0-` prefix). Wording is shortened; see the standard.
Only requirements this stage changes or newly touches are listed; the rest stand as in the earlier matrices. Statuses are what
the evidence supports today; the platform is not deployed (F1), so nothing about transport or the edge is claimed.

| ID | L | Requirement | Status | Evidence or reason |
|---|---|---|---|---|
| v5.0.0-V2.3.1 | 1 | Business logic flows run in the expected order | Met | Exam and sitting state machines are triggers plus definer functions; save, start, submit refuse out-of-order calls; the `exam-saves` simulation and `save-rules.database.test.ts` hold SQL to the pure rule |
| v5.0.0-V2.3.2 | 2 | Business limits implemented as documented | Met | Named limits (`limits.ts`): saves 60/min and 20,000 per problem, 256 KiB, telemetry 200 per batch and 400 per 10 s, 5,000 roster; tested at the limit and one over |
| v5.0.0-V2.3.3 | 2 | A business operation completes fully or rolls back | Met | One request, one transaction; model calls run outside transactions and store their result in a second one; a failed request stays `failed` with no questions |
| v5.0.0-V2.3.4 | 2 | Locking so limited resources are not double-booked | Met | `for update skip locked` in the tick batches; unique constraints for one flag per rule version, one appeal per flag, one oral defence per answer |
| v5.0.0-V2.3.5 | 3 | Multi-user approval for high-value flows | Partial | An appeal of an integrity flag needs a different reviewer than the decider (enforced in SQL). Releasing grades needs one owner or admin |
| v5.0.0-V2.4.1 | 2 | Anti-automation | Partial | Per-session save and telemetry caps; no bot challenge (F7) |
| v5.0.0-V14.2.4 | 2 | Controls for sensitive data per protection level | Partial | Retention per exam (1 to 365 days) and a purge job exist for telemetry; the data classification document is still open (F40) |
| v5.0.0-V14.2.6 | 3 | Return only the minimum sensitive data | Met | Allow-listed response schemas; the candidate never receives evidence, other people's names, scores of the model, or per-test results |
| v5.0.0-V1.2.1 | 1 | Output encoding suited to the context | Met | Candidate code and answers render as text in React; the replay and similarity pages mark ranges with `<mark>` elements built from slices, not HTML strings |
| v5.0.0-V15.2.2 | 2 | Defend against resource exhaustion | Met | Bounded batches (100 sittings a tick, 5 model calls a tick), pair caps in similarity (fingerprints held by more than 50 answers are boilerplate), replay pages of 2,000 steps; a 2,000-person run had no errors |
| v5.0.0-V16.3.2 | 2 | Failed authorization attempts are logged | Partial | Refusals (401, 403, 404) are in the request log; state changes, grading, flags, decisions, appeals, oral requests and scores are audit events; refusals are not audit events |
| v5.0.0-V16.2.5 | 2 | Logs do not contain sensitive data | Met | Audit details hold ids and counts; the oral-defence failure reason never contains code or reply text (tested) |

Access control for the new routes (function-level and object-level) is evidenced by the authz matrix and the RLS matrix tests
rather than mapped row by row here: I did not re-check those requirement numbers against the standard's text this session, and a
wrong number is worse than a missing row.

Not met or not applicable here: transport security and the edge (F33); a real LLM provider's data handling (F41); identity
proof (assurance levels above 1, never built).
