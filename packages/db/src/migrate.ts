import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "@aura/contracts/assert";
import type { Sql } from "./client.ts";

// Hand-reviewed SQL migrations applied in order, each in its own transaction, with a checksum so a
// merged migration can never be edited silently (docs/kit/02 section 4: expand, migrate, contract).

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const POSTGRES_VERSION_NUM_MIN = 180000; // PostgreSQL 18: native uuidv7().
// Arbitrary constant; any two sessions that migrate must agree on it so they serialize.
const MIGRATION_LOCK_KEY = 7_281_990_001;

export interface Migration {
    readonly id: string;
    readonly sql: string;
    readonly sha256: string;
}

export function assertSupportedVersion(serverVersionNum: number): void {
    assert(Number.isInteger(serverVersionNum), "server version is an integer");
    assert(serverVersionNum >= POSTGRES_VERSION_NUM_MIN, "PostgreSQL 18 or newer is required");
}

export function loadMigrations(directory: string): Migration[] {
    const names = readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort();
    const migrations: Migration[] = [];
    for (const [index, name] of names.entries()) {
        const match = MIGRATION_FILE_PATTERN.exec(name);
        assert(match !== null, `migration file name is NNNN_name.sql: ${name}`);
        // Numbers start at 0001 and never skip, so a missing file is noticed immediately.
        assert(Number(match[1]) === index + 1, `migration numbers are contiguous: ${name}`);
        const text = readFileSync(join(directory, name), "utf8");
        assert(text.trim().length > 0, `migration is not empty: ${name}`);
        const sha256 = createHash("sha256").update(text).digest("hex");
        migrations.push({ id: name.slice(0, -4), sql: text, sha256 });
    }
    return migrations;
}

export async function migrate(sql: Sql, migrations: readonly Migration[]): Promise<string[]> {
    const [version] = await sql<
        { n: number }[]
    >`select current_setting('server_version_num')::int as n`;
    assertSupportedVersion(version?.n ?? 0);
    const applied: string[] = [];
    // A dedicated connection holds the advisory lock so concurrent deploys serialize.
    const reserved = await sql.reserve();
    try {
        await reserved`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
        await reserved`
            create table if not exists schema_migrations (
                id text primary key,
                sha256 text not null check (char_length(sha256) = 64),
                applied_at timestamptz not null default now()
            )
        `;
        const rows = await reserved<{ id: string; sha256: string }[]>`
            select id, sha256 from schema_migrations order by id
        `;
        const recorded = new Map(rows.map((row) => [row.id, row.sha256]));
        assertRecordedMatchesFiles(recorded, migrations);
        for (const migration of migrations) {
            if (recorded.has(migration.id)) continue;
            await applyOne(sql, migration);
            applied.push(migration.id);
        }
    } finally {
        await reserved`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
        reserved.release();
    }
    return applied;
}

function assertRecordedMatchesFiles(
    recorded: ReadonlyMap<string, string>,
    migrations: readonly Migration[],
): void {
    const byId = new Map(migrations.map((migration) => [migration.id, migration]));
    for (const [id, sha256] of recorded) {
        const file = byId.get(id);
        assert(file !== undefined, `database has migration missing from code: ${id}`);
        assert(file.sha256 === sha256, `applied migration was modified after merge: ${id}`);
    }
}

async function applyOne(sql: Sql, migration: Migration): Promise<void> {
    await sql.begin(async (transaction) => {
        // tigerlint-allow: no-unsafe-sql -- migration text is a reviewed repository file, not input
        await transaction.unsafe(migration.sql);
        await transaction`
            insert into schema_migrations (id, sha256) values (${migration.id}, ${migration.sha256})
        `;
    });
}
