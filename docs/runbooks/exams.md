# Exams runbook (pilot)

For the person running an exam. Everything here was exercised on a development machine, not on a deployment (F1), and **no
real judge fleet exists (F32)**: do not run a real exam on this until a deployment, an edge and a reviewed judge node exist.
Also needed first: legal review of the privacy documents (`docs/security/privacy-impact-assessment-exams.md`) and, for oral
defence, a provider account (F41). API calls need a signed-in session, `x-aura-request: 1` and an `Origin` equal to the site.

## 1. Before the exam
1. **Two staff.** The host organization needs at least two owners or admins. An appeal of an integrity decision must be
   reviewed by someone other than the person who decided; with one admin nobody can review (the database refuses).
2. Problems are **released** task versions of the host (or the platform bank). Each has points, `auto_percent` (the judge's
   share) and rubric items that a person scores; the rubric must carry exactly the remaining points.
3. Create the exam (organization page): title, mode (`ai_free` or `ai_allowed_logged`), minutes each person has, the window
   (people may start between its two times), telemetry retention (1 to 365 days, default 180).
4. Upload the roster CSV (`email,name[,extra_minutes]`, at most 5,000 people). A bad line is named and **nothing** is saved.
   Extra minutes are accommodations decided by a person; they never extend past the window end plus the extra.
5. **Publish.** After this nothing about the exam changes. People must sign in with the email on the roster (verified).
6. Rehearse with a test account: join, read the consent text, check the system check page, start, save, hand in.
7. Tell candidates what is recorded: counts of leaving the page, pastes and offline spells; never what they type. The consent
   text is versioned and agreeing is a condition of sitting (legal review pending).

## 2. During the exam
- **Monitor** (`/exams/<id>/monitor`, refreshes every 5 s): state, last save, saves, counts of signals. A count is a reason to
  look at the replay, not a finding.
- A candidate whose connection drops keeps working: drafts are kept in the browser and sent again; nothing acknowledged is lost.
  The deadline is the server's: `min(start + duration + extra, window end + extra)`. No one can be given more time by
  restarting the worker; an accommodation after the start is not supported (cutlist).
- Watch the queue after hand-ins: `select count(*) from jobs where queue = 'judge' and state = 'ready' and priority = 2;`
  and `select count(*) from jobs where state = 'dead';` (should be 0). The tick queues 100 sittings a second.
- If judging is slow or down, set the banner (contests runbook section 2). Answers queue and nothing is lost.

## 3. After the exam
1. The exam closes by itself at the window end (the worker's tick); sittings past their deadline become `expired`, and what
   was saved is their answer.
2. **Wait until every answer is judged** (the release refuses otherwise). Grading: `/exams/<id>/grading` shows each answer
   with the judge's verdict; score rubric items (whole numbers up to each item's maximum). Re-grading before release replaces.
3. **Integrity review** (`/exams/<id>/integrity`): "Check the rules now" raises flags (a paste of 500+ characters, 10+ focus
   losses, very similar answers) once each. For each: read the evidence and the replay, think of innocent explanations, then
   mark it clear, needs review, confirmed or dismissed with a note. A decision is made once. Do not apply a consequence
   outside the product on a single reviewer's confirmation (privacy document section 6).
4. **Similar answers** (`/exams/<id>/similarity`): pairs among answers to one problem, with the matching ranges shown. Two honest
   answers to a small problem can match.
5. A candidate sees only a **confirmed** flag's plain explanation and can appeal; the appeal appears on the flag; a second
   admin reviews it (upheld keeps the flag, overturned dismisses it).
6. **Oral defence** (`/exams/<id>/oral`), only with a provider (F41): ask about chosen answers; a model writes 3 to 5 questions
   about the candidate's code; the candidate answers in writing; you score. Without a provider requests stay `pending`. A
   `failed` request says why (no code in the reason); ask again.
7. **Release grades** (exam page). Frozen from then on. Candidates see their points, the rubric and your comment, never other
   people's work or per-test results.
8. Exports: grades CSV (`/exams/<id>/grades.csv`), draft attainment report (`/exams/<id>/report.csv`, needs outcome mapping and
   thresholds validated with the institution before it is theirs), dashboard (`/orgs/<id>/exam-dashboard`).

## 4. Retention and deletion
Telemetry is deleted by the worker after the exam's retention days (partitions are prepared three months ahead). Drafts,
answers, grades, flags and appeals are kept; the institution's policy and an account-deletion path are open (cutlist).

## 5. When something is wrong
| Symptom | Look at | Do |
|---|---|---|
| Candidates cannot start | `select state, window_start, window_end from exams where id = ...` | The exam opens at the window start by the worker's tick (1 s); restart the worker if `scheduled` persists |
| Saves refused (409 conflict) | Candidate's page says another window saved later | They reload and continue; the server keeps the highest number |
| A candidate says an answer was lost | `select seq, saved_at from exam_drafts where session_id = ... order by seq desc limit 5` | Everything acknowledged is there (load run: 0 lost of 11,995 saves); the replay shows every step |
| Release refused (409) | Answers not judged | Wait, or investigate dead jobs; rejudge as in the contests runbook |
| Oral requests stay `pending` | Worker has no provider | Expected until F41 |
| Appeal cannot be reviewed | Reviewer is the decider | Another owner or admin reviews |

## 6. Not done (so nobody assumes it)
Identity proof, proctoring, lockdown browser (`docs/security/seb-lockdown-note.md`), a real LLM adapter, similarity across exams,
course or outcome mapping for the attainment report, account-level deletion of exam data, LTI launch (slice 13, optional).
