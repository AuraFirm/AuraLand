// Goal: prove the Row-Level Security context pattern from docs/kit/05 section 6. Org B must not
// see org A's rows, an unset context must see nothing, and, most important, identity must not
// leak between requests that reuse the same pooled connection.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client.ts";
import { assertContextValid, type RequestContext, withRequestContext } from "./context.ts";
import { adminUrl, createTestDatabase, type TestDatabase } from "./test-helpers.ts";

const ORG_A = "018f0000-0000-7000-8000-00000000000a";
const ORG_B = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000aa";
let testDb: TestDatabase;
let singleConnection: Database;

beforeAll(async () => {
    testDb = await createTestDatabase();
    const { sql } = testDb.database;
    await sql`create role aura_probe_app nologin`;
    await sql`create table probe_rows (org_id uuid not null, value text not null)`;
    await sql`alter table probe_rows enable row level security`;
    await sql`alter table probe_rows force row level security`;
    await sql`
        create policy probe_tenant on probe_rows
        using (org_id = any (string_to_array(nullif(current_setting('app.org_ids', true), ''), ',')::uuid[]))
    `;
    await sql`grant select on probe_rows to aura_probe_app`;
    await sql`insert into probe_rows values (${ORG_A}, 'a-secret'), (${ORG_B}, 'b-secret')`;
    // One connection only, so consecutive requests are forced to reuse it.
    singleConnection = createDatabase(testDb.url, 1);
});
afterAll(async () => {
    await singleConnection.close(5);
    await testDb.drop();
    // Roles are cluster-wide, so the probe role is dropped explicitly.
    const admin = createDatabase(adminUrl(), 1);
    await admin.sql`drop role if exists aura_probe_app`;
    await admin.close(5);
});

function visibleValues(context: RequestContext, database: Database = testDb.database) {
    return withRequestContext(database.sql, context, async (transaction) => {
        // Superusers bypass RLS, so the work runs as an ordinary role like production does.
        await transaction`set local role aura_probe_app`;
        const rows = await transaction<
            { value: string }[]
        >`select value from probe_rows order by value`;
        return rows.map((row) => row.value);
    });
}

const userInOrg = (orgIds: string[]): RequestContext => ({
    actorKind: "user",
    userId: USER,
    orgIds,
});

describe("withRequestContext", () => {
    it("shows each organization only its own rows", async () => {
        expect(await visibleValues(userInOrg([ORG_A]))).toEqual(["a-secret"]);
        expect(await visibleValues(userInOrg([ORG_B]))).toEqual(["b-secret"]);
        expect(await visibleValues(userInOrg([ORG_A, ORG_B]))).toEqual(["a-secret", "b-secret"]);
    });

    it("shows nothing to an anonymous actor", async () => {
        const anonymous: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
        expect(await visibleValues(anonymous)).toEqual([]);
    });

    it("never leaks identity to the next request on a reused connection", async () => {
        const first = await visibleValues(userInOrg([ORG_A]), singleConnection);
        // A new transaction on the same single connection, with no context set at all.
        const leaked = await singleConnection.sql.begin(async (transaction) => {
            await transaction`set local role aura_probe_app`;
            const [setting] = await transaction<{ v: string | null }[]>`
                select current_setting('app.org_ids', true) as v
            `;
            const rows = await transaction`select value from probe_rows`;
            return { setting: setting?.v, rowCount: rows.length };
        });
        expect(first).toEqual(["a-secret"]);
        expect(leaked.setting ?? "").toBe("");
        expect(leaked.rowCount).toBe(0);
    });

    it("rejects malformed identities before touching the database", async () => {
        const bad = (context: RequestContext) => () => assertContextValid(context);
        expect(bad(userInOrg(["not-a-uuid"]))).toThrow(/uuid/);
        expect(bad(userInOrg([ORG_A.toUpperCase()]))).toThrow(/lowercase uuid/);
        expect(bad({ actorKind: "user", userId: "x' or '1'='1", orgIds: [] })).toThrow(/user id/);
        expect(bad({ actorKind: "anonymous", userId: USER, orgIds: [] })).toThrow(/anonymous/);
        const tooMany = Array.from({ length: 65 }, () => ORG_A);
        expect(bad(userInOrg(tooMany))).toThrow(/limit/);
        expect(bad(userInOrg(Array.from({ length: 64 }, () => ORG_A)))).not.toThrow();
    });
});
