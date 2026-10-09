import { existsSync, readdirSync, readFileSync } from "node:fs";
import { checkDependencies, type DependencyPolicy, type WorkspaceManifest } from "./depcheck.ts";

const WORKSPACE_DIRECTORIES = ["apps", "packages"] as const;

function readManifest(directory: string): WorkspaceManifest {
    const parsed: unknown = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
    const record = typeof parsed === "object" && parsed !== null ? parsed : {};
    const pick = (key: string): Record<string, string> => {
        const value = key in record ? Reflect.get(record, key) : undefined;
        return typeof value === "object" && value !== null ? { ...value } : {};
    };
    return { dependencies: pick("dependencies"), devDependencies: pick("devDependencies") };
}

const workspaces: Record<string, WorkspaceManifest> = {
    root: readManifest("."),
    tools: readManifest("tools"),
};
for (const parent of WORKSPACE_DIRECTORIES) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(`${parent}/${entry.name}/package.json`)) {
            workspaces[`${parent}/${entry.name}`] = readManifest(`${parent}/${entry.name}`);
        }
    }
}

const policy: DependencyPolicy = JSON.parse(readFileSync("docs/adr/deps.json", "utf8"));
const adrIds = new Set(
    readdirSync("docs/adr")
        .map((name) => /^(\d{4})-/.exec(name)?.[1])
        .filter((id): id is string => id !== undefined),
);

const violations = checkDependencies(workspaces, policy, adrIds);
if (!existsSync("pnpm-lock.yaml")) {
    violations.push({
        file: "pnpm-lock.yaml",
        line: 1,
        rule: "lockfile",
        message: "lockfile is missing",
    });
}
for (const v of violations) process.stderr.write(`${v.file} [${v.rule}] ${v.message}\n`);
process.stdout.write(
    `depcheck: ${Object.keys(workspaces).length} workspaces, ${violations.length} violation(s)\n`,
);
process.exit(violations.length === 0 ? 0 : 1);
