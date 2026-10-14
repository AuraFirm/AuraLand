import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { type Candidate, traceLeak } from "./trace.ts";

// Usage: node packages/bundle/src/trace-leak-cli.ts --leaked <file-or-directory> --candidates <json file>
//
// An operator's tool for a leak (Stage 4C, ADR 0030). It reads files that leaked and the delivery records
// and prints which deliveries the files could have come from, with how strong the evidence is. It names
// candidates; a person decides. It reads loose files only: a leaked archive is untrusted input and must
// be unpacked inside a sandbox first (judge/node/README.md), then the files given here.
//
// The candidates come from the database, exported by an administrator:
//   psql "$AURA_DATABASE_URL" -At -c "select coalesce(json_agg(json_build_object('deliveryId', delivery_id,
//     'taskVersionId', task_version_id, 'tag', tag)), '[]') from delivery_bundles" > candidates.json

// The export is the operator's own, but a wrong file must fail loudly, not be traced half-understood.
function parseCandidates(text: string): Candidate[] {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("the candidates file must be a JSON array");
    return parsed.map((entry: unknown, index) => {
        const record = typeof entry === "object" && entry !== null ? entry : {};
        const deliveryId = "deliveryId" in record ? record.deliveryId : undefined;
        const taskVersionId = "taskVersionId" in record ? record.taskVersionId : undefined;
        const tag = "tag" in record ? record.tag : undefined;
        if (
            typeof deliveryId !== "string" ||
            typeof taskVersionId !== "string" ||
            typeof tag !== "number" ||
            !Number.isInteger(tag) ||
            tag < 2 ** 31 ||
            tag >= 2 ** 32
        ) {
            throw new Error(`candidate ${index} is not { deliveryId, taskVersionId, tag }`);
        }
        return { deliveryId, taskVersionId, tag };
    });
}

const { values } = parseArgs({
    options: { leaked: { type: "string" }, candidates: { type: "string" } },
    strict: true,
});
if (values.leaked === undefined || values.candidates === undefined) {
    process.stderr.write("usage: --leaked <file-or-directory> --candidates <json file>\n");
    process.exit(2);
}

// A loose file is placed where the decoder looks for it: answers under tests/, programs under
// solutions/. Anything else cannot carry a mark and is ignored.
function placed(name: string): string | null {
    if (name.endsWith(".ans")) return `tests/${name}`;
    if (name.endsWith(".cpp") || name.endsWith(".py")) return `solutions/${name}`;
    return null;
}

const FILES_MAX = 5_000;
function readLeaked(path: string): Map<string, Uint8Array> {
    const names = statSync(path).isDirectory()
        ? readdirSync(path, { withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => join(path, entry.name))
        : [path];
    const files = new Map<string, Uint8Array>();
    for (const file of names.slice(0, FILES_MAX)) {
        const key = placed(basename(file));
        if (key !== null) files.set(key, new Uint8Array(readFileSync(file)));
    }
    return files;
}

const candidates = parseCandidates(readFileSync(values.candidates, "utf8"));
const files = readLeaked(values.leaked);
const trace = traceLeak(files, candidates);
const out = (line: string) => process.stdout.write(`${line}\n`);
out(`read ${files.size} file(s) that can carry a mark; ${candidates.length} deliveries on record`);
out(
    `answer bits recovered: ${trace.answerBitsKnown} of 32; solution marks: ${trace.solutionTags.length}`,
);
if (trace.matches.length === 0)
    out("no delivery matches: the marks are absent, scrubbed or too few");
for (const match of trace.matches) {
    out(
        `${match.strength.toUpperCase()}: delivery ${match.candidate.deliveryId}, version ${match.candidate.taskVersionId} ` +
            `(${match.answerBitsAgreeing} answer bits agree, ${match.solutionMarks} solution mark(s))`,
    );
}
process.exit(trace.matches.some((m) => m.strength === "strong") ? 0 : 1);
