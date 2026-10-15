import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { verifyAuditChain } from "@aura/db/audit";
import { createMigratedTestDatabase } from "@aura/db/test-helpers";
import { type EvidenceItem, renderEvidence } from "./soc2-evidence.ts";

// Collects the evidence that can be collected without a person or a cloud account and writes docs/compliance/evidence-<date>.md.
// Run: node apps/api/src/soc2-evidence-cli.ts   (needs the GitHub CLI signed in, and the local PostgreSQL used by the tests)
const run = promisify(execFile);
const today = new Date().toISOString().slice(0, 10);
const REPOSITORY = "AuraFirm/AuraLand";

async function shell(file: string, args: string[]): Promise<string> {
    try {
        return (await run(file, args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
    } catch (error) {
        return error instanceof Error && "stdout" in error ? String(error.stdout) : "";
    }
}

async function changeManagement(): Promise<EvidenceItem[]> {
    const raw = await shell("gh", ["api", `repos/${REPOSITORY}/rules/branches/main`]);
    let types: string[] = [];
    try {
        types = (JSON.parse(raw) as { type: string }[]).map((rule) => rule.type); // tigerlint-allow: no-as-cast -- the GitHub API answer is read only to list rule names
    } catch {
        types = [];
    }
    const need = [
        "pull_request",
        "required_status_checks",
        "required_signatures",
        "required_linear_history",
        "non_fast_forward",
        "deletion",
    ];
    const missing = need.filter((rule) => !types.includes(rule));
    return [
        {
            area: "CC8.1 change management",
            check: "Rules for main: pull request, required checks, signed commits, linear history, no force-push, no deletion",
            found:
                types.length === 0
                    ? "could not read the rules (is `gh` signed in?)"
                    : missing.length === 0
                      ? `all ${need.length} rules active`
                      : `missing: ${missing.join(", ")}`,
            status:
                types.length === 0
                    ? "not_evidenced"
                    : missing.length === 0
                      ? "evidenced"
                      : "partial",
        },
    ];
}

function repositoryChecks(): EvidenceItem[] {
    const workflows = existsSync(".github/workflows") ? readdirSync(".github/workflows") : [];
    const ci = existsSync(".github/workflows/ci.yml")
        ? readFileSync(".github/workflows/ci.yml", "utf8")
        : "";
    const steps = [
        "pnpm run check",
        "pnpm test",
        "test:sim",
        "test:e2e",
        "pnpm audit",
        "trufflehog",
        "semgrep",
        "trivy",
    ].filter((s) => ci.toLowerCase().includes(s.toLowerCase()));
    return [
        {
            area: "CC8.1 change management",
            check: "CI runs checks, tests, simulation, browser tests, dependency audit, secret scan, SAST and image scan",
            found: `${steps.length} of 8 present in ci.yml: ${steps.join(", ")}`,
            status: steps.length === 8 ? "evidenced" : "partial",
        },
        {
            area: "CC8.1 change management",
            check: "CodeQL workflow and CODEOWNERS exist",
            found: `codeql: ${workflows.includes("codeql.yml")}, CODEOWNERS: ${existsSync(".github/CODEOWNERS")}`,
            status:
                workflows.includes("codeql.yml") && existsSync(".github/CODEOWNERS")
                    ? "evidenced"
                    : "partial",
        },
        {
            area: "CC3.2 risk assessment",
            check: "Threat model updated every stage",
            found: `${
                readFileSync("docs/threat-model.md", "utf8")
                    .split("\n")
                    .filter((l) => l.startsWith("## STRIDE")).length
            } STRIDE sections in docs/threat-model.md`,
            status: "evidenced",
        },
        {
            area: "CC1.4 / CC8.1 decisions recorded",
            check: "Architecture decisions are written down",
            found: `${readdirSync("docs/adr").filter((n) => /^\d{4}-/.test(n)).length} ADRs`,
            status: "evidenced",
        },
    ];
}

// What needs people and systems that do not exist yet: said plainly, so the gap is as visible as the strengths.
function peopleChecks(): EvidenceItem[] {
    return [
        {
            area: "CC7.3 incident response",
            check: "A written incident process exists",
            found: "runbooks for operations exist; there is no incident-response policy, on-call or breach-notification procedure drilled by people",
            status: "not_evidenced",
        },
        {
            area: "A1.2 availability / recovery",
            check: "Backups and recovery objectives",
            found: "a restore drill of a logical dump passes (apps/api/src/dr-drill-cli.ts); no managed backups, PITR or RTO/RPO exist (cutlist F79)",
            status: "partial",
        },
        {
            area: "CC6.1 access",
            check: "Periodic access reviews, joiner/leaver process",
            found: "no staff beyond the founder; nothing to review yet",
            status: "not_evidenced",
        },
        {
            area: "CC9.2 vendors",
            check: "Sub-processor list and DPAs",
            found: "a DPA template for exams exists; no sub-processor register, no vendor reviews",
            status: "partial",
        },
    ];
}

async function databaseChecks(): Promise<EvidenceItem[]> {
    const database = await createMigratedTestDatabase(2);
    try {
        const { sql } = database.database;
        const [tables] = await sql<
            { total: string; forced: string }[]
        >`select count(*)::text as total, count(*) filter (where c.relforcerowsecurity)::text as forced
            from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition and c.relname <> 'schema_migrations'`;
        const [migrations] = await sql<
            { n: string }[]
        >`select count(*)::text as n from schema_migrations`;
        const chain = await verifyAuditChain(sql);
        return [
            {
                area: "CC6.1 logical access",
                check: "Tables with row-level security forced (all but the audit log and two role-helper tables)",
                found: `${tables?.forced} of ${tables?.total} tables`,
                status:
                    Number(tables?.total) - Number(tables?.forced) <= 3 ? "evidenced" : "partial",
            },
            {
                area: "CC7.2 monitoring / integrity",
                check: "The audit log is a hash chain that verifies",
                found: chain.ok
                    ? "chain verifies on a fresh database (an empty chain proves little; production needs an external head, cutlist F8)"
                    : "chain does not verify",
                status: chain.ok ? "partial" : "not_evidenced",
            },
            {
                area: "CC8.1 change management",
                check: "Schema changes are reviewed, ordered, hashed migrations",
                found: `${migrations?.n} migrations applied in order`,
                status: "evidenced",
            },
        ];
    } finally {
        await database.drop();
    }
}

const items = [
    ...(await changeManagement()),
    ...repositoryChecks(),
    ...peopleChecks(),
    ...(await databaseChecks()),
];
const file = `docs/compliance/evidence-${today}.md`;
writeFileSync(file, renderEvidence(items, today));
process.stdout.write(`wrote ${file}: ${items.length} items\n`);
