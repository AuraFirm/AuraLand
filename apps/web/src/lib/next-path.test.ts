// Goal: the post-sign-in address can only ever be one of our own pages, and the value returned is
// always our copy, never the text we were given.
import { describe, expect, it } from "vitest";
import { safeNextPath } from "./next-path.ts";

describe("safeNextPath", () => {
    it("accepts the pages that make sense after signing in", () => {
        expect(safeNextPath("/orgs", "/account")).toBe("/orgs");
        expect(safeNextPath("/invitations/accept", "/account")).toBe("/invitations/accept");
        expect(safeNextPath("/account", "/orgs")).toBe("/account");
    });

    it("falls back for everything else, including near misses", () => {
        for (const bad of [
            "//evil.example",
            "https://evil.example/x",
            "http://localhost:3000/orgs",
            "/\\evil.example",
            "javascript:alert(1)",
            "orgs",
            "",
            "/orgs?x=1",
            "/orgs/",
            "/ORGS",
            "/orgs ",
            "/orgs\n",
            "/orgs#x",
            "/admin",
            `/${"a".repeat(300)}`,
        ]) {
            expect(safeNextPath(bad, "/account"), JSON.stringify(bad)).toBe("/account");
        }
        expect(safeNextPath(null, "/account")).toBe("/account");
        expect(safeNextPath(undefined, "/account")).toBe("/account");
    });
});
