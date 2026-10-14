# Stage 6 plan (draft): exams and integrity

Status: **draft for your review. No Stage 6 code starts until you approve it** ("defaults" accepts every default
below). Kit: `docs/kit/12` Stage 6, `05` (exam tables, session state machine, retention), `06` (realtime),
`08` sections 8 to 10 (privacy, no AI-text detector, LLM security), `09` (exam client), `10` (exam DST, 2,000-session load).

## 1. Where this starts
Stage 5 is built. Reusable: the injected-clock and definer-function pattern (contest submissions), per-test result
hiding until an end time, the scoreboard-style stored snapshots, rejudge, clarifications, the load harness, the
simulation harness, the sandbox (C, C++, Java, Python). **Nothing exam-shaped exists**: no exams, rosters,
consent, telemetry, similarity, `LlmProvider` or LTI.

## 2. Honest limits of this stage
- The kit's acceptance includes a **pilot with a real course**, **LTI 1.3 against a real LMS**, a **2,000-session
  load test**, and a **screen-reader accessibility audit**. None can be done by building alone: they need a real
  institution (D-tasks), an LMS sandbox, a deployment (F1) and a human auditor. I will deliver the logic under
  simulation, a **scaled** local load run reported as such, automated accessibility checks (axe) and the checklist for the human audit.
- **Oral defence needs an LLM provider account** (none exists, F41). I build the port, the strict schemas, a recorded
  fake provider for tests and the reviewer flow; real questions need your key. The LLM is never the sole authority.
- **No webcam proctoring, no lockdown browser** (kit: L2 later). SEB gets a design note, not an integration.
- **An integrity flag is evidence with an explanation, decided by a human, appealable.** No "AI-text detector"
  anywhere, ever (kit 08).
- Judge evidence is still one development VM (F32); an exam on it is not a real exam.

## 3. Decisions I need from you (my default in bold)
1. **Scope order.** **Build the core first (exams, rosters by CSV, consent, session with server timer and
   no-lost-save autosave, grading with rubric/partial credit, grade export), then telemetry and replay, then
   similarity, then oral defence and appeals.** LTI 1.3 launch and SEB spike last, only if time. Alternative: LTI earlier.
2. **Rosters.** **CSV upload (email, name, optional accommodation minutes) validated and capped; people without an account get an
   invitation by the existing invitation flow.** No LMS sync.
3. **Modes.** **`ai_free` and `ai_allowed_logged`** (kit). In `ai_allowed_logged` the prompt log is the candidate's own paste/typing
   record via the client; we do not capture other apps.
4. **Autosave.** **IndexedDB on the client plus a server `seq`; the server stores each save with its content hash and rejects any
   after the deadline; the final submission is the last acknowledged save.** DST: no acknowledged save is lost, none accepted after the deadline.
5. **Timer.** **Deadline stored on the server (start + duration + per-person extra time); the client timer is cosmetic and re-synced
   from `/time`.** Extra time is an accommodation recorded on the roster row.
6. **Consent.** **A person consents (once per exam, text versioned) before the first telemetry byte; the telemetry endpoint rejects
   batches without `consent_at`.** Telemetry kinds are a closed list (focus loss, paste, key-timing aggregates, run/test events, edit
   deltas); **no keystroke content beyond the code itself, no screenshots, no audio/video.** Retention 180 days default, shorter allowed.
7. **Telemetry storage.** **Monthly range partitions by `ts`, batched inserts (COPY-style), per-session bounded rate.**
8. **Similarity.** **Token-based winnowing over normalized source (identifier/literal-insensitive) within an exam and against the
   same course's earlier exams, producing pairs with scores and the matching spans; a signal for a human, never a verdict.**
9. **Integrity evidence.** **Each flag stores kind, evidence (spans, timeline points), a plain-language explanation and the rule
   version; instructors review and decide (`clear`, `needs_review`, `confirmed`, `dismissed`); the student can appeal with a note,
   and the appeal is reviewed by a different person.**
10. **Oral defence v1.** **For a chosen submission an `LlmProvider` generates 3 to 5 questions about the student's own code under a
    strict JSON schema with the code treated as hostile text; the student answers in text; a human reviewer scores. The LLM scores
    nothing.** Needs your provider key to run for real (F41); tests use a fake.
11. **Instructor tools.** **Live monitor (sessions, state, last save, flags) and a replay timeline that reproduces the final
    submission byte for byte from the saves/edit deltas.**
12. **Privacy.** **Privacy impact assessment, DPA template, minors policy and the false-positive review process as documents**
    (they need your legal review; I draft). Telemetry deleted with the account per the kit.

## 4. Work breakdown (one pull request each, tests first; report after each part)
**6A: the exam itself**
| # | Slice | Verify |
|---|---|---|
| 0 | ADR 0032, contracts (states, modes, limits), threat-model section, privacy impact assessment draft | review; contract tests |
| 1 | Migration: exams, roster, sessions, consent, state machine, deadline; RLS | db tests, RLS matrix, clock-equivalence test |
| 2 | Exam API and instructor screens: template, schedule, CSV roster, accommodations | HTTP tests, authz matrix, browser test |
| 3 | Student session: system check, consent, rules, start, server timer | HTTP and browser tests |
| 4 | Autosave with `seq`, deadline enforcement, reconnect; exam simulation | **DST: no acked save lost, none after the deadline**, many seeds |
| 5 | Submit/run inside the exam (judge path, results hidden until release), rubric and partial credit, grade export | HTTP tests, golden export |

**6B: evidence**
| # | Slice | Verify |
|---|---|---|
| 6 | Telemetry ingestion (consent-gated, batched, partitioned, bounded) | consent gate tests, partition tests, ingest simulation |
| 7 | Live monitor and replay timeline | replay equals final submission byte for byte (property test) |
| 8 | Similarity service (winnowing) and its review screen | property tests (insensitive to renaming, sensitive to structure), seeded corpus |
| 9 | Integrity evidence, review states, appeals workflow | HTTP tests, state-machine simulation, separation of duties |

**6C: oral defence and the rest**
| # | Slice | Verify |
|---|---|---|
| 10 | `LlmProvider` port, strict schemas, fake provider, question generation job, answer capture, reviewer UI | prompt-injection tests (hostile code cannot change the schema or leak), no LLM score |
| 11 | Institution dashboard and CO/PO report template (draft; needs customer validation), SEB design note | browser test, golden report |
| 12 | Scaled 2,000-session load run, accessibility checks, pilot runbook, threat model, ASVS rows, privacy docs, Stage 6 report | the harness's numbers, reported as scaled |
| 13 | (only if you want it) LTI 1.3 launch against a mock platform | protocol tests against a mock; **not** a real LMS |

## 5. Security notes
Exam content and answers are tenant data: RLS on every table; per-test results and other candidates' work never reach a
candidate; telemetry only after consent and only in the closed list; similarity pairs visible to instructors of that course only;
integrity decisions are human, audited and appealable; LLM output is untrusted, schema-validated, never a score or a verdict;
candidate text goes to the provider only if the institution enabled it and never with another tenant's hidden material; no
detector of AI-written text is used as evidence.

## 6. What this still will not do
Real proctoring (webcam, lockdown), identity verification (Stage 7 credentials may build on it), a real LMS integration test, a real
oral-defence quality claim without a provider, or any claim that an exam run on a development VM is a real exam.

## 7. Things only you can provide
A pilot institution and course; an LTI sandbox (if slice 13); an LLM provider key and budget (F41); legal review of the privacy
documents and the jurisdictions in kit 15 item 33; someone to run the human accessibility audit; a deployment (F1).
