// Goal: the migration runner must apply once, refuse tampering, refuse gaps, and refuse old
// PostgreSQL versions. Each case uses a real database and a temporary migrations directory.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client.ts";
import { assertSupportedVersion, loadMigrations, migrate } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./test-helpers.ts";

const realDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
let db: TestDatabase;

// A fresh database per test: migrations are stateful, so tests must not see each other's work.
beforeEach(async () => {
    db = await createTestDatabase();
});
afterEach(async () => {
    await db.drop();
});

function tempMigrations(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), "aura-migrations-"));
    for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(directory, name), text);
    }
    return directory;
}

describe("migrate", () => {
    it("applies the real migrations once and is idempotent", async () => {
        const migrations = loadMigrations(realDirectory);
        expect(migrations.length).toBeGreaterThan(0);
        const first = await migrate(db.database.sql, migrations);
        const second = await migrate(db.database.sql, migrations);
        expect(first).toEqual(migrations.map((migration) => migration.id));
        expect(second).toEqual([]);
        const [extension] = await db.database
            .sql`select 1 from pg_extension where extname = 'citext'`;
        expect(extension).toBeDefined();
        const [uuid] = await db.database.sql<{ v: string }[]>`select uuidv7()::text as v`;
        expect(uuid?.v).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("works with a single-connection pool, as the command line tool uses", async () => {
        // Regression: the runner once held the only connection for its lock and then waited for a
        // second one for the migration transaction, which never came.
        const single = createDatabase(db.url, 1);
        try {
            const applied = await migrate(single.sql, loadMigrations(realDirectory));
            expect(applied.length).toBeGreaterThan(0);
            expect(await migrate(single.sql, loadMigrations(realDirectory))).toEqual([]);
        } finally {
            await single.close(5);
        }
    });

    it("rejects a migration that was edited after it was applied", async () => {
        const original = tempMigrations({ "0001_a.sql": "create table tamper_a (id int);" });
        await migrate(db.database.sql, loadMigrations(original));
        const edited = tempMigrations({ "0001_a.sql": "create table tamper_a (id bigint);" });
        await expect(migrate(db.database.sql, loadMigrations(edited))).rejects.toThrow(/modified/);
    });

    it("rejects a database that is ahead of the code", async () => {
        await migrate(db.database.sql, loadMigrations(realDirectory));
        const other = tempMigrations({ "0001_only.sql": "select 1;" });
        await expect(migrate(db.database.sql, loadMigrations(other))).rejects.toThrow(
            /missing from code/,
        );
    });

    it("rejects gaps, bad names and empty files", () => {
        expect(() => loadMigrations(tempMigrations({ "0002_x.sql": "select 1;" }))).toThrow(
            /contiguous/,
        );
        expect(() => loadMigrations(tempMigrations({ "1_x.sql": "select 1;" }))).toThrow(
            /NNNN_name/,
        );
        expect(() => loadMigrations(tempMigrations({ "0001_x.sql": "  \n" }))).toThrow(/not empty/);
    });

    it("rolls back a failing migration and records nothing", async () => {
        const bad = tempMigrations({
            "0001_z.sql": "create table rollback_probe (id int); select 1/0;",
        });
        await expect(migrate(db.database.sql, loadMigrations(bad))).rejects.toThrow();
        const [probe] = await db.database.sql`select to_regclass('rollback_probe') as t`;
        expect(probe?.["t"]).toBeNull();
    });

    it("refuses PostgreSQL older than 18 and non-integers", () => {
        expect(() => assertSupportedVersion(170005)).toThrow(/PostgreSQL 18/);
        expect(() => assertSupportedVersion(180000)).not.toThrow();
        expect(() => assertSupportedVersion(18.5)).toThrow(/integer/);
    });
});
