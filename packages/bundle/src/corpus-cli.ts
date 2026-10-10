import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { corpusCases } from "./corpus.ts";

// Usage: node packages/bundle/src/corpus-cli.ts
// Rewrites packages/bundle/corpus/ from corpus.ts: one file per case plus expectations.json, a plain
// name -> expected answer map that other implementations read. Run it after changing a case.

const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
mkdirSync(directory, { recursive: true });
for (const name of readdirSync(directory)) rmSync(join(directory, name));

const expectations: Record<string, { expect: string; compressed: boolean }> = {};
for (const bundle of corpusCases()) {
    const fileName = `${bundle.name}.${bundle.raw ? "bin" : "tar.zst"}`;
    writeFileSync(join(directory, fileName), bundle.bytes);
    expectations[fileName] = { expect: bundle.expect, compressed: !bundle.raw };
}
writeFileSync(join(directory, "expectations.json"), `${JSON.stringify(expectations, null, 4)}\n`);
process.stdout.write(`wrote ${Object.keys(expectations).length} corpus files\n`);
