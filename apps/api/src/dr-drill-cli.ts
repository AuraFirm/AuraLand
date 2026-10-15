import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendAudit, verifyAuditChain } from "@aura/db/audit";
import type { Database } from "@aura/db/client";
import { createMigratedTestDatabase, createTestDatabase } from "@aura/db/test-helpers";
import { compareCounts, type TableCounts } from "./dr-drill.ts";

// The disaster-recovery drill (Stage 9, slice 11): make a database with data in it, dump it, restore the dump into an EMPTY database
// on the same server, and prove the copy is whole: every table has the same number of rows and the audit hash chain still verifies,
// with the same head. It reports how long the dump and the restore took. It does NOT drill point-in-time recovery, a second zone or
// a managed backup service: those need a cloud account (cutlist F79). Run: node apps/api/src/dr-drill-cli.ts
const run = promisify(execFile);
const SEED_USERS = 200;
const SEED_AUDIT = 2_000;

async function seed(database: Database): Promise<void> {
    const { sql } = database;
    await sql`insert into users (email, email_verified_at) select 'drill' || n || '@example.com', now() from generate_series(1, ${SEED_USERS}) n`;
    await sql`insert into orgs (kind, slug, name) select 'company', 'drill-' || n, 'Drill ' || n from generate_series(1, 20) n`;
    await sql`select post_ledger_txn('drill', 'seed-' || n, now(), jsonb_build_array(
        jsonb_build_object('account', 'cash', 'direction', 'D', 'amount_minor', 100, 'currency', 'USD'),
        jsonb_build_object('account', 'revenue', 'direction', 'C', 'amount_minor', 100, 'currency', 'USD'))) from generate_series(1, 50) n`;
    for (let i = 0; i < SEED_AUDIT; i++) {
        await sql.begin((tx) =>
            appendAudit(tx, {
                actorKind: "system",
                actorUserId: null,
                orgId: null,
                action: "drill.seeded",
                detail: { i },
            }),
        );
    }
}

async function counts(database: Database): Promise<TableCounts> {
    const tables = await database.sql<
        { name: string }[]
    >`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1`;
    const result: Record<string, number> = {};
    for (const table of tables) {
        const [row] = await database.sql<
            { n: string }[]
        >`select count(*)::text as n from ${database.sql(table.name)}`;
        result[table.name] = Number(row?.n);
    }
    return result;
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
    const started = Date.now();
    const value = await work();
    return [value, Date.now() - started];
}

async function main(): Promise<number> {
    const source = await createMigratedTestDatabase(2);
    const target = await createTestDatabase(2);
    const directory = await mkdtemp(join(tmpdir(), "aura-dr-"));
    const file = join(directory, "drill.dump");
    try {
        await seed(source.database);
        const before = await counts(source.database);
        const headBefore = await verifyAuditChain(source.database.sql);
        const [, dumpMs] = await timed(() =>
            run("pg_dump", ["--format=custom", `--file=${file}`, `--dbname=${source.url}`]),
        );
        const bytes = (await stat(file)).size;
        const [, restoreMs] = await timed(() =>
            run("pg_restore", ["--exit-on-error", `--dbname=${target.url}`, file]),
        );
        const after = await counts(target.database);
        const headAfter = await verifyAuditChain(target.database.sql);
        const problems = compareCounts(before, after);
        if (!headAfter.ok)
            problems.push(
                `audit chain does not verify after restore: ${JSON.stringify(headAfter)}`,
            );
        if (JSON.stringify(headBefore) !== JSON.stringify(headAfter))
            problems.push("audit chain head differs after restore");
        const rows = Object.values(before).reduce((a, b) => a + b, 0);
        process.stdout.write(
            `dump ${dumpMs} ms, restore ${restoreMs} ms, ${(bytes / 1024).toFixed(0)} KiB, ${rows} rows in ${Object.keys(before).length} tables\n`,
        );
        for (const problem of problems) process.stderr.write(`PROBLEM: ${problem}\n`);
        process.stdout.write(
            problems.length === 0 ? "drill passed: the restored copy is whole\n" : "drill FAILED\n",
        );
        return problems.length === 0 ? 0 : 1;
    } finally {
        await rm(directory, { recursive: true, force: true });
        await source.drop();
        await target.drop();
    }
}

process.exit(await main());
