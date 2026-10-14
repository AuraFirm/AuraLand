# Data processing agreement: template for exam customers — DRAFT for legal review

Status: **a starting point drafted by the engineering assistant; not legal advice and not signed by anyone.** Counsel for the
owner (and for each institution) must review and adapt it. Brackets are decisions to make.

## 1. Parties and roles
The institution is the controller of candidates' personal data; [AuraLand legal entity, D1] is the processor. [To confirm: where
the institution asks AuraLand to decide purposes (for example integrity rules), roles may differ.]

## 2. Subject matter, duration, nature and purpose
Running timed programming exams: rostering, identity by verified email, saving work, judging, grading, integrity evidence for
human review, oral-defence questions, exports. Duration: the contract term plus the retention in section 6.

## 3. Categories of data and of people
People: candidates, staff. Data: name and email (from the roster), consent record and its text version, drafts and answers (code),
judge results, grades and rubric comments, telemetry counts (page left or returned, paste size, offline spells, edit counts, run
counts; never what was typed or pasted), integrity flags with evidence and decisions, appeals and notes, oral-defence questions and
answers, audit events. No webcam, audio, screen or biometric data is processed. [Minors: section 5 of the privacy assessment.]

## 4. Processor obligations
Process only on documented instructions; confidentiality of staff; security measures as in `docs/threat-model.md` and the ASVS
matrices [list the final measures at signing]; assist with data-subject requests (export, deletion; deletion tooling is open, see
cutlist F57); breach notification within [72 hours / agreed period]; audit rights [scope]; return or delete at the end.

## 5. Sub-processors
| Sub-processor | Purpose | Location | Status |
|---|---|---|---|
| [Cloud host, PostgreSQL and object storage] | Hosting | [region] | Not chosen (F1) |
| [Mail provider] | Sign-in codes and invitations | [region] | Not chosen |
| [LLM provider] | Oral-defence questions from a candidate's own code, when the institution enables it | [region] | None; the product calls no provider today (F41). Requires zero-retention settings and a per-institution switch, neither built |

The institution is told in advance of any change and may object.

## 6. Retention
Telemetry: the exam's setting (1 to 365 days; default 180). Other data: [institution's period]; deletion on request within [period]
once the deletion tooling exists. Backups: [period, not decided].

## 7. International transfers
[To decide with the hosting region and the institution's jurisdiction.]

## 8. Automated decisions
None. Flags and similarity scores are evidence for a person; only a person changes an integrity state; appeals go to a different
person; no AI-text detector is used.
