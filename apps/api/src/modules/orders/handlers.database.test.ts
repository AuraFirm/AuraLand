// Goal: the delivery.build job turns a placed order into a stored manifest whose hash the database
// recomputes; a retry or a revoked delivery is a harmless no-op; and the worker role reaches the data
// only through the two build functions. Runs against real PostgreSQL as the worker role.
import { createHash } from "node:crypto";
import { withRequestContext } from "@aura/db/context";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPEC } from "../../http-task-support.ts";
import { createFakeClock } from "../../sim/world.ts";
import { buildDelivery } from "./handlers.ts";

const ADMIN = "018f0000-0000-7000-8000-0000000003a1";
const SETTER = "018f0000-0000-7000-8000-0000000003a2";
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const NOW = new Date("2026-10-12T10:00:00Z");

let db: TestDatabase;
let customer = "";
let version = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(6);
    const { sql } = db.database;
    await sql`insert into users (id, email, platform_role) values (${ADMIN}, 'adm@example.com', 'admin')`;
    await sql`insert into users (id, email) values (${SETTER}, 'set@example.com')`;
    const [seller] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'sell', 'S') returning id`;
    const [buyer] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('ai_lab', 'buy', 'B') returning id`;
    customer = buyer?.id ?? "";
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${seller?.id ?? ""}, 'sold-task', 'algorithmic', 'private', 'T', ${SETTER}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const hash = createHash("sha256").update("bundle").digest();
    const [released] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${seller?.id ?? ""}, ${task?.id ?? ""}, 1, 'released', ${sql.json(SPEC)}, 'Add two numbers.', 6, ${hash}, ${SETTER}, ${ADMIN}, now(), true, now())
        returning id`;
    version = released?.id ?? "";
    await sql`alter table task_versions enable trigger task_versions_guard`;
});
afterAll(async () => {
    await db.drop();
});

const context = () => ({
    clock: createFakeClock(NOW.getTime()),
    storage: undefined as never, // tigerlint-allow: no-as-cast -- the build job never touches storage
    inTransaction: <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
        withRequestContext(db.database.sql, WORKER, work),
});

let placed = 0;
async function placedDelivery(): Promise<string> {
    const admin = { actorKind: "user", userId: ADMIN, orgIds: [] } as const;
    const rows = await inRole(db.database, "aura_app", admin, async (tx) => {
        const [order] = await tx<
            { id: string }[]
        >`select create_order(${customer}, 'T', 'L', 30, ${NOW}) as id`;
        await tx`select add_order_item(${order?.id ?? ""}, ${version}, ${NOW})`;
        return tx<
            { id: string }[]
        >`select place_order(${order?.id ?? ""}, ${(++placed).toString(16).padStart(32, "0")}, ${NOW}) as id`;
    });
    return rows[0]?.id ?? "";
}

describe("buildDelivery", () => {
    it("stores the manifest, with a hash the database computed, and audits it", async () => {
        const id = await placedDelivery();
        const result = await buildDelivery({ delivery_id: id }, context());
        expect(result.outcome).toBe("ready");
        const [row] = await db.database.sql<{ state: string; manifest: string; sha: string }[]>`
            select state, manifest, encode(manifest_sha256, 'hex') as sha from deliveries where id = ${id}`;
        expect(row?.state).toBe("ready");
        expect(row?.sha).toBe(
            createHash("sha256")
                .update(row?.manifest ?? "")
                .digest("hex"),
        );
        expect(JSON.parse(row?.manifest ?? "").items[0].statement).toContain(
            "Delivery reference: ref-",
        );
        const audit = await db.database
            .sql`select seq from audit_log where action = 'delivery.built' and actor_kind = 'worker'`;
        expect(audit.length).toBe(1);
    });

    it("does nothing a second time and nothing for a revoked delivery", async () => {
        const id = await placedDelivery();
        await buildDelivery({ delivery_id: id }, context());
        expect((await buildDelivery({ delivery_id: id }, context())).outcome).toBe("skipped");
        const revoked = await placedDelivery();
        const admin = { actorKind: "user", userId: ADMIN, orgIds: [] } as const;
        await inRole(
            db.database,
            "aura_app",
            admin,
            (tx) => tx`select revoke_delivery(${revoked}, 'no', ${NOW})`,
        );
        expect((await buildDelivery({ delivery_id: revoked }, context())).outcome).toBe("skipped");
    });

    it("refuses a payload with extra fields, and gives the worker no table access", async () => {
        await expect(buildDelivery({ delivery_id: ADMIN, extra: 1 }, context())).rejects.toThrow();
        await expect(context().inTransaction((tx) => tx`select * from deliveries`)).rejects.toThrow(
            /permission denied/,
        );
        await expect(
            context().inTransaction((tx) => tx`select licence_terms from orders`),
        ).rejects.toThrow(/permission denied/);
    });
});
