import type { Violation } from "./tigerlint.ts";

// Enforces the dependency budget (docs/kit/03 section 4): every direct dependency is listed with
// the ADR that justifies it, versions are exact, and runtime dependency counts stay in budget.

export interface WorkspaceManifest {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
}

export interface DependencyPolicy {
    // Maximum number of runtime (non-workspace) dependencies per workspace.
    readonly budgets: Readonly<Record<string, number>>;
    // workspace -> package -> four-digit ADR number that justifies it.
    readonly allowed: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function fail(workspace: string, rule: string, message: string): Violation {
    return { file: `${workspace}/package.json`, line: 1, rule, message };
}

function checkOne(
    workspace: string,
    name: string,
    version: string,
    policy: DependencyPolicy,
    adrIds: ReadonlySet<string>,
): Violation[] {
    if (version === "workspace:*") return [];
    const out: Violation[] = [];
    if (!EXACT_VERSION.test(version)) {
        out.push(fail(workspace, "exact-version", `${name}@${version} must be an exact version`));
    }
    const adr = policy.allowed[workspace]?.[name];
    if (adr === undefined) {
        out.push(
            fail(workspace, "dependency-listed", `${name} is not listed in docs/adr/deps.json`),
        );
    } else if (!adrIds.has(adr)) {
        out.push(
            fail(workspace, "dependency-adr", `${name} cites ADR ${adr}, which does not exist`),
        );
    }
    return out;
}

export function checkDependencies(
    workspaces: Readonly<Record<string, WorkspaceManifest>>,
    policy: DependencyPolicy,
    adrIds: ReadonlySet<string>,
): Violation[] {
    const out: Violation[] = [];
    for (const [workspace, manifest] of Object.entries(workspaces)) {
        const all = { ...manifest.devDependencies, ...manifest.dependencies };
        for (const [name, version] of Object.entries(all)) {
            out.push(...checkOne(workspace, name, version, policy, adrIds));
        }
        const runtimeCount = Object.values(manifest.dependencies).filter(
            (v) => v !== "workspace:*",
        ).length;
        const budget = policy.budgets[workspace] ?? 0;
        if (runtimeCount > budget) {
            out.push(
                fail(
                    workspace,
                    "dependency-budget",
                    `${runtimeCount} runtime dependencies exceed budget ${budget}`,
                ),
            );
        }
        for (const name of Object.keys(policy.allowed[workspace] ?? {})) {
            if (!(name in all))
                out.push(fail(workspace, "dependency-stale", `${name} is listed but not used`));
        }
    }
    return out;
}
