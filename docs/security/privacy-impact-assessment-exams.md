# Privacy impact assessment: exams and integrity (Stage 6) — DRAFT for legal review

Status: **draft by the engineering assistant; not legal advice.** The owner, and for a real customer their counsel, must
review it. Jurisdictions to check are listed in `docs/kit/15` item 33 (GDPR and UK GDPR, children's data, Bangladesh and
India data-protection law). It is updated as slices land; claims below are what the design says, and each is marked
**built** only when the slice that builds it is merged.

## 1. What is processed, why, on what basis (to confirm)
| Data | Whose | Purpose | Basis (proposed) | Where | Built |
|---|---|---|---|---|---|
| Name, email, accommodation minutes (roster) | candidate | run the exam, give the right time | contract with the institution; accommodation is health-adjacent: explicit consent or the institution's legal duty | exam roster table | no |
| Answers: saved drafts, submissions, grades, rubric marks | candidate | assessment | contract with the institution | drafts, submissions | no |
| Consent record (time, text version) | candidate | prove consent | legal obligation | session row | no |
| Telemetry: focus changes, paste/copy/cut, edit events, run events, offline/online | candidate | integrity review by a human | **consent** (and the institution's legitimate interest, to be assessed) | partitioned telemetry table | **yes (slice 6)**: counts and durations only, consent-gated in the database, bounded rate, retention job |
| Similarity pairs and spans | candidate | integrity review by a human | legitimate interest of the institution | similarity table | no |
| Integrity flags, decisions, appeals | candidate | fair process | legitimate interest; the right to contest | integrity tables | no |
| Oral defence questions and answers | candidate | verify understanding | contract/consent | oral table | no |

**Not collected:** screenshots, screen recording, webcam, audio, keystroke content beyond the code, device
fingerprints, location, browsing history, other applications. The telemetry kind list is closed in code
(`TELEMETRY_KINDS`); adding a kind is a reviewed change to code and to this document.

**Consent.** In Stage 6 consent to the versioned wording is a condition of sitting; a person who declines arranges another assessment with their instructor. The lawful basis for the exam itself is the institution's; consent is the basis for the telemetry. A consent that is a condition of an assessment may not count as freely given in some jurisdictions: **this needs legal review before any real use** (it may need the institution's legitimate interest or an alternative path instead).

## 2. Automated decisions (GDPR Art. 22)
No decision about a candidate is made by a program. Flags and similarity scores are evidence with a plain explanation; only a
person changes an integrity state; the candidate can appeal, and the appeal goes to a different person. An LLM only proposes
oral-defence questions and scores nothing. **No AI-text detector is used** (unreliable, biased against non-native writers).

## 3. Retention and deletion
Telemetry: 180 days by default, an institution may choose fewer (at most 365); expired partitions are dropped. Drafts: one
year. Submissions and grades: per the institution's policy. Deleting an account hard-deletes telemetry and drafts and
anonymizes the rest per `docs/kit/05` section 9. **Not yet built; this stage builds telemetry and retention, and the report
says what was verified.**

## 4. Risks and mitigations
| Risk | Mitigation | Residual |
|---|---|---|
| Surveillance creep | closed telemetry list; code-reviewed changes; consent text versioned | an institution may still over-interpret signals |
| False accusations from signals | evidence with explanation; human decision; appeals; false-positive review process (section 6) | reviewers can still be wrong |
| Data of minors | minors policy (section 5) | needs the institution's guardian-consent process |
| Breach of exam data | RLS on every table, audit log, no candidate access beyond their session, short retention | the platform is not deployed or externally tested |
| Provider sees candidate code (oral defence) | per-institution switch, only the candidate's own code, redacted logs, zero-retention settings with a provider | needs a provider and a DPA |

## 5. Minors (draft policy)
Exams for people under 18 only if the institution confirms lawful consent from a guardian where required; telemetry stays
off for them unless the institution documents the basis; no oral-defence provider calls without guardian consent. The product
does not know ages; the institution declares it per exam. **Needs legal review per jurisdiction.**

## 6. False-positive review process (draft)
Every integrity flag lists the rule, the evidence and what innocent explanations exist. A reviewer must record why a flag is
confirmed or dismissed. A confirmed case needs a second reviewer before any consequence outside the product. A rule that produces
dismissals above an agreed rate is reviewed or removed. Appeals are heard by someone who did not decide.

## 7. DPA template and sub-processors
A data-processing agreement template is drafted in slice 12 for the owner's lawyer. Sub-processors today: PostgreSQL and object
storage hosts (undeployed), mail provider (none yet), an LLM provider (none yet). The list is part of the DPA.
