# 0032 — Stage 6 decisions (exams and integrity)
Status: accepted
Date: 2026-10-15

## Context
The owner accepted the defaults of `docs/stages/stage-6-plan.md`. Exams hold the most sensitive data the
product has handled so far: other people's graded work, their behaviour while they sit, and decisions about
whether they cheated. Three things shape every choice below: a candidate must never lose work they were told was
saved; telemetry exists only with consent, in a closed list; and a human, never a program, decides an integrity case.

## Decisions
1. **Order.** Core exam (6A), then evidence (6B), then oral defence and reports (6C). LTI 1.3 is slice 13 and
   only against a mock platform; SEB is a design note.
2. **States.** Exam: `draft, scheduled, open, closed, released`. Time moves scheduled to open at `window_start`
   and open to closed at `window_end`; people publish (draft to scheduled) and release grades (closed to
   released). Session: `invited, consented, started, submitted, expired` (kit 05).
3. **Deadline, decided by the database with the injected clock.** A session's `deadline_at` is the earlier of
   `started_at + duration + extra` and `window_end + extra`, where `extra` is the person's accommodation. Everyone
   therefore finishes by the end of the window plus their own extra time. A save or submission at or after the
   deadline is refused by a definer function that takes the clock, not by the exam state (the worker that
   moves states may be down). A session still `started` after its deadline is moved to `expired`; its last
   acknowledged save is its answer.
4. **Autosave.** The client keeps drafts in IndexedDB and sends them with an increasing per-session `seq`. The
   server accepts a save only if `seq` is exactly one above the last acknowledged (or an idempotent repeat of the
   same `seq` and content hash), stores it with its hash, and answers with the acknowledged `seq`. The client
   deletes nothing locally until acknowledged. The invariant tested by simulation: no acknowledged save is lost,
   none is accepted after the deadline.
5. **Rosters.** CSV (email, name, optional extra minutes), at most 5,000 rows and 512 KiB, validated whole before
   anything is written. A person without an account is invited through the existing invitation flow. No LMS sync.
6. **Assurance.** Only level 1 (a signed-in account, consent, consent-gated telemetry) is built; the contract
   refuses 2 and 3.
7. **Consent.** Per exam and person, to a text with a version (`CONSENT_TEXT_VERSION`). `consent_at` and the
   version are stored; the telemetry endpoint refuses any batch from a session without them. Consent is never
   a condition hidden in the exam: the instructor sees who has and has not consented, and an exam can run with
   telemetry off for the people who decline only if the instructor allows it (decided in slice 3).
8. **Telemetry.** A closed list of kinds (`TELEMETRY_KINDS`): focus changes, fullscreen exit, paste/copy/cut, edit,
   run, offline/online. No keystroke content beyond the code itself, no screen, audio or video. Batches of at most
   200 events of at most 1 KiB, at most 40 events a second per session, stored in monthly range partitions.
   Retention 180 days by default, an institution may choose fewer (at most 365); a job drops expired partitions.
9. **Similarity.** Token-based winnowing over normalized source, within an exam and against the same course's earlier
   exams; output is pairs with a score and matching spans. A signal for a person, never a verdict, and never shown
   to candidates.
10. **Integrity.** A flag stores its kind, its evidence (spans, timeline points), a plain explanation and the rule
    version. States `unreviewed, clear, needs_review, confirmed, dismissed`. Instructors decide; the student may
    appeal with a note; an appeal is reviewed by a different person than the decider. **No AI-text detector is used
    as evidence, ever** (kit 08).
11. **Oral defence.** An `LlmProvider` port with a strict JSON schema produces three to five questions about the
    student's own code, treating the code as hostile text (no tools, no secrets, schema-validated output, separate
    system and user content). The student answers in text; a human scores. The LLM scores nothing. Without a
    provider key only the fake provider runs (F41).
12. **Grades.** Per problem, `points` split into `auto_percent` (follows the judge's score) and rubric items that a
    person scores; the contract requires the rubric to carry exactly the manual points. Per-test results and other
    candidates' work are never shown to a candidate; results are released only when the exam is `released`.
13. **Privacy documents** (privacy impact assessment, DPA template, minors policy, false-positive review process)
    are drafted by me and need the owner's legal review; they are part of the stage's evidence, not legal advice.

## Consequences
New tables (slice 1) all carry `org_id` and RLS, with rows in the RLS matrix and ADR 0003. A candidate has no
access to anything but their own session. The exam path reuses the judge queue at a priority between contests and
practice (decided in slice 5).

## Alternatives considered
Starting with LTI (rejected: needs an LMS we do not have); counting a late save toward the answer if it arrives
within a grace period (rejected: a rule a person cannot predict); recording keystroke content for replay
(rejected: edits of the code are enough to replay and anything more is surveillance we cannot justify); an
LLM-assigned oral score (rejected: kit 08, an LLM is never the sole authority).

## Amendment (slice 3): consent is a condition of sitting

Decision 7 left open whether an exam can run with telemetry off for a person who declines. Decided: **no, in Stage 6.**
Consent to the current wording is required before the candidate can start; a person who declines arranges another
way to be assessed with their instructor, outside the product. The wording says so. Reason: a per-person
"telemetry off" mode makes every integrity signal incomparable between candidates and is a second code path to get wrong;
the privacy trade is made by the institution (which may choose to run without telemetry-based review) not by the page.
The telemetry rejection without consent (slice 6) stays as the technical guard. The problem list of an exam is readable
only in an exam whose sitting the person started (migration 0045); a statement stays readable by version to people who
have sat that problem.
