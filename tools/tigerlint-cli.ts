import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lintSource, type Violation } from "./tigerlint.ts";
import { lintImports } from "./tigerlint-imports.ts";

// Lints every tracked TypeScript file. `git ls-files` honors .gitignore, so build output and
// dependencies are skipped without a hand-maintained list. The vendored kit is not our code.

const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx"],
    {
        encoding: "utf8",
    },
);
const files = listed
    .split("\n")
    .filter(
        (file) =>
            file.length > 0 &&
            !file.startsWith("docs/kit/") &&
            !file.startsWith("tools/semgrep/") &&
            !file.includes("/generated/"),
    );

const sources = new Map<string, string>();
const violations: Violation[] = [];
for (const file of files) {
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    violations.push(...lintSource(file, source));
}
violations.push(...lintImports(sources));

for (const v of violations) process.stderr.write(`${v.file}:${v.line} [${v.rule}] ${v.message}\n`);
process.stdout.write(`tigerlint: ${files.length} files, ${violations.length} violation(s)\n`);
process.exit(violations.length === 0 ? 0 : 1);
