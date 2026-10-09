// Goal: the dependency policy must reject unlisted, unpinned, over-budget, stale and
// ADR-less dependencies, and accept a conforming manifest.
import { describe, expect, it } from "vitest";
import { checkDependencies, type DependencyPolicy, type WorkspaceManifest } from "./depcheck.ts";

const adrs = new Set(["0001"]);
const policy: DependencyPolicy = {
    budgets: { "apps/api": 2 },
    allowed: { "apps/api": { hono: "0001", zod: "0001", vitest: "0001" } },
};

function rulesFor(manifest: Partial<WorkspaceManifest>, overridePolicy = policy): string[] {
    const full: WorkspaceManifest = { dependencies: {}, devDependencies: {}, ...manifest };
    return checkDependencies({ "apps/api": full }, overridePolicy, adrs).map((v) => v.rule);
}

describe("checkDependencies", () => {
    it("accepts a conforming manifest, including workspace links", () => {
        const manifest = {
            dependencies: { hono: "4.1.0", zod: "4.0.0", "@aura/contracts": "workspace:*" },
            devDependencies: { vitest: "5.0.0" },
        };
        const withAll = {
            budgets: policy.budgets,
            allowed: { "apps/api": { ...policy.allowed["apps/api"] } },
        };
        expect(rulesFor(manifest, withAll)).toEqual([]);
    });

    it("rejects ranges, tags and urls", () => {
        for (const version of ["^4.1.0", "~4.1.0", "latest", "github:a/b", "4.1"]) {
            expect(rulesFor({ dependencies: { hono: version } })).toContain("exact-version");
        }
        expect(rulesFor({ dependencies: { hono: "4.1.0-beta.1" } })).not.toContain("exact-version");
    });

    it("rejects dependencies that are not listed or cite a missing ADR", () => {
        expect(rulesFor({ dependencies: { leftpad: "1.0.0" } })).toContain("dependency-listed");
        const badAdr = { budgets: policy.budgets, allowed: { "apps/api": { hono: "0099" } } };
        expect(rulesFor({ dependencies: { hono: "4.1.0" } }, badAdr)).toContain("dependency-adr");
    });

    it("enforces the runtime budget exactly at the boundary", () => {
        const atBudget = { dependencies: { hono: "4.1.0", zod: "4.0.0" } };
        expect(rulesFor(atBudget)).not.toContain("dependency-budget");
        const over = { budgets: { "apps/api": 1 }, allowed: policy.allowed };
        expect(rulesFor(atBudget, over)).toContain("dependency-budget");
    });

    it("does not count dev dependencies or workspace links against the budget", () => {
        const manifest = {
            dependencies: { hono: "4.1.0", "@aura/x": "workspace:*" },
            devDependencies: { vitest: "5.0.0" },
        };
        const tight = { budgets: { "apps/api": 1 }, allowed: policy.allowed };
        expect(rulesFor(manifest, tight)).not.toContain("dependency-budget");
    });

    it("flags allowed entries that are no longer used, and unknown workspaces default to zero budget", () => {
        expect(rulesFor({ dependencies: { hono: "4.1.0" } })).toContain("dependency-stale");
        const none = checkDependencies(
            { "apps/new": { dependencies: { a: "1.0.0" }, devDependencies: {} } },
            policy,
            adrs,
        );
        expect(none.map((v) => v.rule)).toContain("dependency-budget");
    });
});
