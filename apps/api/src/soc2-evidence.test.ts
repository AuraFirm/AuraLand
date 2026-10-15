// Goal: the evidence document says what it found, counts honestly, and cannot be broken by the text of a finding.
import { describe, expect, it } from "vitest";
import { renderEvidence } from "./soc2-evidence.ts";

describe("renderEvidence", () => {
    const items = [
        {
            area: "CC8.1 change management",
            check: "main is protected",
            found: "ruleset active",
            status: "evidenced" as const,
        },
        {
            area: "CC7.1 monitoring",
            check: "alerts exist",
            found: "none | no cloud",
            status: "not_evidenced" as const,
        },
        { area: "CC6.1 access", check: "reviews", found: "one-off", status: "partial" as const },
    ];
    it("counts each status and dates the document", () => {
        const text = renderEvidence(items, "2026-10-15");
        expect(text).toContain("# SOC 2 readiness evidence, 2026-10-15");
        expect(text).toContain("Summary: 1 evidenced, 1 partial, 1 not evidenced.");
    });
    it("says plainly that it is not an audit", () => {
        expect(renderEvidence([], "2026-10-15")).toContain("not an audit and not a SOC 2 report");
    });
    it("keeps a table cell from breaking the table", () => {
        const row =
            renderEvidence(items, "2026-10-15")
                .split("\n")
                .find((l) => l.includes("alerts exist")) ?? "";
        expect(row.split("|").length).toBe(6);
        expect(row).toContain("NOT evidenced");
    });
});
