import { parseSync } from "oxc-parser";

// tigerlint enforces the TigerStyle rules that Biome cannot (docs/kit/02). Biome already covers
// `any`, non-null assertions, default exports and empty blocks. Everything here walks the syntax
// tree iteratively, because this tool must obey its own no-recursion rule.
//
// A rule can be waived on one line with a comment on that line or the line above:
//     // tigerlint-allow: <rule> -- <reason>
// The reason is mandatory so a reviewer can judge the waiver.

export interface Violation {
    readonly file: string;
    readonly line: number;
    readonly rule: string;
    readonly message: string;
}

export const FUNCTION_LINES_MAX = 70;
export const FILE_LINES_MAX = 600;
const NODES_MAX = 2_000_000; // Bounds the walk; a file this large is itself a violation.

interface Node {
    readonly type: string;
    readonly start: number;
    readonly end: number;
    readonly [key: string]: unknown;
}

interface Comment {
    readonly value: string;
    readonly start: number;
    readonly end: number;
}

interface Context {
    readonly file: string;
    readonly lineStarts: readonly number[];
    readonly comments: readonly Comment[];
    readonly taggedTemplates: WeakSet<Node>;
    readonly violations: Violation[];
}

const SQL_PATTERN =
    /\b(select\s[\s\S]+\sfrom\s|insert\s+into\s|update\s+\S+\s+set\s|delete\s+from\s)/i;
const ALLOW_PATTERN = /tigerlint-allow:\s*([a-z-]+)\s+--\s+\S/;

function isNode(value: unknown): value is Node {
    return typeof value === "object" && value !== null && "type" in value && "start" in value;
}

function field(node: Node, key: string): unknown {
    return node[key];
}

function child(node: Node, key: string): Node | null {
    const value = field(node, key);
    return isNode(value) ? value : null;
}

function nameOf(node: Node | null): string | null {
    if (node === null) return null;
    const name = field(node, "name");
    return typeof name === "string" ? name : null;
}

function* childNodes(node: Node): Generator<Node> {
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) yield item;
        } else if (isNode(value)) {
            yield value;
        }
    }
}

// Iterative depth-first walk. The visitor returns true to stop early.
function walk(root: Node, visit: (node: Node, parent: Node | null) => boolean | undefined): void {
    const stack: Array<{ node: Node; parent: Node | null }> = [{ node: root, parent: null }];
    let visited = 0;
    while (stack.length > 0) {
        const item = stack.pop();
        if (item === undefined || ++visited > NODES_MAX) return;
        if (visit(item.node, item.parent) === true) return;
        for (const next of childNodes(item.node)) stack.push({ node: next, parent: item.node });
    }
}

function computeLineStarts(source: string): number[] {
    const starts = [0];
    for (let index = 0; index < source.length; index++) {
        if (source.charCodeAt(index) === 10) starts.push(index + 1);
    }
    return starts;
}

function lineOf(lineStarts: readonly number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((lineStarts[middle] ?? 0) <= offset) low = middle;
        else high = middle - 1;
    }
    return low + 1;
}

function isWaived(context: Context, rule: string, line: number): boolean {
    return context.comments.some((comment) => {
        const match = ALLOW_PATTERN.exec(comment.value);
        if (match?.[1] !== rule) return false;
        const commentLine = lineOf(context.lineStarts, comment.end);
        return commentLine === line || commentLine === line - 1;
    });
}

function report(context: Context, node: Node, rule: string, message: string): void {
    const line = lineOf(context.lineStarts, node.start);
    if (isWaived(context, rule, line)) return;
    context.violations.push({ file: context.file, line, rule, message });
}

// ---- rules ----

function checkFunctionLength(context: Context, node: Node): void {
    const first = lineOf(context.lineStarts, node.start);
    const last = lineOf(context.lineStarts, node.end);
    const lines = last - first + 1;
    if (lines > FUNCTION_LINES_MAX) {
        report(
            context,
            node,
            "function-length",
            `function has ${lines} lines (max ${FUNCTION_LINES_MAX})`,
        );
    }
}

function functionName(node: Node, parent: Node | null): string | null {
    if (node.type === "FunctionDeclaration") return nameOf(child(node, "id"));
    if (parent?.type === "VariableDeclarator") return nameOf(child(parent, "id"));
    return null;
}

function checkRecursion(context: Context, node: Node, parent: Node | null): void {
    const name = functionName(node, parent);
    const body = child(node, "body");
    if (name === null || body === null) return;
    let recursive = false;
    walk(body, (inner) => {
        if (inner.type !== "CallExpression") return false;
        recursive = nameOf(child(inner, "callee")) === name;
        return recursive;
    });
    if (recursive) report(context, node, "no-recursion", `function ${name} calls itself`);
}

function checkAsCast(context: Context, node: Node): void {
    const annotation = child(node, "typeAnnotation");
    const isConst =
        annotation?.type === "TSTypeReference" && nameOf(child(annotation, "typeName")) === "const";
    if (!isConst)
        report(context, node, "no-as-cast", "type assertions hide bugs; parse or narrow instead");
}

function checkProcessEnv(context: Context, node: Node): void {
    const object = child(node, "object");
    const property = child(node, "property");
    if (nameOf(object) === "process" && nameOf(property) === "env") {
        const allowed = /(^|\/)(config\.ts|[^/]*-cli\.ts|[^/]*\.config\.ts|test-helpers\.ts)$/.test(
            context.file,
        );
        if (!allowed)
            report(context, node, "env-only-in-config", "read the environment only in config.ts");
    }
}

function checkCall(context: Context, node: Node): void {
    const callee = child(node, "callee");
    if (nameOf(callee) === "eval") report(context, node, "no-eval", "eval is forbidden");
    const isMember = callee?.type === "MemberExpression";
    if (isMember && nameOf(child(callee, "property")) === "unsafe") {
        report(
            context,
            node,
            "no-unsafe-sql",
            "sql.unsafe runs strings as SQL; use tagged templates",
        );
    }
}

function checkNew(context: Context, node: Node): void {
    if (nameOf(child(node, "callee")) === "Function") {
        report(context, node, "no-eval", "new Function is forbidden");
    }
}

function templateText(node: Node): string {
    const quasis = field(node, "quasis");
    if (!Array.isArray(quasis)) return "";
    const parts: string[] = [];
    for (const quasi of quasis) {
        const value = isNode(quasi) ? field(quasi, "value") : null;
        if (typeof value === "object" && value !== null && "raw" in value) {
            if (typeof value.raw === "string") parts.push(value.raw);
        }
    }
    return parts.join(" ");
}

function checkTemplate(context: Context, node: Node): void {
    if (context.taggedTemplates.has(node)) return;
    const expressions = field(node, "expressions");
    if (!Array.isArray(expressions) || expressions.length === 0) return;
    if (SQL_PATTERN.test(templateText(node))) {
        report(
            context,
            node,
            "no-string-sql",
            "SQL built with ${} interpolation; use a tagged template",
        );
    }
}

function checkConcatenation(context: Context, node: Node): void {
    if (field(node, "operator") !== "+") return;
    for (const side of [child(node, "left"), child(node, "right")]) {
        const value = side === null ? null : field(side, "value");
        if (typeof value === "string" && SQL_PATTERN.test(value)) {
            report(context, node, "no-string-sql", "SQL built by string concatenation");
        }
    }
}

function checkLoop(context: Context, node: Node): void {
    const test = child(node, "test");
    const unbounded = test === null ? node.type === "ForStatement" : field(test, "value") === true;
    if (!unbounded) return;
    const line = lineOf(context.lineStarts, node.start);
    const justified = context.comments.some((comment) => {
        const commentLine = lineOf(context.lineStarts, comment.end);
        return (
            /unbounded:\s*\S/.test(comment.value) &&
            (commentLine === line || commentLine === line - 1)
        );
    });
    if (!justified)
        report(context, node, "bounded-loops", "loop has no bound; add `// unbounded: <why>`");
}

function checkDirective(context: Context, node: Node): void {
    const directive = field(node, "directive");
    if (directive === "use server") {
        report(
            context,
            node,
            "no-server-actions",
            "Server Actions are forbidden (docs/kit/03 section 3)",
        );
    }
    if (directive === "use cache") {
        report(
            context,
            node,
            "no-next-cache",
            "framework caches had cross-user leaks; see ADR 0005",
        );
    }
}

// Next.js features with 2026 advisories that we do not need (ADR 0005).
function checkImport(context: Context, node: Node): void {
    const source = child(node, "source");
    if (source !== null && field(source, "value") === "next/og") {
        report(context, node, "no-next-og", "next/og had a critical advisory; see ADR 0005");
    }
}

function checkExport(context: Context, node: Node): void {
    const declaration = child(node, "declaration");
    const declarations = declaration === null ? null : field(declaration, "declarations");
    if (!Array.isArray(declarations)) return;
    for (const item of declarations) {
        if (isNode(item) && nameOf(child(item, "id")) === "revalidate") {
            report(
                context,
                node,
                "no-isr",
                "incremental static regeneration is not used; see ADR 0005",
            );
        }
    }
}

function checkJsxAttribute(context: Context, node: Node): void {
    if (nameOf(child(node, "name")) !== "dangerouslySetInnerHTML") return;
    if (!/render-markdown-safe\.tsx$/.test(context.file)) {
        report(context, node, "no-raw-html", "use renderMarkdownSafe(); never inject raw HTML");
    }
}

function checkNode(context: Context, node: Node, parent: Node | null): void {
    switch (node.type) {
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
            checkFunctionLength(context, node);
            checkRecursion(context, node, parent);
            break;
        case "TSAsExpression":
        case "TSTypeAssertion":
            checkAsCast(context, node);
            break;
        case "MemberExpression":
            checkProcessEnv(context, node);
            break;
        case "CallExpression":
            checkCall(context, node);
            break;
        case "NewExpression":
            checkNew(context, node);
            break;
        case "TaggedTemplateExpression": {
            const quasi = child(node, "quasi");
            if (quasi !== null) context.taggedTemplates.add(quasi);
            break;
        }
        case "TemplateLiteral":
            checkTemplate(context, node);
            break;
        case "BinaryExpression":
            checkConcatenation(context, node);
            break;
        case "WhileStatement":
        case "DoWhileStatement":
        case "ForStatement":
            checkLoop(context, node);
            break;
        case "ExpressionStatement":
            checkDirective(context, node);
            break;
        case "ImportDeclaration":
            checkImport(context, node);
            break;
        case "ExportNamedDeclaration":
            checkExport(context, node);
            break;
        case "JSXAttribute":
            checkJsxAttribute(context, node);
            break;
        default:
            break;
    }
}

function checkComments(context: Context): void {
    for (const comment of context.comments) {
        if (/@ts-(ignore|nocheck)\b/.test(comment.value)) {
            const node: Node = { type: "Comment", start: comment.start, end: comment.end };
            report(context, node, "no-ts-ignore", "do not silence the type checker");
        }
    }
}

// "Trojan Source": invisible or direction-changing characters make code read differently from how
// it runs. Raw ones are never needed in source; write them as escapes (docs/kit/08, supply chain).
const HIDDEN_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x200b, 0x200f], // zero-width characters and direction marks
    [0x202a, 0x202e], // embedding and override controls
    [0x2060, 0x2064], // word joiner and invisible operators
    [0x2066, 0x2069], // isolate controls
    [0xfeff, 0xfeff], // byte-order mark
];

function checkHiddenCharacters(context: Context, source: string): void {
    let offset = 0;
    for (const character of source) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (HIDDEN_CODE_POINT_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)) {
            const node: Node = { type: "Character", start: offset, end: offset + 1 };
            report(
                context,
                node,
                "no-hidden-characters",
                `invisible character U+${codePoint.toString(16)}`,
            );
        }
        offset += character.length;
    }
}

function isExemptFromFileLength(file: string): boolean {
    return /\.test\.tsx?$|\/generated\//.test(file);
}

export function lintSource(file: string, source: string): Violation[] {
    const lang = file.endsWith("x") ? "tsx" : "ts";
    const result = parseSync(file, source, { lang });
    const context: Context = {
        file,
        lineStarts: computeLineStarts(source),
        comments: result.comments,
        taggedTemplates: new WeakSet(),
        violations: [],
    };
    for (const error of result.errors) {
        context.violations.push({ file, line: 1, rule: "parse-error", message: error.message });
    }
    const program: unknown = result.program;
    if (isNode(program)) walk(program, (node, parent) => void checkNode(context, node, parent));
    checkComments(context);
    checkHiddenCharacters(context, source);
    const lineCount = context.lineStarts.length;
    if (lineCount > FILE_LINES_MAX && !isExemptFromFileLength(file)) {
        context.violations.push({
            file,
            line: 1,
            rule: "file-length",
            message: `file has ${lineCount} lines (max ${FILE_LINES_MAX})`,
        });
    }
    return context.violations;
}
