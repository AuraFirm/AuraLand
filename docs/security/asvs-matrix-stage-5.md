# ASVS 5.0 mapping: business logic, anti-automation, availability, output (Stage 5)

Standard: OWASP ASVS 5.0.0 (requirement text from the official `5.0.0` CSV, read 2026-10-14; the source uses plain ids like `V2.3.1`, we keep the `v5.0.0-` prefix of the earlier matrices). Wording is shortened here; see the standard for the full text.
Chapters covered: V1.2 (output encoding), V2.3 and V2.4 (business logic, anti-automation), V4.4 (WebSocket; our stream is server-sent events), V15.2 (resource-heavy functionality, dangerous components). Earlier chapters are in the earlier matrices.

**Summary.** 17 requirements: 7 met, 6 partial, 1 not met, 3 not applicable.

| ID | L | Requirement | Status | Evidence or reason |
|---|---|---|---|---|
| v5.0.0-V1.2.1 | 1 | Output encoding suited to the context so the document structure is not altered | Met | Contestant text (clarifications, names) is rendered by React as text; statements come only through `renderMarkdownSafe` into the one `SafeHtml` sink; a `<script>` in a statement does not survive (`http-contest-problem.test.ts`, `http-practice.test.ts`) |
| v5.0.0-V1.2.3 | 1 | Encode output when dynamically building JavaScript or JSON | Met | Responses are `JSON.stringify` of strictly parsed objects; stream events are `JSON.stringify` payloads of numbers and an etag |
| v5.0.0-V2.3.1 | 1 | Business logic flows are processed in the expected order, without skipping steps | Met | Contest state machine is a trigger plus functions (draft, scheduled, running, frozen, ended, finalized); submit, ask, rate only in the right states; TypeScript and SQL clocks agree on 1,200 random cases (`rules.database.test.ts`) |
| v5.0.0-V2.3.2 | 2 | Business logic limits are implemented as documented | Met | Every limit is a named constant with a reason (`limits.ts`); caps tested at limit and limit+1 (streams, questions, queue, interval) |
| v5.0.0-V2.3.3 | 2 | Transactions: a business operation completes fully or rolls back | Met | One request, one transaction, rolled back on 400+; rating run and its record are one transaction; the rate counter commits on its own on purpose |
| v5.0.0-V2.3.4 | 2 | Business-level locking so limited resources cannot be double-booked | Met | `for update` in the definer functions, unique constraints, an advisory lock around rating runs; a contest is rated once (`rating-tick.database.test.ts`) |
| v5.0.0-V2.3.5 | 3 | Multi-user approval for high-value business flows | Not met | Publishing and finalizing (which triggers ratings) need one owner or admin; no second approver. Acceptable for a pilot, listed in the cutlist (F52) |
| v5.0.0-V2.4.1 | 2 | Anti-automation controls against excessive calls | Partial | Per-person limits on registering, submitting, asking; per-problem interval; stream caps; request line bounded at the gate. No bot challenge (Turnstile, F7) and no per-address limit on every public read |
| v5.0.0-V2.4.2 | 3 | Realistic human timing so transactions cannot be submitted too rapidly | Partial | A per-problem minimum interval (default 10 s) is enforced in the database; other actions only have per-minute caps |
| v5.0.0-V4.4.1 | 1 | WebSocket over TLS | N/A | No WebSockets. The ping stream is server-sent events over HTTP; TLS is the edge's job (F33) |
| v5.0.0-V4.4.2 | 2 | Origin header checked in the WebSocket handshake | N/A | Same: the stream is a same-origin GET with the session cookie (SameSite) and read-only data; no state change |
| v5.0.0-V4.4.3 | 2 | Dedicated tokens for WebSocket sessions | N/A | Same; the stream re-authorizes with the ordinary session on every connect and ends after 30 minutes |
| v5.0.0-V4.4.4 | 2 | Session tokens obtained through an authenticated HTTPS session | Partial | Streams use the session cookie; HTTPS depends on the edge (F33) |
| v5.0.0-V15.2.1 | 1 | Only components within documented update and remediation timeframes | Partial | `pnpm audit`, Trivy and Dependabot in CI; the JDK and gcc on a judge node are the distribution's, patched by the node baseline, not tracked by us yet |
| v5.0.0-V15.2.2 | 2 | Defend against availability loss from time-consuming or resource-heavy functionality | Met | Bounded everywhere: render cache (64 MiB), stream caps, queue caps, rating bound (20,000), request line (1,000), pool gate; a load run found and fixed two real problems (`stage-5-report.md`) |
| v5.0.0-V15.2.3 | 2 | Ship only needed functionality, no test or development code | Partial | The load harness and e2e seeds are tools under `src/`, not imported by the service; the bundle contains only `main.ts` imports. Not yet verified by a bundle-content check |
| v5.0.0-V15.2.5 | 3 | Extra protection (sandboxing, isolation) around dangerous functionality | Partial | Untrusted C, C++, Java and Python run only in isolate boxes on judge nodes; escape suites pass on a development VM; no production node and no external review (F32) |
