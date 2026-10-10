// Goal: no table may ship without row-level security and a recorded owner. This test reads the
// real schema, so a new table without a policy, or missing from docs/adr/0003, fails CI.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedTestDatabase, type TestDatabase } from "./test-helpers.ts";

// Tables that deliberately do not use row-level security, each with the reason.
const RLS_EXEMPT: Readonly<Record<string, string>> = {
    schema_migrations: "migration ledger, touched only by the migration role",
};
// Tables where RLS is enabled but not forced, because a SECURITY DEFINER trigger owned by the
// table owner must read every row (the audit hash chain).
const NOT_FORCED: Readonly<Record<string, string>> = {
    audit_log: "its chain trigger runs as the owner and must see all rows",
    orgs: "the role helper functions run as the owner and must read memberships",
    memberships: "the role helper functions run as the owner and must read memberships",
};

let db: TestDatabase;
beforeAll(async () => {
    db = await createMigratedTestDatabase();
});
afterAll(async () => {
    await db.drop();
});

async function tables() {
    return db.database.sql<{ name: string; rls: boolean; forced: boolean; policies: string }[]>`
        select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
               (select count(*) from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname)::text as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname`;
}

describe("row-level security coverage", () => {
    it("enables RLS and at least one policy on every table, forced unless justified", async () => {
        const found = await tables();
        expect(found.length).toBeGreaterThan(1);
        for (const table of found) {
            if (table.name in RLS_EXEMPT) continue;
            expect(table.rls, `${table.name} must enable row level security`).toBe(true);
            expect(Number(table.policies), `${table.name} needs a policy`).toBeGreaterThan(0);
            if (!(table.name in NOT_FORCED))
                expect(table.forced, `${table.name} must force RLS`).toBe(true);
        }
    });

    it("lists every table in the ownership map of ADR 0003", async () => {
        const adr = readFileSync(
            fileURLToPath(new URL("../../../docs/adr/0003-table-ownership.md", import.meta.url)),
            "utf8",
        );
        const listed = new Set([...adr.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]));
        for (const table of await tables()) {
            expect(
                listed.has(table.name),
                `${table.name} is missing from docs/adr/0003-table-ownership.md`,
            ).toBe(true);
        }
    });

    it("grants the application roles no privileges on the migration ledger", async () => {
        const rows = await db.database.sql<{ role: string; allowed: boolean }[]>`
            select r as role, has_table_privilege(r, 'schema_migrations', 'select') as allowed
            from unnest(array['aura_app', 'aura_auth']) as r`;
        for (const row of rows)
            expect(row.allowed, `${row.role} must not read schema_migrations`).toBe(false);
    });
});
