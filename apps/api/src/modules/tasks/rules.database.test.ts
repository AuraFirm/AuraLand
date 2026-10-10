// Goal: the state machine in rules.ts and the guard trigger in migration 0012 allow exactly the same
// moves. Either layer alone could drift; this test compares them, so a change to one without the
// other fails CI. Needs a PostgreSQL 18 server (AURA_TEST_DATABASE_URL).
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ALLOWED_PAIRS } from "./rules.ts";

let db: TestDatabase;
beforeAll(async () => {
    db = await createMigratedTestDatabase(2);
});
afterAll(async () => {
    await db.drop();
});

it("lists the same state pairs in the application and in the database trigger", async () => {
    const [row] = await db.database.sql<{ source: string }[]>`
        select prosrc as source from pg_proc where proname = 'task_versions_guard'`;
    const source = row?.source ?? "";
    const declared = source.slice(source.indexOf("allowed text[]"), source.indexOf("begin"));
    const inDatabase = [...declared.matchAll(/'([a-z_]+>[a-z_]+)'/g)].map((m) => m[1] ?? "");
    expect(inDatabase.length).toBeGreaterThan(0);
    expect([...inDatabase].sort()).toEqual([...ALLOWED_PAIRS].sort());
});
