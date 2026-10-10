import { posix } from "node:path";
import { parseSync } from "oxc-parser";
import type { Violation } from "./tigerlint.ts";

// Import-graph rules from docs/kit/04 section 2. Paths are repository-relative with forward
// slashes. Only static top-level imports and re-exports are inspected.

interface ImportEdge {
    readonly from: string;
    readonly specifier: string;
    readonly line: number;
    readonly resolved: string | null; // Repository file for relative/workspace imports, else null.
    readonly typeOnly: boolean;
    readonly isReExportAll: boolean;
}

const MODULE_FILE = /^apps\/api\/src\/modules\/([^/]+)\/([^/]+)$/;
const NODE_IO_OR_FRAMEWORK = /^(node:|hono|postgres|pino|@aura\/db)/;

function resolveSpecifier(from: string, specifier: string): string | null {
    if (specifier.startsWith("."))
        return posix.normalize(posix.join(posix.dirname(from), specifier));
    const workspace = /^@aura\/([a-z]+)\/(.+)$/.exec(specifier);
    if (workspace !== null) return `packages/${workspace[1]}/src/${workspace[2]}.ts`;
    return null;
}

function lineAt(source: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset && index < source.length; index++) {
        if (source.charCodeAt(index) === 10) line++;
    }
    return line;
}

function collectEdges(file: string, source: string): ImportEdge[] {
    const result = parseSync(file, source, { lang: file.endsWith("x") ? "tsx" : "ts" });
    const edges: ImportEdge[] = [];
    for (const statement of result.program.body) {
        const type: string = statement.type;
        const isImport = type === "ImportDeclaration";
        const isExportFrom = type === "ExportAllDeclaration" || type === "ExportNamedDeclaration";
        if (!isImport && !isExportFrom) continue;
        const sourceNode = "source" in statement ? statement.source : null;
        if (sourceNode === null || sourceNode === undefined) continue;
        const specifier = sourceNode.value;
        const kind = "importKind" in statement ? statement.importKind : "value";
        edges.push({
            from: file,
            specifier,
            line: lineAt(source, statement.start),
            resolved: resolveSpecifier(file, specifier),
            typeOnly: kind === "type",
            isReExportAll: type === "ExportAllDeclaration",
        });
    }
    return edges;
}

function violation(edge: ImportEdge, rule: string, message: string): Violation {
    return { file: edge.from, line: edge.line, rule, message };
}

// The bundle validator parses untrusted archives, so it gets no way to reach files, the network or
// other processes: it takes bytes and returns a value. Tests and the corpus tool read files.
const BUNDLE_FORBIDDEN_IMPORT =
    /^node:(fs|net|http|https|http2|child_process|dns|tls|dgram|worker_threads|vm|cluster|inspector)/;

function checkBundleLayering(edge: ImportEdge, workspace: string | undefined): Violation[] {
    const exempt = /\.test\.ts$|-cli\.ts$/.test(edge.from);
    if (!edge.from.startsWith("packages/bundle/") || exempt) return [];
    const out: Violation[] = [];
    if (workspace !== undefined && workspace !== "contracts") {
        out.push(violation(edge, "layering", "@aura/bundle may import only @aura/contracts"));
    }
    if (BUNDLE_FORBIDDEN_IMPORT.test(edge.specifier)) {
        out.push(violation(edge, "layering", "the bundle validator performs no I/O"));
    }
    return out;
}

function checkLayering(edge: ImportEdge): Violation[] {
    const out: Violation[] = [];
    const to = edge.resolved;
    const workspace = /^@aura\/([a-z]+)/.exec(edge.specifier)?.[1];
    if (edge.from.startsWith("apps/web/") && workspace !== undefined && workspace !== "contracts") {
        out.push(violation(edge, "layering", "apps/web may import only @aura/contracts"));
    }
    if (edge.from.startsWith("packages/contracts/") && workspace !== undefined) {
        out.push(violation(edge, "layering", "@aura/contracts imports nothing from the workspace"));
    }
    if (
        edge.from.startsWith("packages/db/") &&
        workspace !== undefined &&
        workspace !== "contracts"
    ) {
        out.push(violation(edge, "layering", "@aura/db may import only @aura/contracts"));
    }
    out.push(...checkBundleLayering(edge, workspace));
    if (to !== null && edge.specifier.startsWith(".")) {
        const [root, name] = edge.from.split("/");
        const [toRoot, toName] = to.split("/");
        if ((root === "apps" || root === "packages") && (toRoot !== root || toName !== name)) {
            out.push(
                violation(
                    edge,
                    "layering",
                    "relative import leaves its package; use a workspace import",
                ),
            );
        }
    }
    if (edge.from.startsWith("apps/api/src/platform/") && to?.startsWith("apps/api/src/modules/")) {
        out.push(violation(edge, "layering", "platform must not import modules"));
    }
    return out;
}

function checkModuleBoundaries(edge: ImportEdge): Violation[] {
    const fromMatch = MODULE_FILE.exec(edge.from);
    if (fromMatch === null) return [];
    const out: Violation[] = [];
    const [, fromModule, fromFile] = fromMatch;
    const toMatch = edge.resolved === null ? null : MODULE_FILE.exec(edge.resolved);
    if (toMatch !== null && toMatch[1] !== fromModule && toMatch[2] !== "service.ts") {
        out.push(
            violation(edge, "module-boundary", "other modules are reached only through service.ts"),
        );
    }
    if (fromFile === "rules.ts" && !edge.typeOnly && NODE_IO_OR_FRAMEWORK.test(edge.specifier)) {
        out.push(
            violation(
                edge,
                "pure-rules",
                "rules.ts is pure: no I/O, framework or database imports",
            ),
        );
    }
    if (
        fromFile === "rules.ts" &&
        edge.resolved?.startsWith("apps/api/src/platform/") &&
        !edge.typeOnly
    ) {
        if (!/\/platform\/result\.ts$/.test(edge.resolved)) {
            out.push(violation(edge, "pure-rules", "rules.ts may use only platform/result.ts"));
        }
    }
    return out;
}

function checkBarrels(edge: ImportEdge): Violation[] {
    if (!edge.isReExportAll) return [];
    return [
        violation(edge, "no-barrels", "`export *` creates a barrel; import from the file instead"),
    ];
}

// Colored depth-first search with an explicit stack finds one cycle per strongly tangled start.
function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
    const state = new Map<string, "active" | "done">();
    const cycles: string[][] = [];
    for (const start of graph.keys()) {
        if (state.has(start)) continue;
        const path: string[] = [];
        const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
        state.set(start, "active");
        path.push(start);
        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            if (top === undefined) break;
            const neighbors = graph.get(top.node) ?? [];
            const target = neighbors[top.next++];
            if (target === undefined) {
                state.set(top.node, "done");
                stack.pop();
                path.pop();
            } else if (state.get(target) === "active") {
                cycles.push([...path.slice(path.indexOf(target)), target]);
            } else if (!state.has(target) && graph.has(target)) {
                state.set(target, "active");
                path.push(target);
                stack.push({ node: target, next: 0 });
            }
        }
    }
    return cycles;
}

export function lintImports(files: ReadonlyMap<string, string>): Violation[] {
    const violations: Violation[] = [];
    const graph = new Map<string, string[]>();
    for (const [file, source] of files) {
        const targets: string[] = [];
        for (const edge of collectEdges(file, source)) {
            violations.push(
                ...checkLayering(edge),
                ...checkModuleBoundaries(edge),
                ...checkBarrels(edge),
            );
            if (edge.resolved !== null && files.has(edge.resolved) && !edge.typeOnly)
                targets.push(edge.resolved);
        }
        graph.set(file, targets);
    }
    for (const cycle of findCycles(graph)) {
        violations.push({
            file: cycle[0] ?? "",
            line: 1,
            rule: "no-cycles",
            message: `import cycle: ${cycle.join(" -> ")}`,
        });
    }
    return violations;
}
