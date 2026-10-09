# 15 — Decisions, Sources, ⚠️VERIFY List, Open Questions

## 1. Research basis (web research on 2026-10-10)

Findings below come from secondary sources (blogs, vendor posts, aggregator pages). They informed **direction**, not facts to rely on. Claude must re-verify each against primary sources in Stage 0 (see P0 prompt).

| Topic | What we took from research | Source |
|---|---|---|
| TigerStyle | Priorities safety → performance → DX; 70-line function cap; no recursion; ≥2 assertions per function; pair assertions; assertions kept on in production; explicit limits; uncluttered repo root; crash rather than corrupt | [TigerBeetle docs: production ready](https://docs.tigerbeetle.com/about/production-ready), [TigerBeetle newsletter, Oct 2025](https://tigerbeetle.com/newsletters/2025-11-07-october-in-tigerland), [Feb 2025 newsletter](https://tigerbeetle.com/newsletters/2025-03-05-february-in-tigerland), [Ximedes interview](https://ximedes.com/blog/solving-the-hot-key-problem), [awesome-tigerstyle (pointer list)](https://github.com/copyleftdev/awesome-tigerstyle), [daily.dev summary](https://daily.dev/posts/we-are-forgetting-how-to-write-good-software-xqyqr94w6). The original `TIGER_STYLE.md` was not retrieved: fetch it. |
| TS API stack | Hono + Drizzle + Postgres is the converging 2026 default; Bun vs Node contested (DB-bound apps see little gain; Node leads on compat/LTS); Hono portable across runtimes | [encore.dev stack guide](https://encore.dev/resources/typescript-backend-stack-2026-ai-agents), [pkgpulse Express vs Hono](https://www.pkgpulse.com/guides/express-vs-hono-2026), [stacknotice Bun vs Node](https://stacknotice.com/blog/bun-vs-nodejs-2026), [reintech benchmarks](https://reintech.io/blog/bun-vs-nodejs-performance-benchmarks-2026) |
| Sandboxing | Firecracker (own guest kernel, hardware boundary) favored over gVisor for hostile code; per-run fresh microVM; verify host config (KVM, jailer, cgroups, network) | [Fly.io: Firecracker vs gVisor](https://fly.io/learn/firecracker-vs-gvisor/), [DEV: microVMs explained](https://dev.to/aleksei_aleinikov/microvms-explained-firecracker-vs-gvisor-for-secure-workloads-in-2026-3193), [Northflank on Firecracker](https://northflank.com/blog/what-is-aws-firecracker), [First AI Movers: blast radius](https://radar.firstaimovers.com/why-microvm-isolation-changes-the-blast-radius-for-untrusted-agent-cod.md). No online-judge-specific 2026 benchmark found. |
| Auth | Lucia is unmaintained; Auth.js merged into Better Auth and its passkey provider is experimental; Better Auth has a passkey plugin | [Lucia status (wisp.blog)](https://wisp.blog/blog/lucia-auth-is-dead-whats-next-for-auth), [Auth.js passkey docs](https://authjs.dev/getting-started/providers/passkey), [pkgpulse comparison](https://www.pkgpulse.com/guides/better-auth-vs-lucia-vs-nextauth-2026) |
| Queue | Postgres `SKIP LOCKED` is the default when Postgres already exists; transactional enqueue is the key benefit; pg-boss has policy sharp edges; NATS JetStream is the step-up | [pg-boss](https://npmjs.com/package/pg-boss), [Basedash lessons](https://www.basedash.com/blog/what-we-learned-running-background-jobs-on-postgres), [JetStream work-queue post](https://milanjovanovic.tech/blog/nats-jetstream-job-queue-dotnet) |
| Web framework | Next.js has the most mature RSC but a 2026 stream of serious advisories (XSS, DoS in Server Actions, middleware auth bypass; a critical RCE claim not confirmed against a primary advisory); TanStack Start is younger (v1.0 Mar 2026, RSC Apr 2026) and suffered a May 2026 npm supply-chain incident affecting @tanstack packages | [Makerkit comparison](https://makerkit.dev/blog/tutorials/tanstack-start-vs-nextjs), [LogRocket](https://blog.logrocket.com/tanstack-start-rsc-vs-next-js-rsc-performance-dx-production-readiness/), [CVE-2026-44578 (Action1)](https://www.action1.com/vulnerabilities/cve-2026-44578/), [CVE-2026-64642](https://cvefeed.io/vuln/detail/CVE-2026-64642), [CVE-2026-64641](https://cvefeed.io/vuln/detail/CVE-2026-64641), [CVE-2026-45321 (TanStack)](https://advisories.gitlab.com/npm/@tanstack/react-start/CVE-2026-45321/) |
| Security standard | OWASP ASVS 5.0 (May 2025): ~350 requirements, 17 chapters, three levels; L3 grew to ~90 extra requirements | [SoftwareMill: what's new in ASVS 5.0](https://softwaremill.com/whats-new-in-asvs-5-0/), [report-uri ASVS 5.0.0](https://ams.report-uri.com/solutions/owasp_asvs_500) |
| Credentials | OB 3.0 deployments commonly use W3C Data Integrity `eddsa-rdfc-2022` with `did:web`; no dedicated TS library found; we start with VC-JWT (permitted proof format) and keep Data Integrity as a later option | [Anonyome OB3 explainer](https://anonyome.com/resources/blog/open-badges-3-explained/), [PoK OB3 guide](https://www.pok.tech/blog/posts/open-badge-3-0-complete-guide-digital-credentials), [@dsnp/verifiable-credentials](https://www.npmjs.org/package/@dsnp/verifiable-credentials) |

## 2. ⚠️VERIFY checklist (Claude resolves in Stage 0; humans confirm)
1. TigerStyle original text (`TIGER_STYLE.md`): confirm each rule we adapted; record deviations.
2. Node.js: which release line is Active LTS on the day of pinning; pin the exact patch.
3. PostgreSQL major version and `uuidv7()` availability/behavior; RDS support timeline for that major.
4. Drizzle ORM version/stability (and whether a 1.0 line changes migration tooling); chosen Postgres driver.
5. Better Auth: current version, passkey/org/2FA plugin APIs, security advisories, session model compatibility with RLS context pattern; fallback plan.
6. Next.js: latest patched line; list of current advisories; confirm that disabling Server Actions/image optimizer/middleware-auth is supported; CSP nonce + caching guidance.
7. pnpm setting names (`minimumReleaseAge`, `onlyBuiltDependencies`, etc.) for the pinned version.
8. AWS KMS support for Ed25519 signing (vs ES256); `did:web` and JWT `EdDSA` interop with common verifiers.
9. Firecracker/jailer current release, supported host kernels, snapshot security guidance (RNG/clock re-seeding); `isolate` version and cgroup v2 support on the chosen OS.
10. OpenTofu state locking options on S3 (native lockfile vs DynamoDB).
11. Neon branching limits/regions if used for previews; confirm only vanilla Postgres features are used.
12. Tailwind v4 + Radix + React 19 compatibility matrix; CodeMirror 6 accessibility notes.
13. ASVS 5.0 requirement IDs to map in `docs/security/asvs-matrix.md`.
14. Stripe availability for the company entity/region; need for a Merchant-of-Record (see §3).
15. Legal: AI-assisted exam proctoring rules in target jurisdictions (GDPR Art. 22 automated decisions, children's data, Bangladesh/India data-protection law status).

## 3. Open decisions for the humans (not for Claude to guess)
| # | Decision | Default if undecided | Needed by |
|---|---|---|---|
| D1 | Legal entity & jurisdiction (affects Stripe, taxes, enterprise contracts) | Delaware C-corp or UK Ltd via incorporation service; Stripe | Stage 4 |
| D2 | Merchant of Record vs direct Stripe | Direct Stripe if entity supports; else MoR | Stage 4 |
| D3 | Primary cloud region(s) and data-residency promise | EU (Frankfurt/Ireland) primary + `ap` bucket later | Stage 0 |
| D4 | Bare-metal provider for judges | Hetzner dedicated (cost) with an AWS `.metal` fallback | Stage 3 |
| D5 | ID-verification vendor | Pick by price/region coverage at Stage 7 | Stage 7 |
| D6 | LLM providers allowed for customer data | Anthropic primary; per-tenant opt-in for others | Stage 4 |
| D7 | Languages at launch (judge profiles) | C, C++, Java, Python | Stage 3 |
| D8 | Brand/domain (`auraland.app`?), trademark clearance | — | Stage 0 |
| D9 | Who is the human security reviewer / CODEOWNER | A founder at first; external reviewer before Stage 4 | Stage 0 |
| D10 | Public vs private repo; license for any open-sourced parts (e.g. judge agent, task spec) | Private; consider open-sourcing spec + verifier harness later for trust | Stage 4 |
| D11 | Contest-day support model (who is on call) | Founders rotate | Stage 5 |

## 4. Decision log (initial ADR seeds to write in Stage 0)
0001 stack & pins · 0002 TigerStyle adaptation · 0003 table ownership · 0004 same-origin API & cookie model · 0005 Postgres queue with fencing · 0006 SSE over WebSockets · 0007 Next.js hardening rules · 0008 VC-JWT credentials & KMS signing · 0009 judge isolation model & node baseline · 0010 RLS context pattern · 0011 observability stack · 0012 dependency budget & supply-chain policy.

## 5. Known risks of this technical plan (honest list)
1. **Sandbox security** is the single largest technical risk; mitigations are layered but unproven until Stage 3/8 reviews. Budget real money for an external review.
2. **Next.js advisory cadence** may create operational churn; the thin-renderer rule limits impact, and Stage 9 re-evaluates.
3. **Better Auth** is comparatively young; wrap behind `AuthPort`, keep sessions/tables simple enough to migrate.
4. **Postgres as queue** has limits (vacuum pressure) — triggers and the NATS escape hatch are defined.
5. **Judge timing determinism** on shared infrastructure is hard; hence bare metal, SMT off, canaries, borderline reruns.
6. **LLM-based validation costs** and model drift: version everything (model name/date) and keep calibration runs reproducible.
7. **Integrity ethics/legal**: false accusations are a reputational and legal risk; evidence-not-verdict design, human review and appeals are mandatory.
8. **Scope**: the kit describes a large system; discipline on staging and cutlines (file 12) is what keeps it safe.
9. Capacity/price numbers in `New_Plan/` are illustrative; engineering targets here are the binding ones.

## 5b. The `craft` skill (added v1.1)
The user's personal skill `~/.claude/skills/craft/SKILL.md` was read on 2026-10-10 and integrated: file 02 §6 (mapping, new rules, precedence), file 00 (working method), files 04, 10, 12, 13, 14 (scope discipline, checklists, prompts, `CLAUDE.md`). Open points for the humans: (a) decided: the skill is bundled in the kit at `.claude/skills/craft/` (byte-identical copy as of 2026-10-10) and ships in the repo at `.claude/skills/craft/`; (b) the skill is generic and the kit's numeric limits (70-line functions, 100 columns, ≥2 assertions) remain the concrete values it asks us to "pick"; (c) if the skill is edited later, re-check file 02 §6.1.

## 6. Changelog
- v1.2 (2026-10-10): corrections from Stage 0 (pnpm settings location, root entry limit, no Testcontainers, TypeScript 7 consequences, middleware order, deferred ports and staging deploy). See the repo's `docs/adr/0001`, `0004`, `0006`.
- v1.1 (2026-10-10): integrated the `craft` skill (see §5b).
- v1.0 (2026-10-10): initial kit (files 00–15).
