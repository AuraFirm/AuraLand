# 0020 — Browser screens and end-to-end tests
Status: accepted
Date: 2026-10-10

## Context
Slices 1 to 6 built the identity API. Slice 7 gives people screens for it and proves, in a real
browser, the things only a browser can show: passkey prompts, the content security policy, keyboard
and screen-reader accessibility.

## Decision
- **Dependencies.** `@simplewebauthn/browser` 14.0.0 in the web app (the browser half of ADR 0015, no
  dependencies of its own); `zod` in the web app (ADR 0001) so the browser checks API answers with the
  same schemas the server used; `@playwright/test` 1.63.0 and `@axe-core/playwright` 4.13.0 in the new
  `apps/e2e` workspace (test-only, never shipped). Playwright 1.64.0 was published on 2026-10-07, inside
  the 3-day window, so 1.63.0 is pinned. Browser binaries are downloaded explicitly
  (`playwright install chromium`), not by an install script.
- **Thin renderer.** Pages are small server components around client components that call the API with
  `fetch`. No Server Actions, no auth in the proxy: the API and PostgreSQL still decide everything. The
  browser sends the `X-Aura-Request` header on every call and parses every answer with its schema.
- **One origin.** Next.js rewrites `/api/*` to the API (default `127.0.0.1:3001`, `AURA_API_ORIGIN` at
  build time). In production the load balancer routes `/api` itself and the rewrite is never used. The
  proxy no longer touches `/api` responses, so the API's own strict headers reach the browser.
- **Plain, accessible markup.** Labelled form fields, one `h1` per page, regions named by headings,
  status and alert live regions, visible focus, and colour contrast checked by axe on every page.
  Axe found one real problem on the first run (white text on the brand colour was 4.4:1), fixed with a
  stronger `--brand-strong` token for filled buttons.
- **The browser CSP check found two real problems**, both fixed: Zod probes for `eval` (`new Function`)
  when a schema is built, which our policy blocks and reports. A one-line script carrying the request's
  nonce, in the page head, sets Zod's documented `jitless` mode before any schema exists. And passkey
  support was read during rendering, so the server and browser disagreed about the first render
  (React error 418); it is now read after mount.
- **End-to-end runner.** `pnpm run test:e2e` (`apps/e2e/src/run-cli.ts`) creates a throwaway database,
  starts the built API and the built web app (standalone server, as in the image), runs Playwright
  against Chromium, and stops and drops everything afterwards, each server in its own process group.
  It needs `pnpm run build` first and Mailpit. CI runs it in the `verify` job.
- **Passkeys without a person.** Chromium's virtual authenticator (WebAuthn over the DevTools
  protocol) answers prompts, so registration and passkey sign-in run for real.
- **A direct session for tests that are not about signing in.** Sign-in is rate-limited on purpose (10
  starts a minute per address), so tests that need "a signed-in person" create the same rows a sign-in
  would, straight in the test database, and set the cookie. The email, code, link and passkey flows are
  each driven through the screens once.
- **Semgrep.** The direct-`fetch` rule now also excludes `apps/e2e`, whose only targets are local test
  servers and Mailpit.

## Alternatives considered
A client-side data library (SWR, TanStack Query): more code and dependencies than these screens need.
Cypress or Selenium: Playwright has the virtual authenticator and a first-class axe integration.
Mocking the API in browser tests: would test the mock, not the CSP, cookies or CSRF header handling.

## Consequences
The Next.js rewrite constant is baked into the web image but unused behind the load balancer. The
inline zod line depends on a Zod internal global; the e2e CSP check fails if a Zod upgrade changes it.

## Verification
19 end-to-end tests: email code, email link, wrong code, redirect when signed out, incomplete link,
passkey add/sign-in/rename/remove, device list and sign-out, data export download, deletion request
and cancel, axe on every page, and zero CSP violations or console errors on the pages that run
scripts; plus a test that the browser really blocks an inline handler. The organization screens add: creating
and renaming an organization, an outsider's view (looks missing), inviting a person who joins through the
emailed link, the sign-in hint on an invitation link, and API keys (shown once, working for a machine, dead
after revoking, and the "add a passkey first" path for privileged actions).

## Revisit trigger
Adding client-side caching needs, a design system (Stage 7), or more browsers in the matrix.
