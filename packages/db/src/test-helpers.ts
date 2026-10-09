import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assert } from "@aura/contracts/assert";
import { createDatabase, type Database } from "./client.ts";
import {
    type DatabaseRole,
    type RequestContext,
    type Transaction,
    withRequestContext,
} from "./context.ts";
import { loadMigrations, migrate } from "./migrate.ts";

// Each test file gets its own throwaway database so files cannot interfere with each other.
// The admin URL comes from the environment; there is deliberately no silent default, so a missing
// PostgreSQL fails the run loudly instead of skipping coverage.

export interface TestDatabase {
    readonly database: Database;
    readonly url: string;
    drop(): Promise<void>;
}

export function adminUrl(): string {
    const url = process.env["AURA_TEST_DATABASE_URL"];
    assert(
        url !== undefined && url.length > 0,
        "AURA_TEST_DATABASE_URL must point to a PostgreSQL 18 server (see README)",
    );
    return url;
}

export async function createTestDatabase(connectionsMax = 4): Promise<TestDatabase> {
    const admin = createDatabase(adminUrl(), 1);
    const name = `aura_test_${randomBytes(6).toString("hex")}`;
    await admin.sql`create database ${admin.sql(name)}`;
    await admin.close(5);
    const url = new URL(adminUrl());
    url.pathname = `/${name}`;
    const database = createDatabase(url.toString(), connectionsMax);
    return {
        database,
        url: url.toString(),
        async drop() {
            await database.close(5);
            const cleanup = createDatabase(adminUrl(), 1);
            await cleanup.sql`drop database if exists ${cleanup.sql(name)} with (force)`;
            await cleanup.close(5);
        },
    };
}

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));

// A throwaway database with every migration applied, as the application would see it.
export async function createMigratedTestDatabase(connectionsMax = 6): Promise<TestDatabase> {
    const testDatabase = await createTestDatabase(connectionsMax);
    await migrate(testDatabase.database.sql, loadMigrations(MIGRATIONS_DIRECTORY));
    return testDatabase;
}

// Runs work inside a transaction as one of the application roles, with the request context set the
// way a real request would. A superuser bypasses row-level security, so tests must always switch to
// an application role to see what the application would see.
export function inRole<T>(
    database: Database,
    role: DatabaseRole,
    context: RequestContext,
    work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
    return withRequestContext(database.sql, { ...context, role }, work);
}
