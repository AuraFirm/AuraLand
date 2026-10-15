# 0037 — Web framework re-evaluation (Next.js or TanStack Start)
Status: accepted (stay on Next.js; revisit on the triggers below)
Date: 2026-10-15   Deciders: engineer under the owner's delegation

## Context
Kit Stage 9 asks for a re-evaluation of Next.js against TanStack Start. This is a decision from facts in the repository, not a
migration. What the web app is: a **thin renderer** (CLAUDE.md): no Server Actions, no authentication in the proxy, no image optimizer,
no `next/og`, no ISR or `use cache`; every decision is the API's; the browser calls `/api/v1` with a custom header and parses answers
with the contracts' schemas. The app has about 40 routes, all client components that load through the API, plus a handful of static
pages, under a per-request nonce CSP (ADR 0005).

## What I could and could not establish
- **Could**: the app uses almost none of what makes Next.js heavy (server-side data access, actions, caching, image handling). It uses
  routing, server-rendered static shells, the nonce CSP middleware and the build.
- **Could not**: TanStack Start's current maturity, release state, security-advisory record or hosting story. I cannot verify any of
  that from this machine, and a framework choice made on recollection of a fast-moving project is a guess. **Unknown.**
- Next.js has had security advisories we had to patch quickly (ADR 0005); the response process (72-hour rule, CI audit) works.

## Decision
Stay on Next.js. A migration would touch every page for no gain in anything we measure, and the restrictions we already apply
(thin renderer, no framework-specific server features) are exactly what keeps a later move cheap.

## Alternatives considered
TanStack Start now (rejected: unknown maturity, real cost, no measured benefit). A plain Vite single-page app with our own server
shell (rejected for now: we would rebuild the nonce CSP and routing that Next gives us).

## Consequences
No change. The rule "NO Server Actions, NO auth in the proxy, NO ISR" stays the guard against lock-in.

## Verification
Not applicable (a decision not to change). The thin-renderer rules are enforced by review and by Semgrep/CI as before.

## Revisit trigger
Any of: two high-severity Next.js advisories within a quarter that the 72-hour rule cannot absorb; the build or cold-render time of the
web app exceeding what CI and deploys can bear; a framework feature we need that Next.js cannot give; or someone who can run TanStack
Start against our pages and report numbers.
