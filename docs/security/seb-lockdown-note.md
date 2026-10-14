# Safe Exam Browser and lockdown: design note (Stage 6, slice 11)

Status: design only. Nothing here is built, and no SEB claim is made anywhere in the product. This note says what
a later stage would do and what it would and would not buy, so an institution's question has an honest answer.

## What an institution asks for
"Can you stop students opening other things during the exam?" Safe Exam Browser (SEB) is a locked-down browser many
institutions already use. It restricts the machine while an exam page is open.

## What the product does today (assurance level L1)
Consent-gated telemetry counts focus losses, fullscreen exits, pastes and offline spells. Staff review them with
the replay and similarity tools. This is evidence for a person to weigh. It does not stop anything, and a
candidate with a second device is not visible to it. The exam page says so in the consent text.

## How SEB would connect (assurance level L2)
1. The exam is marked `requires_seb`, with a set of accepted configuration hashes the institution chose.
2. SEB sends a header on every request with a hash of its configuration and of the page URL (the "Config Key"
   and "Browser Exam Key" headers). The server computes the expected value from the URL and the accepted keys and
   compares. A mismatch refuses `start` and every save, with a plain message.
3. The check lives in the same database function that decides the deadline, so it cannot be skipped by a route.
4. A request without the header is `L1` and is recorded as such on the sitting, so staff see which sittings ran
   under which assurance.

## What it would not buy
- SEB keys prove a configured SEB sent the request. They are not proof the machine is clean: a virtual machine,
  a second screen or a second device is outside it.
- Keys are secrets of the institution's configuration. They must be stored as secrets and rotated per exam.
- SEB is not the same on every operating system, and some accessibility tools do not work inside it. An
  accommodation path (a documented exception per candidate, decided by a person) is part of the design.

## Open questions for a pilot institution
Which configuration they already use; whether they will accept exceptions for assistive technology; whether they
want the check blocking (refuse to start) or advisory (flag only).

## Why it waits
It needs a real SEB to test against and an institution to say what they need. Building it now would be a claim
without observation (the project's rule), so it stays a note until a pilot asks.
