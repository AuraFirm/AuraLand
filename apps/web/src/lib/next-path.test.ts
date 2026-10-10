// Goal: the post-sign-in address can only ever be a plain path on this site.
import { describe, expect, it } from "vitest";
import { safeNextPath } from "./next-path.ts";

describe("safeNextPath", () => {
    it("accepts plain paths, with query strings", () => {
        expect(safeNextPath("/orgs", "/account")).toBe("/orgs");
        expect(safeNextPath("/invitations/accept", "/account")).toBe("/invitations/accept");
        expect(safeNextPath("/orgs?x=1", "/account")).toBe("/orgs?x=1");
    });

    it("falls back for anything that could leave the site or smuggle characters", () => {
        for (const bad of [
            "//evil.example",
            "https://evil.example/x",
            "http://localhost:3000/x",
            "/\\evil.example",
            "javascript:alert(1)",
            "orgs",
            "",
            "/a\nb",
            "/a\u0000b",
            `/${"a".repeat(300)}`,
        ]) {
            expect(safeNextPath(bad, "/account"), JSON.stringify(bad)).toBe("/account");
        }
        expect(safeNextPath(null, "/account")).toBe("/account");
        expect(safeNextPath(undefined, "/account")).toBe("/account");
    });
});
