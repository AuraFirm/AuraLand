# 09 — UI/UX Implementation Guide

> Visual reference: `../New_Plan/Latest/UI_UX_Demo.pdf` (17 pages, 10 desktop screens + mobile + flows + states) and its source `../New_Plan/Latest/LaTeX/ui/*.tex`. This file turns that spec into **implementable rules**. When this file and the PDF disagree, this file wins; record the change in an ADR.

## 1. Design intent
**Calm, credible, fast.** AuraLand sells trust, so the UI must feel precise and quiet (Stripe/Linear/Vercel level craft), while contests feel energetic (Codeforces/LeetCode/Duolingo-style momentum) and exams feel safe. Three emotional modes, one design system:

| Mode | Where | Feeling | Tactics |
|---|---|---|---|
| **Focus** | Workspace, exam | Clear head, no anxiety | Minimal chrome, one primary action, visible autosave, calm timer, no motion except meaningful feedback |
| **Momentum** | Arena, scoreboard, home | Progress, competition, belonging | Live deltas, rating progress, streak (optional), "next best action" |
| **Trust** | Passport, employer report, Forge portal, verify page | Confidence, rigor | Evidence-first layouts, assurance badges, "what this proves" explainers, signatures and provenance visible |

## 2. Borrowed best ideas (and where we use them)
| From | Idea | Our use |
|---|---|---|
| **Linear** | Keyboard-first, command palette (⌘K), instant optimistic UI, dense but airy | Global ⌘K; `g a` go Arena; `?` shortcut sheet; optimistic task/contest edits |
| **Stripe** | Documentation-grade clarity, status chips, empty states that teach, test-mode toggle | Forge portal, API docs, key management, test-mode data |
| **Vercel/Notion** | Skeleton → content with no layout shift; subtle motion; great dark mode | Skeleton loaders, CLS≈0, dark default + light |
| **Duolingo** | Goal-gradient progress, small wins, streaks with forgiveness, friendly copy | Daily challenge, progress rings, **streak freeze**, celebratory micro-moment on rating up |
| **Codeforces** | Information density for experts, color-coded ratings, scoreboard clarity | Rating colors, compact standings table with density toggle |
| **LeetCode/HackerRank** | Split pane problem + editor, run samples, submissions tab | Workspace layout (resizable panes, persisted) |
| **GitHub** | Familiar diff/timeline patterns | Exam replay timeline, Forge validation report |
| **Figma/Miro** | Presence cues | Live participant counts on contests; instructor sees who's online |
| **Apple HIG / Material a11y** | Clear hit targets, motion preferences | 44px targets on touch, reduced-motion respect |
| **Credly/LinkedIn badges** (and what they lack) | Shareable proof | Passport share card with *verifiable* link, QR, assurance level |
| **Gov.uk Design System** | Plain language, error summary patterns | Forms, error handling, copy |

## 3. Psychology principles → concrete rules
| Principle | Rule |
|---|---|
| **Hick's law** | ≤ 5 primary choices per screen region; one primary button per view; progressive disclosure for settings |
| **Fitts's law** | Primary actions large and near the cursor path (Submit anchored bottom-right of editor); 44×44 px touch targets |
| **Doherty threshold (<400 ms)** | Every interaction acknowledges within 100 ms (pressed state, optimistic UI), completes < 400 ms or shows progress; verdict stream shows stages (Queued → Compiling → Running 3/12 → Verdict) |
| **Goal-gradient & Zeigarnik** | Progress rings (solved N/M, profile completeness, Passport strength); unfinished-task nudges ("Resume problem C") |
| **Peak-end rule** | The **verdict reveal** and **exam submit confirmation** are crafted moments: clear, kind, ≤ 600 ms flourish (honors `prefers-reduced-motion`); end exams with a calm summary and "what happens next" |
| **Loss aversion (ethical)** | Streak freeze + weekly rest day; never shame; opt-in reminders; no fake scarcity or fake countdowns |
| **Social proof & belonging** | Live "1,284 competing", friends' activity, university leaderboards; never expose private data |
| **Variable reward (restraint)** | Surprise only in the form of useful insight ("Your speed on graph problems improved 18 %"), not slot-machine mechanics |
| **Default effect** | Safe defaults: privacy `unlisted`, telemetry consent explained, AI-mode explicit |
| **Recognition over recall** | Show recent problems, contest history, saved filters; autocomplete everywhere |
| **Error prevention > messages** | Disable impossible actions with the reason on hover/focus; confirm destructive actions with typed confirmation for org-level deletes |
| **Anxiety reduction (exams)** | Autosave indicator ("Saved 12:03:41 ✓"), connection status, "You can reconnect—your work is safe", visible rules page, no ominous red unless action is required, timer turns amber at 10 min, not blinking |
| **Explainability for trust** | Every score, flag and badge has a "Why?" popover with data and method link; integrity flags show *evidence*, never "AI-generated: 93 %" |
| **Cognitive load** | Plain language (grade 8), one idea per paragraph, UI strings ≤ 12 words where possible |

## 4. Design tokens (`apps/web/src/styles/tokens.css`)
Dark is the default (matches the brand palette in the PDFs); light theme is first-class. Use CSS variables; Tailwind v4 theme maps to them. Contrast must pass **WCAG 2.2 AA** (verify with automated checks; muted text ≥ 4.5:1).

```css
:root[data-theme="dark"] {
  --bg:#0B0F1A; --panel:#121A2B; --panel-2:#1A2438; --line:#2A3652;
  --text:#E5E9F2; --muted:#8D99B3;
  --brand:#6366F1; --accent:#22D3EE;
  --ok:#22C55E; --warn:#F59E0B; --danger:#EF4444; --info:#A855F7;
  --focus:#22D3EE;
}
:root[data-theme="light"] {
  --bg:#F8FAFC; --panel:#FFFFFF; --panel-2:#EEF2FF; --line:#CBD5E1;
  --text:#0F172A; --muted:#475569;
  --brand:#4F46E5; --accent:#0891B2;
  --ok:#15803D; --warn:#B45309; --danger:#B91C1C; --info:#7E22CE;
  --focus:#0E7490;
}
:root {
  --radius-s:4px; --radius-m:8px; --radius-l:12px;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-6:24px; --space-8:32px;
  --font-sans: "Inter Variable", system-ui, sans-serif;     /* self-hosted, subset */
  --font-mono: "JetBrains Mono Variable", ui-monospace, monospace;
  --text-xs:12px; --text-sm:14px; --text-base:16px; --text-lg:18px; --text-xl:24px; --text-2xl:32px;
  --dur-fast:120ms; --dur-base:200ms; --ease: cubic-bezier(.2,.8,.2,1);
}
@media (prefers-reduced-motion: reduce){ :root{ --dur-fast:0ms; --dur-base:0ms; } }
```
Assurance colors: L0 `--ok`, L1 `--accent`, L2 `--brand`, L3 `--info` (+ always an icon and text label; **never color alone**). Rating colors follow a tiered scale with text labels.

## 5. Component inventory (build in `ui/`, Radix-based, tested with Testing Library + axe)
Foundation: `Button` (primary/secondary/ghost/danger, loading), `IconButton`, `Input`, `Textarea`, `Select`, `Combobox`, `Checkbox`, `Radio`, `Switch`, `Tabs`, `Dialog`, `Drawer`, `Popover`, `Tooltip` (keyboard accessible), `Toast`, `Menu`, `CommandPalette`, `Badge/Chip`, `AssuranceBadge`, `VerdictBadge`, `Avatar`, `Progress/Ring`, `Skeleton`, `EmptyState`, `Table` (virtualized for scoreboards), `Pagination`, `Breadcrumbs`, `Stat`, `Timeline`, `Banner`, `CopyField`, `FileDrop`, `ResizableSplit`, `Markdown` (safe renderer), `CodeEditor` (CodeMirror 6 wrapper), `DiffView`, `Chart` (tiny, SVG; no heavy chart lib: sparkline, bar, line), `Countdown` (server-synced).
Each component: keyboard behavior documented, focus ring visible (`outline: 2px solid var(--focus)`), all states (hover, active, disabled, loading, error), tests, and a story in an internal `/_ui` route (dev only).

## 6. Information architecture → routes
Top nav (matches PDF): **Home · Arena · Exam · Forge · Passport · Bench** (role-based visibility; learners never see Forge staff tools).

| Route | Screen (PDF §) | Rendering | Notes |
|---|---|---|---|
| `/` | Landing (public) / Home (signed in) | SSR | Home: continue, upcoming contests, rating, daily challenge, Passport strength |
| `/arena` `/arena/contests/[slug]` | Arena, Scoreboard | SSR shell + client live | SSE stream; virtualized table; freeze banner |
| `/arena/problems/[slug]` | Workspace (Centaur) | SSR statement, client editor | Split panes; modes: Unaided / Centaur / Agent; submission history |
| `/exam/[id]` (instructor) | Exam instructor | client | Roster, mode, assurance, live monitor, replay |
| `/exam/session/[id]` (student) | Exam student + oral defence | client, minimal bundle | Lean route (budget below); offline-tolerant |
| `/forge` (staff/setter) | Forge Studio | client | Authoring, validation report, adversarial results |
| `/forge/portal` (customer) | Forge portal | SSR+client | Orders, deliveries, private evals |
| `/passport` | Passport | SSR | Credentials, share, privacy |
| `/verify/[id]` | Public verification | **SSR, cacheable** | The trust page: issuer, subject, assurance, evidence, signature status, revocation |
| `/employer` | Employer report | SSR+client | Candidate search, report with replay |
| `/bench` | Bench (public benchmark/leaderboards) | SSR | Human vs AI seasonal results |
| `/settings`, `/org/[slug]` | Account/org admin | client | Keys, members, SSO, data export |
| `/developers` | API docs | static | OpenAPI-rendered |

## 7. Key flows (implement exactly as designed; PDF §14)
1. **Solve & submit:** open problem → edit → *Run samples* (instant, sample-only) → *Submit* → verdict stream (SSE) → reveal → next problem suggestion. Shortcut `Ctrl/⌘+Enter` submit.
2. **Join a contest:** register (assurance requirement shown up front: "L1 needs ID check—takes ~2 min") → lobby with countdown synced to server → start → standings. Late join allowed per rules.
3. **Exam (student):** invite link → identity/consent screen (plain language; what's collected) → system check (browser, connection, fullscreen permission) → rules page → start → autosave + timer → submit → (optional) oral defence 3 short questions → confirmation. Reconnect path always restores state.
4. **Exam (instructor):** create exam (template) → import roster (CSV with preview/validation) → choose AI mode + assurance → schedule → live monitor → results with integrity evidence → export grades (CSV/LMS).
5. **Forge task:** author in Studio → submit for review → automated validation → attack results → release; customers see only released versions.
6. **Issue Passport credential:** event finalizes → credential issued → email → shareable `/verify` link + QR.
7. **Employer verification:** paste credential link or ID → report in < 10 s: assurance level, dimensions, AI mode, integrity record, replay highlights.

## 8. The workspace (most-used screen) — implementation details
- Layout: left panel statement (Markdown/KaTeX), right editor (CodeMirror 6) + bottom drawer (tests/samples/submissions). Panes resizable; sizes persisted in `localStorage` (non-sensitive).
- Editor: language mode, vim/emacs keymaps optional (lazy-loaded), tab size, font size, ligatures, themes. **Paste/edit telemetry hooks** are in the editor wrapper via CodeMirror transactions (only active in exam/rated contexts after consent) emitting `{kind: 'paste'|'edit_burst'|'blur'|'focus', size, ts}`; never raw keystroke content (store diffs only where the exam policy says so).
- **Centaur mode:** an in-product AI assistant panel (via API → `LlmProvider`), every prompt/response logged to the session (visible to the user: "This is recorded as part of your AI-allowed attempt"); cost shown as "AI-assist budget". Clear banner of current mode.
- Run samples runs on judge Tier-1 with a dedicated low-latency queue (`priority 0`, smaller limits); show output diff.
- Verdict panel: per-test grid (✓/✗/time/mem), first failing test details **only for public tests**; for hidden tests show test index and category only (never I/O).
- Drafts: local IndexedDB every 1 s (debounced), server every 5 s in exams; conflict policy: server `seq` wins, local older drafts offered as "Recover".

## 9. Scoreboard rendering
- Virtualized rows (≥ 5k), fixed row height, sticky header and "you" row pinned; solved cells color-coded with timestamps; first-solve indicator; freeze indicator with unfreeze ceremony (staff-controlled reveal animation optional).
- Data: one compressed snapshot + `seq` deltas (file 06 §6). Layout never shifts when updating; changed rows flash subtly (150 ms, reduced-motion safe).
- Density toggle (compact/comfortable); filters (country, university, friends); a "near you" slice by default for casual users to reduce comparison stress.

## 10. Performance budgets (CI-enforced via Lighthouse CI + bundle analyzer)
| Metric | Budget |
|---|---|
| LCP (p75, 4G mid-range phone) | ≤ 2.0 s (public pages ≤ 1.8 s) |
| INP (p75) | ≤ 150 ms |
| CLS | ≤ 0.02 |
| JS per route (gz) | public ≤ 120 KB; app routes ≤ 170 KB; **exam session route ≤ 140 KB** (editor lazy but prefetched); editor chunk ≤ 180 KB |
| Fonts | ≤ 2 families, variable, subset, preloaded, `font-display: swap` |
| Images | AVIF/WebP, explicit dimensions, lazy below the fold; no layout shift |
| Time to first verdict feedback | acknowledgement ≤ 100 ms; first stage event ≤ 500 ms |
| Memory | scoreboard 5k rows < 80 MB heap |
Rules: route-level code splitting; no client-side fetch waterfalls (parallel fetch/prefetch on hover); SSR for public pages with streaming; `Cache-Control` per file 06; `<link rel=preconnect>` only to own origins; web-vitals reported to our telemetry (privacy-preserving).

## 11. Accessibility (WCAG 2.2 AA is a release gate)
Semantic HTML first, ARIA only when needed; full keyboard operability incl. editor escape hatch (`Esc` then `Tab` documented; `Ctrl+M` toggle tab-focus mode); visible focus; skip links; `aria-live` for verdict/timer changes (polite, throttled); no color-only meaning; zoom 200 %/reflow 320 px; reduced motion; screen-reader labels for scoreboard cells ("Alice, rank 3, 5 solved, penalty 412"); captions/transcripts for any video; accessible exam accommodations (extra time per student, high-contrast, screen reader–compatible mode) built into the exam model. Automated axe checks in Playwright on every route + manual SR pass each stage.

## 12. Internationalization & localization
ICU message format via `next-intl` (or Lingui; decide in ADR). Launch locales: `en`, `bn` (Bangla); design for RTL and CJK. All strings extracted; no concatenated sentences; dates/numbers via `Intl`; time zones shown explicitly for contests ("18:00 UTC · 00:00 your time"). Problem statements may have multiple language versions; contest rules define which is authoritative.

## 13. Content design / microcopy
Tone: clear, respectful, concrete; no hype. Error pattern: *what happened → why → what to do* ("We couldn't save at 12:03. Your work is stored on this device. Retrying in 5 s."). Verdict language kind but exact ("Wrong answer on test 7 (hidden). Your output differs at line 2.") only where public. Integrity language neutral ("Flagged for review: large paste at 00:14. This is not a finding of misconduct.").

## 14. States (design every one)
Loading (skeleton), empty (teaches + CTA), partial, offline (banner + queue), error (retry + support code = `request_id`), rate-limited (explain + countdown), permission-denied (what role is needed + request access), maintenance, stale (SSE resync), contest-ended, exam-expired. The PDF §15 lists the canonical set; implement them as shared components.

## 15. Analytics & experimentation (privacy-first)
First-party, cookieless product analytics (events table + dashboards); no third-party trackers in authenticated areas; consent for anything beyond essential. Experiment framework: server-side flags with sticky bucketing; never experiment on exam UI or integrity logic; A/B test onboarding, home layout, scoreboard density, reminders cadence. North-star metrics: **verified events per week**, time-to-first-verdict, exam completion w/o data loss, Passport shares, employer report opens, Forge deliveries accepted.

## 16. Frontend engineering rules
- Server Components for static/SEO shells; Client Components for interactive; **no Server Actions** (file 03 §3).
- All API calls through `lib/api.ts` (typed from contracts, runtime-validates responses in dev, handles `problem+json`, `Retry-After`, 401 → re-auth flow).
- State: URL for shareable state; TanStack Query for server cache; minimal React state; no global store unless proven needed.
- Errors: React error boundaries per feature; report to Sentry with `request_id`; never show raw errors.
- Testing: component tests (Vitest + Testing Library + axe), Playwright for flows, visual regression for `ui/` components (Playwright screenshots) on key states.
- Forms: schema from contracts, accessible inline errors + error summary; double-submit protection.
