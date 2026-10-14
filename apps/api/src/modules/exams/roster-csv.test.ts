// Goal: the roster file is accepted whole or refused whole, and a refusal names the lines. Method: good
// files in the shapes people really produce (CRLF, BOM, quotes, blank lines), then each way a line can be bad.

import { describe, expect, it } from "vitest";
import { parseRosterCsv } from "./roster-csv.ts";

describe("parseRosterCsv", () => {
    it("reads a plain file, a file with extra minutes, CRLF, a BOM, blank lines and quoted fields", () => {
        const text = `${String.fromCharCode(0xfeff)}email,name,extra_minutes\r\nAda@Example.com,"Lovelace, Ada",30\r\n\r\nben@example.com,"Ben ""B"" Lee",0\r\n`;
        const parsed = parseRosterCsv(text);
        expect(parsed).toEqual({
            ok: true,
            people: [
                { email: "ada@example.com", name: "Lovelace, Ada", extra_minutes: 30 },
                { email: "ben@example.com", name: 'Ben "B" Lee', extra_minutes: 0 },
            ],
        });
        expect(parseRosterCsv("email,name\ncal@example.com,Cal\n")).toEqual({
            ok: true,
            people: [{ email: "cal@example.com", name: "Cal", extra_minutes: 0 }],
        });
    });

    it("refuses a missing or wrong header, an empty file and the wrong number of fields", () => {
        for (const text of [
            "",
            "name,email\nA,a@b.co\n",
            "email,name,minutes\na@b.co,A,1\n",
            "email\n",
        ]) {
            expect(parseRosterCsv(text).ok).toBe(false);
        }
        expect(parseRosterCsv("email,name\n")).toMatchObject({
            ok: false,
            problems: ["the file has no people"],
        });
        const wide = parseRosterCsv("email,name\na@b.co,A,extra\n");
        expect(wide).toMatchObject({ ok: false });
        expect(JSON.stringify(wide)).toContain("line 2: 2 fields expected, 3 found");
    });

    it("refuses bad emails, bad minutes, duplicates and an unclosed quote, naming the lines", () => {
        const parsed = parseRosterCsv(
            'email,name,extra_minutes\nnot-an-email,A,0\na@b.co,B,481\na@b.co,C,x\nd@b.co,"D,0\ne@b.co,E,0\ne@b.co,F,0\n',
        );
        expect(parsed.ok).toBe(false);
        const text = JSON.stringify(parsed);
        for (const line of ["line 2", "line 3", "line 4", "line 5", "line 7"])
            expect(text).toContain(line);
        expect(text).toContain("appears twice");
    });

    it("bounds the people and the lines it reports", () => {
        const many = `email,name\n${Array.from({ length: 5001 }, (_, i) => `p${i}@b.co,P`).join("\n")}\n`;
        expect(parseRosterCsv(many)).toMatchObject({ ok: false });
        const exactly = `email,name\n${Array.from({ length: 5000 }, (_, i) => `p${i}@b.co,P`).join("\n")}\n`;
        expect(parseRosterCsv(exactly).ok).toBe(true);
        const bad = `email,name\n${Array.from({ length: 100 }, () => "x,P").join("\n")}\n`;
        const refused = parseRosterCsv(bad);
        expect(refused.ok === false && refused.problems.length).toBe(20);
    });
});
