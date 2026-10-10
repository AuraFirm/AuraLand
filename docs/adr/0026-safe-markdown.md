# 0026 — Rendering user Markdown safely
Status: accepted
Date: 2026-10-11

## Context
Task statements are Markdown written by users and shown to other users, so they are a stored-XSS
risk. The kit allows exactly one function to turn user text into HTML (`renderMarkdownSafe`) and asks
for KaTeX formulas, an XSS corpus and a browser test.

## Decision
- **Rendering happens in the API, in `platform/markdown.ts`.** The API sends `statement_html` with a
  single-version read; the web app places it with one component (`SafeHtml`) and nowhere else. One
  renderer means one place to test and fix, and `apps/web` stays free of Markdown dependencies (it may
  import only `@aura/contracts`).
- **Three layers, none of them a filter over HTML.** (1) `markdown-it` with raw HTML and images off.
  (2) Our own renderer over its token stream, which emits only a fixed list of tags and never calls
  markdown-it's renderer, so unknown tokens simply vanish. (3) Links must be `https` without
  credentials, a same-site path, or a fragment; anything else is shown as text.
- **Formulas: KaTeX in MathML-only mode, `trust: false`, no macros, bounded expansion,** at most 200
  per document and 2 KiB each. Its output is checked against a MathML grammar (tag and attribute
  allowlists, balanced, namespace fixed); on any doubt the formula appears as escaped source. MathML
  needs no stylesheet, font files or inline styles, so the strict CSP (no inline styles) is unchanged,
  and `apps/web` gains no dependency. All current evergreen browsers render MathML Core.
- **No new web dependency.** API dependencies: `markdown-it` 15.0.2 (ships its own types) and `katex`
  0.19.0 plus `@types/katex`.
- **Tests:** a corpus of 47 hostile inputs, a strict independent audit of every output (its own tag,
  attribute and link grammar, not the renderer's), 4,000 seeded random documents, pathological inputs
  with a time bound, and mutation checks of the renderer. A Semgrep rule bans `dangerouslySetInnerHTML`
  and `innerHTML` outside the one component; the browser check arrives with the statement page.

## Consequences
Images in statements are not supported yet (assets come with the sandboxed content origin). Rendering
runs per read of a version (at most 64 KiB of input; the test for pathological input bounds it at 2 s,
measured far lower), not on lists. If rendering ever shows up in profiles, cache the HTML by statement
hash.

## Alternatives considered
`sanitize-html` or DOMPurify over raw output (a second large dependency and the classic bypass
surface); rendering in the web app (breaks the layering rule and duplicates the dependency);
KaTeX HTML output (needs inline styles and font files, weakening the CSP).
