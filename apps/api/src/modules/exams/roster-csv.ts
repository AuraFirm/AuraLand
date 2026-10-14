import { rosterRowSchema } from "@aura/contracts/exams";
import { EXAM_ROSTER_MAX } from "@aura/contracts/limits";

// The roster file, parsed and validated as a whole (Stage 6, ADR 0032 decision 5). Pure: no I/O. A file with
// any bad line writes nothing, and the reply names the lines (at most REPORT_LINES_MAX of them) so the
// instructor can fix the file in one go.
//
// Format: a header row `email,name` or `email,name,extra_minutes`; commas separate fields; a field may be
// quoted with double quotes (a doubled quote is a quote); LF or CRLF; a leading byte-order mark and blank
// lines are ignored.

const REPORT_LINES_MAX = 20;
const BYTE_ORDER_MARK = /^\u{FEFF}/u;

export type RosterPerson = {
    readonly email: string;
    readonly name: string;
    readonly extra_minutes: number;
};

export type RosterParse =
    | { readonly ok: true; readonly people: RosterPerson[] }
    | { readonly ok: false; readonly problems: string[] };

export function parseRosterCsv(text: string): RosterParse {
    const lines = text.replace(BYTE_ORDER_MARK, "").split(/\r\n|\n/);
    const rows: { line: number; fields: string[] }[] = [];
    const problems: string[] = [];
    for (const [index, raw] of lines.entries()) {
        if (raw.trim() === "") continue;
        const fields = splitLine(raw);
        if (fields === null) problems.push(`line ${index + 1}: an unclosed quote`);
        else rows.push({ line: index + 1, fields });
    }
    const header = rows.shift();
    const columns = header?.fields.map((f) => f.trim().toLowerCase()) ?? [];
    const withExtra = columns.length === 3 && columns[2] === "extra_minutes";
    const plain = columns.length === 2;
    if (!(columns[0] === "email" && columns[1] === "name" && (plain || withExtra))) {
        return {
            ok: false,
            problems: ["the first line must be: email,name or email,name,extra_minutes"],
        };
    }
    if (rows.length === 0) problems.push("the file has no people");
    if (rows.length > EXAM_ROSTER_MAX) problems.push(`at most ${EXAM_ROSTER_MAX} people`);
    const people: RosterPerson[] = [];
    const seen = new Set<string>();
    for (const { line, fields } of rows.slice(0, EXAM_ROSTER_MAX)) {
        const fault = checkRow(line, fields, columns.length, seen);
        if (typeof fault === "string") problems.push(fault);
        else people.push(fault);
    }
    return problems.length === 0
        ? { ok: true, people }
        : { ok: false, problems: problems.slice(0, REPORT_LINES_MAX) };
}

function checkRow(
    line: number,
    fields: string[],
    width: number,
    seen: Set<string>,
): RosterPerson | string {
    if (fields.length !== width)
        return `line ${line}: ${width} fields expected, ${fields.length} found`;
    const extra = width === 3 ? Number(fields[2]?.trim()) : 0;
    const parsed = rosterRowSchema.safeParse({
        email: fields[0] ?? "",
        name: fields[1] ?? "",
        extra_minutes: Number.isInteger(extra) ? extra : -1,
    });
    if (!parsed.success)
        return `line ${line}: ${parsed.error.issues[0]?.path.join(".") ?? "row"} is not valid`;
    if (seen.has(parsed.data.email)) return `line ${line}: ${parsed.data.email} appears twice`;
    seen.add(parsed.data.email);
    return parsed.data;
}

// Splits one line into fields. Returns null for an unclosed quote.
function splitLine(line: string): string[] | null {
    const fields: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
            } else if (c === '"') quoted = false;
            else current += c;
        } else if (c === '"' && current === "") quoted = true;
        else if (c === ",") {
            fields.push(current);
            current = "";
        } else current += c;
    }
    if (quoted) return null;
    fields.push(current);
    return fields;
}
