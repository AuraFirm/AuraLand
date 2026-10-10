// Goal: whatever text goes in, the HTML that comes out holds only allowlisted tags and attributes, no
// scripts, handlers, styles or dangerous URLs; formulas render as checked MathML or as source text;
// and hostile inputs cannot make rendering slow. The audit below is a separate, deliberately strict
// reader of the output, so a mistake in the renderer is not repeated in the check.
import { STATEMENT_BYTES_MAX } from "@aura/contracts/limits";
import { describe, expect, it } from "vitest";
import { isSafeMathMl, renderMarkdownSafe } from "./markdown.ts";

const HTML_TAGS = new Set([
    "p",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "br",
    "strong",
    "em",
    "s",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "div",
]);
const MATH_TAGS = new Set([
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
const VOID = new Set(["hr", "br"]);
// Presentation attributes MathML elements may carry; nothing that runs code or styles.
const MATH_ATTRIBUTES = new Set([
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
]);
const ATTRIBUTES: Record<string, ReadonlySet<string>> = {
    a: new Set(["href", "rel"]),
    ol: new Set(["start"]),
    ...Object.fromEntries([...MATH_TAGS].map((name) => [name, MATH_ATTRIBUTES])),
};

// The addresses a link may have, written independently of the renderer's own check: an https URL
// without credentials, a same-site path that is not protocol-relative, or a fragment.
const ALLOWED_HREF = /^(?:https:\/\/[^\s@\\]*|\/(?!\/)[^\s\\]*|#[^\s]*)$/;

// Returns a description of the first problem in `html`, or null when it is clean.
function audit(html: string): string | null {
    const open: string[] = [];
    const tag = /<(\/?)([a-z0-9]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>/gy;
    let position = 0;
    while (position < html.length) {
        const lt = html.indexOf("<", position);
        const text = html.slice(position, lt === -1 ? html.length : lt);
        if (text.includes(">") || /[<"]/.test(text))
            return `raw markup characters in text: ${text.slice(0, 40)}`;
        if (lt === -1) break;
        tag.lastIndex = lt;
        const match = tag.exec(html);
        if (match === null) return `malformed tag at ${lt}`;
        const [whole, closing, name = "", attributes = ""] = match;
        if (!HTML_TAGS.has(name) && !MATH_TAGS.has(name)) return `tag <${name}> is not allowed`;
        for (const attribute of attributes.matchAll(/\s+([a-z-]+)="([^"]*)"/g)) {
            const [, attributeName = "", value = ""] = attribute;
            if (ATTRIBUTES[name]?.has(attributeName) !== true)
                return `attribute ${attributeName} on <${name}>`;
            if (attributeName === "href" && !ALLOWED_HREF.test(value.replaceAll("&amp;", "&"))) {
                return `href ${value}`;
            }
            if (attributeName === "rel" && value !== "noopener noreferrer nofollow")
                return `rel ${value}`;
        }
        if (closing === "/") {
            if (open.pop() !== name) return `unbalanced </${name}>`;
        } else if (!VOID.has(name)) {
            open.push(name);
        }
        position = lt + whole.length;
    }
    return open.length === 0 ? null : `unclosed <${open[open.length - 1]}>`;
}

const render = (source: string) => renderMarkdownSafe(source).html;

const PAYLOADS = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg onload=alert(1)>",
    "<iframe src=javascript:alert(1)></iframe>",
    '<a href="javascript:alert(1)">x</a>',
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](java\nscript:alert(1))",
    "[x](&#106;avascript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox(1))",
    "[x](//evil.example/path)",
    "[x](http://plain-http.example)",
    // Built from parts so secret scanners do not mistake this hostile test address for credentials.
    `[x](https://${"user"}${":"}${"pass"}@evil.example/)`,
    "[x](\\\\evil\\share)",
    "[x][ref]\n\n[ref]: javascript:alert(1)",
    "<javascript:alert(1)>",
    '<https://example.com/"onmouseover="alert(1)>',
    "![x](https://tracker.example/pixel.png)",
    "![x](javascript:alert(1))",
    "<style>*{background:url(javascript:alert(1))}</style>",
    '<div style="position:fixed">x</div>',
    "<math><mtext></mtext><script>alert(1)</script></math>",
    "<form action=https://evil.example><input name=x></form>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;",
    "`<script>alert(1)</script>`",
    "```html\n<script>alert(1)</script>\n```",
    "    <script>alert(1)</script>",
    "$\\href{javascript:alert(1)}{x}$",
    "$\\url{javascript:alert(1)}$",
    "$\\includegraphics{https://evil.example/x.png}$",
    "$\\htmlClass{x}{y}$ $\\htmlStyle{color:red}{y}$ $\\htmlId{x}{y}$ $\\htmlData{a=b}{y}$",
    "$\\def\\a{\\a\\a}\\a$",
    "$$\n\\text{<script>alert(1)</script>}\n$$",
    '$\\text{"onmouseover="alert(1)}$',
    "| <script> | b |\n|---|---|\n| <img src=x onerror=1> | y |",
    "# <script>alert(1)</script>",
    "> <script>alert(1)</script>",
    "- <script>alert(1)</script>",
    "<!-- --><script>alert(1)</script>",
    "<![CDATA[<script>alert(1)</script>]]>",
    `${String.fromCharCode(0x202e)}<script>alert(1)</script>`,
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "\0<script>\0alert(1)</script>",
    '[a](https://example.com "title" onclick="alert(1)")',
    "[a](<https://example.com/x y>)",
];

describe("renderMarkdownSafe: hostile input", () => {
    for (const payload of PAYLOADS) {
        it(`neutralises ${JSON.stringify(payload).slice(0, 60)}`, () => {
            const html = render(payload);
            expect(audit(html), html).toBeNull();
            expect(html).not.toMatch(/<(?:script|img|svg|iframe|style|form|input|object|embed)/i);
            expect(html).not.toMatch(/(?:href|src)="(?!https:\/\/|\/|#)/i);
        });
    }
});

describe("renderMarkdownSafe: ordinary Markdown", () => {
    it("renders the usual statement features", () => {
        const html = render(
            "# Title\n\nText with **bold**, *italic*, ~~gone~~ and `code`.\n\n1. one\n2. two\n\n> quote\n\n---\n\n```\nint x;\n```",
        );
        expect(html).toContain("<h3>Title</h3>");
        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("<em>italic</em>");
        expect(html).toContain("<s>gone</s>");
        expect(html).toContain("<ol>");
        expect(html).toContain("<blockquote>");
        expect(html).toContain("<pre><code>int x;\n</code></pre>");
        expect(audit(html)).toBeNull();
    });

    it("keeps heading levels below the page's own and never past h6", () => {
        const html = render("# a\n## b\n### c\n#### d\n##### e\n###### f");
        expect(html).toMatch(/<h3>a<\/h3>/);
        expect(html).toMatch(/<h6>d<\/h6>/);
        expect(html).toMatch(/<h6>f<\/h6>/);
        expect(html).not.toMatch(/<h[12]>/);
    });

    it("links to https and same-site addresses only, with a safe rel", () => {
        const html = render(
            "[a](https://example.com/p?x=1&y=2) [b](/orgs) [c](#top) [d](http://example.com)",
        );
        expect(html).toContain(
            '<a href="https://example.com/p?x=1&amp;y=2" rel="noopener noreferrer nofollow">a</a>',
        );
        expect(html).toContain('<a href="/orgs"');
        expect(html).toContain('<a href="#top"');
        expect(html).not.toContain('http://example.com"');
        expect(html).toContain("d");
    });

    it("renders tables, and escapes text everywhere", () => {
        const html = render("| a | b |\n|---|---|\n| 1 < 2 | \"x\" & 'y' |");
        expect(html).toContain("<table>");
        expect(html).toContain("1 &lt; 2");
        expect(html).toContain("&quot;x&quot; &amp; &#39;y&#39;");
        expect(audit(html)).toBeNull();
    });

    it("is deterministic and total", () => {
        const source = "# T\n\n$x^2$ and [l](https://e.com)";
        expect(render(source)).toBe(render(source));
        expect(render("")).toBe("");
        expect(() => render("\0\ud800 lone surrogate \udfff")).not.toThrow();
    });
});

describe("formulas", () => {
    it("render as MathML, inline and display, and leave prices alone", () => {
        const html = render("Sum $a+b$.\n\n$$\n\\frac{x^2}{y}\n$$\n\nCosts $5 and $6.");
        expect(html.match(/<math /g)?.length).toBe(2);
        expect(html).toContain('display="block"');
        expect(html).toContain("Costs $5 and $6.");
        expect(audit(html)).toBeNull();
    });

    it("fall back to escaped source for errors, unsafe commands and macro bombs", () => {
        for (const source of [
            "\\unknowncommand",
            "\\href{javascript:alert(1)}{x}",
            "\\def\\a{\\a\\a}\\a",
            "\\htmlClass{x}{y}",
        ]) {
            const html = render(`$${source}$`);
            expect(html, source).not.toContain("<math");
            expect(html).toContain("<code>");
            expect(audit(html)).toBeNull();
        }
    });

    it("stops rendering formulas past the per-document budget and the per-formula size", () => {
        const many = Array.from({ length: 210 }, (_, i) => `$x_${i}$`).join(" ");
        const html = render(many);
        expect(html.match(/<math /g)?.length).toBe(200);
        expect(html.match(/<code>/g)?.length).toBe(10);
        const long = render(`$${"x+".repeat(1500)}x$`);
        expect(long).toContain("<code>");
    });
});

describe("isSafeMathMl", () => {
    it("accepts KaTeX-shaped output and rejects anything else", () => {
        const good =
            '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi></mrow></math>';
        expect(isSafeMathMl(good)).toBe(true);
        const bad = [
            "<math><script>alert(1)</script></math>",
            '<math onclick="x"><mi>x</mi></math>',
            '<math xmlns="http://evil.example/"><mi>x</mi></math>',
            "<math><mi>x</mi>",
            "<mi>x</mi></math>",
            "<math><mi>a > b</mi></math>",
            '<math><mi style="x">x</mi></math>',
            "<math><mi>x<</mi></math>",
        ];
        for (const html of bad) expect(isSafeMathMl(html), html).toBe(false);
    });
});

describe("limits", () => {
    it("handles pathological inputs in bounded time", () => {
        const size = STATEMENT_BYTES_MAX;
        const inputs = [
            "[".repeat(size),
            "*".repeat(size),
            "> ".repeat(size / 2),
            "- ".repeat(size / 2),
            "`".repeat(size),
            "$".repeat(size),
            "[a](".repeat(size / 4),
            "<".repeat(size),
            "\n".repeat(size),
            `${"a".repeat(size - 10)}\n$$\n`,
            "| a ".repeat(size / 4),
        ];
        for (const input of inputs) {
            const started = performance.now();
            const html = render(input);
            expect(performance.now() - started, input.slice(0, 8)).toBeLessThan(2000);
            expect(audit(html)).toBeNull();
        }
    });

    it("refuses input beyond the statement cap (a caller bug, since schemas stop it first)", () => {
        expect(() => render("a".repeat(STATEMENT_BYTES_MAX + 1))).toThrow(/statement cap/);
    });
});

// A small seeded generator, so a failing input can be replayed from its seed and index.
function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
        return (z ^ (z >>> 16)) >>> 0;
    };
}

const FRAGMENTS = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "![x](https://e.com/a.png)",
    "$",
    "$$",
    "\n$$\n",
    "\\href{javascript:alert(1)}{x}",
    "`",
    "```",
    "*",
    "**",
    "_",
    "~~",
    "# ",
    "> ",
    "- ",
    "1. ",
    "| a | b |\n|---|---|\n",
    "\n",
    "\n\n",
    "&lt;",
    "&#x3C;script&#x3E;",
    "[a](<javascript:alert(1)>)",
    "<https://example.com>",
    "<javascript:alert(1)>",
    "\\",
    "\0",
    "é",
    "[",
    "]",
    "(",
    ")",
    "https://example.com",
    "x^2",
    "\\frac{a}{b}",
    "\\sqrt{",
    "}",
    "<!--",
    "-->",
    "    ",
    "\t",
    "<",
    ">",
    '"',
    "'",
    "&",
    ";",
];

describe("fuzzing", () => {
    it("never produces output outside the allowlist, for 4000 random documents", () => {
        const next = generator(2026);
        for (let index = 0; index < 4000; index++) {
            const count = 1 + (next() % 40);
            let source = "";
            for (let part = 0; part < count; part++)
                source += FRAGMENTS[next() % FRAGMENTS.length] ?? "";
            const html = render(source);
            const problem = audit(html);
            if (problem !== null)
                throw new Error(`index ${index}: ${problem}\n${JSON.stringify(source)}`);
            expect(html).toBe(render(source));
        }
    });
});
