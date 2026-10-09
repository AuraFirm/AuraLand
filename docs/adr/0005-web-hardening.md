# 0005 — Web hardening: Next.js as a thin renderer
Status: accepted
Date: 2026-10-10

## Context
Next.js published many advisories in 2026. From the project's advisory page (fetched 2026-10-10),
newest first: cache leaks across `use cache` fills (Sep 30, moderate); Draft Mode leak via
`use cache` (Sep 30); SSRF in Image Optimization (Sep 30, high); dev-server MCP endpoint
information disclosure (Sep 30, low); cache poisoning of SSG/ISR pages in self-hosted apps
(Sep 30, moderate, two advisories); metadata image routes `dynamicParams` bypass (Sep 30);
RCE in `next/og` ImageResponse (Sep 22, critical); unauthenticated RCE in the Image Optimization
API with AVIF files (Aug 25, critical); unauthenticated RCE on Windows-hosted servers (Aug 25,
critical). Patched-version ranges were not readable from the listing. `pnpm audit` on 2026-10-10
reports no known vulnerabilities for Next 16.4.0, but audit data can lag disclosure.

## Decision
The web app only renders UI. Enforced by config, tests or tigerlint:
- No image optimizer (`images.unoptimized`), no `next/og` (rule `no-next-og`).
- No `use cache`, no ISR/`revalidate` (rules `no-next-cache`, `no-isr`); every page is dynamic.
- No Server Actions (rule `no-server-actions`).
- `proxy.ts` only attaches the CSP nonce and cache headers; it makes no auth decisions.
- Per-request CSP nonce; responses carrying it are `private, no-store`.
- Static security headers from one list (`security-headers.ts`), tested.
- Patch high and critical Next advisories within 72 hours; a CI job runs `pnpm audit`.
- Keep feature code portable so the framework can change (Stage 9 re-evaluation).

## Consequences
No static generation for public pages yet; the verification page (Stage 7) will need a
hash-based CSP or a separate cache-safe route. Trusted Types enforcement is deferred until verified
compatible with Next.js.

## Verification
`apps/web/src/lib/csp.test.ts`; manual run of the standalone build showed all headers, a unique
nonce per request, and nonce attributes on all five script tags. Not yet verified in a real
browser for CSP violations (Playwright arrives with Stage 1 end-to-end tests).

## Revisit trigger
Any critical Next advisory affecting a feature we use; TanStack Start RSC maturity.
