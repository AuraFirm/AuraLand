import { assert } from "@aura/contracts/assert";
import { STATEMENT_BYTES_MAX } from "@aura/contracts/limits";
import katex from "katex";
import MarkdownIt, { type StateBlock, type StateInline, type Token } from "markdown-it";

// renderMarkdownSafe: the only function that turns user Markdown into HTML (docs/kit/08, ADR 0026).
// Defence in depth, three layers:
//   1. markdown-it parses with raw HTML switched off and images disabled.
//   2. Our own renderer walks the token stream and emits only tags from a fixed list; it never calls
//      markdown-it's renderer, so there is no HTML-to-HTML filter to bypass. Unknown tokens vanish.
//   3. Formulas go through KaTeX in MathML-only mode with `trust: false`, and its output is checked
//      against a MathML grammar before use; on any doubt the formula is shown as escaped source.
// The output holds no scripts, no event handlers, no style attributes and no URLs other than https
// and same-site links, so a strict CSP (no inline styles, no inline scripts) holds with it.

const MATH_EXPRESSIONS_MAX = 200; // formulas per document; the rest show as source text
const MATH_SOURCE_BYTES_MAX = 2048; // one formula
const MATH_EXPAND_MAX = 200; // KaTeX macro expansions, against macro bombs
const OUTPUT_BYTES_MAX = 1024 * 1024; // above this the statement falls back to plain text

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};
export const escapeHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

// ---- Markdown parser -------------------------------------------------------------------------

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
// Images would load third-party content from a statement, which is a tracking and abuse vector;
// assets come with the sandboxed content origin in a later stage.
markdown.disable(["image", "html_block", "html_inline"]);

// Inline formulas: $x^2$. The opening dollar must not be followed by a space and the closing one not
// preceded by a space, so prices like "$5 and $6" stay text (the same rule Pandoc uses).
function mathInline(state: StateInline, silent: boolean): boolean {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x24 || state.src.charCodeAt(start + 1) === 0x24)
        return false;
    const next = state.src.charCodeAt(start + 1);
    if (Number.isNaN(next) || next === 0x20 || next === 0x09 || next === 0x0a) return false;
    let end = start + 1;
    // Bounded by the input length; each pass moves forward.
    while (end < state.posMax) {
        end = state.src.indexOf("$", end);
        if (end === -1 || end >= state.posMax) return false;
        if (state.src.charCodeAt(end - 1) !== 0x5c) break;
        end++;
    }
    const before = state.src.charCodeAt(end - 1);
    const content = state.src.slice(start + 1, end);
    if (end === start + 1 || before === 0x20 || before === 0x09 || content.includes("\n"))
        return false;
    if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = content;
    }
    state.pos = end + 1;
    return true;
}

// Display formulas: a line holding only $$, lines of TeX, a line holding only $$.
function mathBlock(
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
): boolean {
    const first = state.bMarks[startLine] ?? 0;
    const opening = state.src.slice(
        first + (state.tShift[startLine] ?? 0),
        state.eMarks[startLine],
    );
    if (opening.trim() !== "$$" || (state.sCount[startLine] ?? 0) - state.blkIndent >= 4)
        return false;
    let line = startLine + 1;
    // Bounded by the number of lines in the document.
    while (line < endLine) {
        const text = state.src.slice(state.bMarks[line] ?? 0, state.eMarks[line]).trim();
        if (text === "$$") break;
        line++;
    }
    if (line >= endLine) return false;
    if (silent) return true;
    const token = state.push("math_block", "math", 0);
    token.content = state.getLines(startLine + 1, line, state.blkIndent, false);
    token.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
}

markdown.inline.ruler.before("escape", "math_inline", mathInline);
markdown.block.ruler.before("fence", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
});

// ---- Formulas --------------------------------------------------------------------------------

const MATHML_TAGS = new Set([
    "math",
    "semantics",
    "mrow",
    "mi",
    "mn",
    "mo",
    "mtext",
    "mspace",
    "msup",
    "msub",
    "msubsup",
    "mfrac",
    "msqrt",
    "mroot",
    "mover",
    "munder",
    "munderover",
    "mtable",
    "mtr",
    "mtd",
    "mstyle",
    "mpadded",
    "mphantom",
    "menclose",
    "annotation",
]);
const MATHML_ATTRIBUTES = new Set([
    "xmlns",
    "display",
    "encoding",
    "mathvariant",
    "stretchy",
    "fence",
    "separator",
    "accent",
    "accentunder",
    "lspace",
    "rspace",
    "width",
    "height",
    "depth",
    "linethickness",
    "scriptlevel",
    "displaystyle",
    "columnalign",
    "rowalign",
    "rowspacing",
    "columnspacing",
    "minsize",
    "maxsize",
    "movablelimits",
    "notation",
    "symmetric",
    "largeop",
    "columnlines",
    "rowlines",
    "frame",
]);
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const KATEX_WRAPPER = /^<span class="katex">(<math[\s\S]*<\/math>)<\/span>$/;
const TAG = /<(\/?)([a-z]+)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*(\/?)>/gy;
const ATTRIBUTE = /\s+([a-zA-Z-]+)="([^"<>]*)"/g;

// True only if every `<` in the text starts a tag from the MathML list with attributes from the
// attribute list, and every tag is closed. KaTeX's output is machine-made, so this should always hold;
// the check exists so that a KaTeX bug cannot become a script injection.
export function isSafeMathMl(html: string): boolean {
    const open: string[] = [];
    let position = 0;
    // Each pass consumes text or one tag, so the loop ends within html.length passes.
    while (position < html.length) {
        const lt = html.indexOf("<", position);
        const text = html.slice(position, lt === -1 ? html.length : lt);
        if (text.includes(">")) return false;
        if (lt === -1) break;
        TAG.lastIndex = lt;
        const match = TAG.exec(html);
        if (match === null) return false;
        const [whole, closing, name = "", attributes = "", selfClosing] = match;
        if (!MATHML_TAGS.has(name)) return false;
        for (const attribute of attributes.matchAll(ATTRIBUTE)) {
            const [, attributeName = "", value = ""] = attribute;
            if (!MATHML_ATTRIBUTES.has(attributeName)) return false;
            if (attributeName === "xmlns" && value !== MATHML_NAMESPACE) return false;
        }
        if (closing === "/") {
            if (open.pop() !== name) return false;
        } else if (selfClosing !== "/") {
            open.push(name);
        }
        position = lt + whole.length;
    }
    return open.length === 0;
}

function renderFormula(source: string, display: boolean, budget: { formulas: number }): string {
    const fallback = `<code>${escapeHtml(source)}</code>`;
    budget.formulas++;
    if (budget.formulas > MATH_EXPRESSIONS_MAX) return fallback;
    if (Buffer.byteLength(source) > MATH_SOURCE_BYTES_MAX) return fallback;
    try {
        const html = katex.renderToString(source, {
            displayMode: display,
            output: "mathml",
            throwOnError: true,
            trust: false,
            strict: "error",
            maxExpand: MATH_EXPAND_MAX,
            maxSize: 10,
            macros: {},
        });
        // KaTeX wraps its MathML in one span; the wrapper is dropped and only the math is kept.
        const inner = KATEX_WRAPPER.exec(html)?.[1];
        return inner !== undefined && isSafeMathMl(inner) ? inner : fallback;
    } catch {
        return fallback;
    }
}

// ---- Renderer --------------------------------------------------------------------------------

const BLOCK_TAGS: Record<string, string> = {
    paragraph: "p",
    bullet_list: "ul",
    list_item: "li",
    blockquote: "blockquote",
    table: "table",
    thead: "thead",
    tbody: "tbody",
    tr: "tr",
    th: "th",
    td: "td",
};
const INLINE_TAGS: Record<string, string> = { strong: "strong", em: "em", s: "s" };

// Statement headings start below the page's own headings: # becomes h3, and nothing goes past h6.
const headingTag = (token: Token): string => `h${Math.min(6, Number(token.tag.slice(1)) + 2)}`;

// Links may point to https sites or to this site; everything else (javascript:, data:, mailto:, http:,
// protocol-relative, credentials in the address) is shown as plain text.
export function isAllowedLink(href: string): boolean {
    if (href.startsWith("#")) return true;
    if (href.startsWith("/")) return !href.startsWith("//") && !href.includes("\\");
    try {
        const url = new URL(href);
        return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
        return false;
    }
}

// Inline children are flat (images and HTML are off), so a token's own text is all there is to show.
function renderInline(tokens: readonly Token[], budget: { formulas: number }): string {
    let html = "";
    // Closing tags for links that were dropped, so an open/close pair stays balanced.
    const dropped: boolean[] = [];
    for (const token of tokens) {
        const tag = INLINE_TAGS[token.type.replace(/_(open|close)$/, "")];
        if (token.type === "text") html += escapeHtml(token.content);
        else if (token.type === "code_inline") html += `<code>${escapeHtml(token.content)}</code>`;
        else if (token.type === "softbreak") html += "\n";
        else if (token.type === "hardbreak") html += "<br>";
        else if (token.type === "math_inline") html += renderFormula(token.content, false, budget);
        else if (token.type === "link_open") {
            const href = String(token.attrGet("href") ?? "");
            const keep = isMarkdownLinkAllowed(href);
            dropped.push(!keep);
            if (keep) html += `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">`;
        } else if (token.type === "link_close") {
            if (dropped.pop() === false) html += "</a>";
        } else if (tag !== undefined) {
            html += token.type.endsWith("_open") ? `<${tag}>` : `</${tag}>`;
        } else {
            html += escapeHtml(token.content);
        }
    }
    return html;
}

const isMarkdownLinkAllowed = (href: string): boolean =>
    markdown.validateLink(href) && isAllowedLink(href);

function renderBlockToken(token: Token, budget: { formulas: number }): string {
    if (token.type === "heading_open") return `<${headingTag(token)}>`;
    if (token.type === "heading_close") return `</${headingTag(token)}>\n`;
    if (token.type === "ordered_list_open") {
        const start = Number(token.attrGet("start") ?? 1);
        const safe = Number.isInteger(start) && start >= 0 && start <= 999_999 && start !== 1;
        return safe ? `<ol start="${start}">` : "<ol>";
    }
    if (token.type === "ordered_list_close") return "</ol>\n";
    if (token.type === "hr") return "<hr>\n";
    if (token.type === "fence" || token.type === "code_block") {
        return `<pre><code>${escapeHtml(token.content)}</code></pre>\n`;
    }
    if (token.type === "math_block")
        return `<div>${renderFormula(token.content, true, budget)}</div>\n`;
    if (token.type === "inline") return renderInline(token.children ?? [], budget);
    const tag = BLOCK_TAGS[token.type.replace(/_(open|close)$/, "")];
    if (tag === undefined || token.hidden) return "";
    return token.type.endsWith("_open") ? `<${tag}>` : `</${tag}>\n`;
}

export interface SafeHtml {
    readonly html: string;
}

// Renders Markdown to HTML that is safe to place in a page. Total: any text in, HTML out, never an
// exception. Input beyond the statement cap is a caller bug (schemas enforce it at the boundary).
export function renderMarkdownSafe(source: string): SafeHtml {
    assert(
        Buffer.byteLength(source) <= STATEMENT_BYTES_MAX,
        "markdown input is within the statement cap",
    );
    const budget = { formulas: 0 };
    let html = "";
    for (const token of markdown.parse(source, {})) html += renderBlockToken(token, budget);
    // The fallback also covers a rendering result that is somehow too large.
    if (Buffer.byteLength(html) > OUTPUT_BYTES_MAX)
        return { html: `<pre>${escapeHtml(source)}</pre>` };
    return { html };
}
