// Goal: every tigerlint rule must fire on a violating fixture and stay quiet on a conforming one,
// including at the boundary (exactly at the limit passes, one over fails) and with waivers.
import { describe, expect, it } from "vitest";
import { FUNCTION_LINES_MAX, lintSource } from "./tigerlint.ts";

function rules(source: string, file = "apps/api/src/x.ts"): string[] {
    return lintSource(file, source).map((v) => v.rule);
}

function functionOfLines(lineCount: number): string {
    const body = Array.from({ length: lineCount - 2 }, () => "    noop();").join("\n");
    return `function big(): void {\n${body}\n}\n`;
}

describe("function-length", () => {
    it("allows exactly the limit and rejects one line more", () => {
        expect(rules(functionOfLines(FUNCTION_LINES_MAX))).not.toContain("function-length");
        expect(rules(functionOfLines(FUNCTION_LINES_MAX + 1))).toContain("function-length");
    });

    it("measures arrow functions and methods too", () => {
        const arrow = `const f = () => {\n${"    noop();\n".repeat(70)}};\n`;
        expect(rules(arrow)).toContain("function-length");
    });
});

describe("file-length", () => {
    const longFile = `${"noop();\n".repeat(600)}`;
    it("rejects a file over 600 lines but exempts tests and generated code", () => {
        expect(rules(longFile)).toContain("file-length");
        expect(rules(longFile, "apps/api/src/x.test.ts")).not.toContain("file-length");
        expect(rules(longFile, "packages/contracts/src/generated/x.ts")).not.toContain(
            "file-length",
        );
        expect(rules("noop();\n".repeat(598))).not.toContain("file-length");
    });
});

describe("no-recursion", () => {
    it("flags a function that calls itself, in all declaration forms", () => {
        expect(rules("function f(n: number): number { return n ? f(n - 1) : 0; }")).toContain(
            "no-recursion",
        );
        expect(rules("const g = (n: number): number => (n ? g(n - 1) : 0);")).toContain(
            "no-recursion",
        );
    });

    it("does not flag calls to other functions or to a same-named method", () => {
        expect(rules("function f(): void { g(); }\nfunction g(): void {}")).not.toContain(
            "no-recursion",
        );
        expect(rules("function f(o: { f(): void }): void { o.f(); }")).not.toContain(
            "no-recursion",
        );
    });
});

describe("no-as-cast", () => {
    it("flags assertions and angle-bracket assertions but allows `as const`", () => {
        expect(rules("const a = b as Foo;")).toContain("no-as-cast");
        expect(rules("const a = <Foo>b;", "a.ts")).toContain("no-as-cast");
        expect(rules("const a = [1] as const;")).not.toContain("no-as-cast");
    });

    it("honors a waiver with a reason, and rejects one without a reason", () => {
        const waived =
            "// tigerlint-allow: no-as-cast -- library types wrap the value\nconst a = b as Foo;";
        expect(rules(waived)).not.toContain("no-as-cast");
        const noReason = "// tigerlint-allow: no-as-cast\nconst a = b as Foo;";
        expect(rules(noReason)).toContain("no-as-cast");
        const farAway = "// tigerlint-allow: no-as-cast -- x\n\nconst a = b as Foo;";
        expect(rules(farAway)).toContain("no-as-cast");
    });
});

describe("env-only-in-config", () => {
    it("flags process.env outside config and cli entry points", () => {
        expect(rules("const a = process.env.X;")).toContain("env-only-in-config");
        expect(rules("const a = process.env.X;", "apps/api/src/config.ts")).not.toContain(
            "env-only-in-config",
        );
        expect(rules("const a = process.env.X;", "packages/db/src/migrate-cli.ts")).not.toContain(
            "env-only-in-config",
        );
        expect(rules("const a = process.env.X;", "apps/web/next.config.ts")).not.toContain(
            "env-only-in-config",
        );
    });
});

describe("sql rules", () => {
    it("flags unsafe, interpolated untagged SQL and concatenated SQL", () => {
        expect(rules("tx.unsafe(text);")).toContain("no-unsafe-sql");
        expect(rules("const q = `select * from t where id = ${id}`;")).toContain("no-string-sql");
        expect(rules('const q = "select * from t where id = " + id;')).toContain("no-string-sql");
        expect(rules("const q = `delete from t where a = ${a}`;")).toContain("no-string-sql");
    });

    it("allows tagged templates, plain strings and unrelated templates", () => {
        expect(rules("const q = sql`select * from t where id = ${id}`;")).not.toContain(
            "no-string-sql",
        );
        expect(rules("const q = `select * from t`;")).not.toContain("no-string-sql");
        expect(rules("const m = `Selected ${n} items from the list`;")).not.toContain(
            "no-string-sql",
        );
    });
});

describe("eval", () => {
    it("flags eval and new Function", () => {
        expect(rules("eval(x);")).toContain("no-eval");
        expect(rules('new Function("return 1");')).toContain("no-eval");
        expect(rules("evaluate(x);")).not.toContain("no-eval");
    });
});

describe("bounded-loops", () => {
    it("flags unbounded loops unless justified", () => {
        expect(rules("while (true) { step(); }")).toContain("bounded-loops");
        expect(rules("for (;;) { step(); }")).toContain("bounded-loops");
        expect(
            rules("// unbounded: event loop runs until shutdown\nwhile (true) { step(); }"),
        ).not.toContain("bounded-loops");
        expect(rules("for (let i = 0; i < 3; i++) { step(); }")).not.toContain("bounded-loops");
        expect(rules("while (queue.length > 0) { step(); }")).not.toContain("bounded-loops");
    });
});

describe("web rules", () => {
    it('flags "use server" and raw HTML injection', () => {
        expect(rules('"use server";\nexport async function a() {}', "apps/web/src/a.ts")).toContain(
            "no-server-actions",
        );
        const jsx = "export const A = () => <div dangerouslySetInnerHTML={{ __html: h }} />;";
        expect(rules(jsx, "apps/web/src/a.tsx")).toContain("no-raw-html");
        expect(rules(jsx, "apps/web/src/lib/render-markdown-safe.tsx")).not.toContain(
            "no-raw-html",
        );
        expect(rules('"use client";\nexport const a = 1;', "apps/web/src/a.ts")).not.toContain(
            "no-server-actions",
        );
    });
});

describe("next.js features we do not use", () => {
    it("flags next/og, the use cache directive and revalidate exports", () => {
        expect(rules('import { ImageResponse } from "next/og";')).toContain("no-next-og");
        expect(rules('import { headers } from "next/headers";')).not.toContain("no-next-og");
        expect(rules('"use cache";\nexport const a = 1;')).toContain("no-next-cache");
        expect(rules("export const revalidate = 60;")).toContain("no-isr");
        expect(rules("export const dynamic = 'force-dynamic';")).not.toContain("no-isr");
    });
});

describe("ts-ignore and parse errors", () => {
    it("flags ts-ignore and ts-nocheck but not ts-expect-error", () => {
        expect(rules("// @ts-ignore\nconst a: number = 'x';")).toContain("no-ts-ignore");
        expect(rules("// @ts-nocheck\nconst a = 1;")).toContain("no-ts-ignore");
        expect(rules("// @ts-expect-error: testing\nconst a: number = 'x';")).not.toContain(
            "no-ts-ignore",
        );
    });

    it("reports syntax errors instead of silently passing", () => {
        expect(rules("const = ;")).toContain("parse-error");
    });
});

describe("conforming code", () => {
    it("produces no violations", () => {
        const clean = [
            "export function add(a: number, b: number): number {",
            "    return a + b;",
            "}",
        ].join("\n");
        expect(lintSource("apps/api/src/add.ts", clean)).toEqual([]);
    });

    it("reports 1-based line numbers", () => {
        const found = lintSource("a.ts", "const ok = 1;\n\nconst a = b as Foo;\n");
        expect(found[0]?.line).toBe(3);
    });
});
