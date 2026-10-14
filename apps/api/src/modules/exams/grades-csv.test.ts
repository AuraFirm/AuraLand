// Goal: the export is correct CSV and safe to open in a spreadsheet. Golden file for the shape, then the escapes.

import { describe, expect, it } from "vitest";
import { csvCell, gradesCsv } from "./grades-csv.ts";

describe("gradesCsv", () => {
    it("writes the header, one row per candidate, zero for an unanswered problem, and the total", () => {
        const csv = gradesCsv(
            ["A", "B"],
            [
                {
                    email: "ada@example.com",
                    name: "Ada",
                    sessionState: "submitted",
                    problems: [
                        { label: "A", totalMilli: 87_500 },
                        { label: "B", totalMilli: 40_000 },
                    ],
                },
                {
                    email: "ben@example.com",
                    name: "Ben",
                    sessionState: "expired",
                    problems: [{ label: "B", totalMilli: 12_250 }],
                },
            ],
        );
        expect(csv).toBe(
            "email,name,status,A,B,total\r\n" +
                "ada@example.com,Ada,submitted,87.5,40,127.5\r\n" +
                "ben@example.com,Ben,expired,0,12.25,12.25\r\n",
        );
    });
});

describe("csvCell", () => {
    it("quotes commas, quotes and newlines", () => {
        expect(csvCell("Lovelace, Ada")).toBe('"Lovelace, Ada"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell("two\nlines")).toBe('"two\nlines"');
        expect(csvCell("plain")).toBe("plain");
    });

    it("defuses anything a spreadsheet would run as a formula", () => {
        for (const bad of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"]) {
            expect(csvCell(bad).replaceAll('"', "").startsWith("'")).toBe(true);
        }
        expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    });
});
