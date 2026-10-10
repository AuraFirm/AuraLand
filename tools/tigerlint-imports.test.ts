// Goal: the import-graph rules enforce the layering in docs/kit/04 section 2 on small fixtures.
import { describe, expect, it } from "vitest";
import { lintImports } from "./tigerlint-imports.ts";

function rulesFor(files: Record<string, string>): string[] {
    return lintImports(new Map(Object.entries(files))).map((v) => v.rule);
}

describe("layering", () => {
    it("lets apps/web import only @aura/contracts", () => {
        expect(rulesFor({ "apps/web/src/a.ts": 'import { x } from "@aura/db/client";' })).toContain(
            "layering",
        );
        expect(
            rulesFor({ "apps/web/src/a.ts": 'import { x } from "@aura/contracts/errors";' }),
        ).toEqual([]);
    });

    it("keeps contracts independent and db depending only on contracts", () => {
        expect(
            rulesFor({ "packages/contracts/src/a.ts": 'import { x } from "@aura/db/client";' }),
        ).toContain("layering");
        expect(
            rulesFor({ "packages/db/src/a.ts": 'import { x } from "@aura/contracts/assert";' }),
        ).toEqual([]);
    });

    it("keeps the bundle validator free of I/O and of other workspaces", () => {
        const rules = (file: string, line: string) => rulesFor({ [file]: line });
        expect(rules("packages/bundle/src/a.ts", 'import { x } from "node:fs";')).toContain(
            "layering",
        );
        expect(
            rules("packages/bundle/src/a.ts", 'import { x } from "node:child_process";'),
        ).toContain("layering");
        expect(rules("packages/bundle/src/a.ts", 'import { x } from "@aura/db/client";')).toContain(
            "layering",
        );
        expect(rules("packages/bundle/src/a.ts", 'import { x } from "node:zlib";')).toEqual([]);
        expect(
            rules("packages/bundle/src/a.ts", 'import { x } from "@aura/contracts/tasks";'),
        ).toEqual([]);
        // The corpus tool and tests do read files.
        expect(rules("packages/bundle/src/a-cli.ts", 'import { x } from "node:fs";')).toEqual([]);
        expect(rules("packages/bundle/src/a.test.ts", 'import { x } from "node:fs";')).toEqual([]);
    });

    it("forbids relative imports that leave a package", () => {
        const files = {
            "packages/db/src/a.ts": 'import { x } from "../../../apps/api/src/platform/clock.ts";',
        };
        expect(rulesFor(files)).toContain("layering");
    });

    it("forbids platform importing modules", () => {
        const files = {
            "apps/api/src/platform/a.ts": 'import { x } from "../modules/tasks/service.ts";',
            "apps/api/src/modules/tasks/service.ts": "export const x = 1;",
        };
        expect(rulesFor(files)).toContain("layering");
    });
});

describe("module boundaries", () => {
    it("allows cross-module imports only through service.ts", () => {
        const base = {
            "apps/api/src/modules/tasks/service.ts": "export const s = 1;",
            "apps/api/src/modules/tasks/queries.ts": "export const q = 1;",
        };
        const viaService = {
            ...base,
            "apps/api/src/modules/judge/service.ts": 'import { s } from "../tasks/service.ts";',
        };
        const viaQueries = {
            ...base,
            "apps/api/src/modules/judge/service.ts": 'import { q } from "../tasks/queries.ts";',
        };
        expect(rulesFor(viaService)).toEqual([]);
        expect(rulesFor(viaQueries)).toContain("module-boundary");
    });

    it("keeps rules.ts free of I/O, framework and database imports", () => {
        const rulesFile = (specifier: string) => ({
            "apps/api/src/modules/contests/rules.ts": `import { x } from "${specifier}";`,
        });
        expect(rulesFor(rulesFile("node:fs"))).toContain("pure-rules");
        expect(rulesFor(rulesFile("hono"))).toContain("pure-rules");
        expect(rulesFor(rulesFile("@aura/db/client"))).toContain("pure-rules");
        expect(rulesFor(rulesFile("@aura/contracts/errors"))).toEqual([]);
        const typeOnly = {
            "apps/api/src/modules/contests/rules.ts": 'import type { Hono } from "hono";',
        };
        expect(rulesFor(typeOnly)).toEqual([]);
    });
});

describe("barrels and cycles", () => {
    it("flags export-star barrels", () => {
        expect(
            rulesFor({ "packages/contracts/src/index.ts": 'export * from "./errors.ts";' }),
        ).toContain("no-barrels");
    });

    it("detects an import cycle and ignores type-only edges", () => {
        const cycle = {
            "apps/api/src/a.ts": 'import { b } from "./b.ts";',
            "apps/api/src/b.ts": 'import { c } from "./c.ts";',
            "apps/api/src/c.ts": 'import { a } from "./a.ts";',
        };
        expect(rulesFor(cycle)).toContain("no-cycles");
        const typeOnly = { ...cycle, "apps/api/src/c.ts": 'import type { a } from "./a.ts";' };
        expect(rulesFor(typeOnly)).not.toContain("no-cycles");
    });

    it("passes an acyclic diamond", () => {
        const diamond = {
            "apps/api/src/a.ts": 'import { b } from "./b.ts";\nimport { c } from "./c.ts";',
            "apps/api/src/b.ts": 'import { d } from "./d.ts";',
            "apps/api/src/c.ts": 'import { d } from "./d.ts";',
            "apps/api/src/d.ts": "export const d = 1;",
        };
        expect(rulesFor(diamond)).toEqual([]);
    });
});
