// Goal: placing an order queues one watermark job per version, the tag is derived by the database from a
// secret and cannot be chosen by a node, a delivered bundle is recorded once and never changes, and the
// manifest build is queued exactly when the last version has been recorded. Runs against real PostgreSQL.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const ADMIN = "018f0000-0000-7000-8000-0000000004a1";
const SETTER = "018f0000-0000-7000-8000-0000000004a2";
const WORKER = { actorKind: "worker", userId: null, orgIds: [] } as const;
const admin = { actorKind: "user", userId: ADMIN, orgIds: [] } as const;
const NOW = new Date("2026-10-14T10:00:00Z");

let db: TestDatabase;
let customer = "";
let seller = "";
let node = "";
const versions: { id: string; sha: Buffer }[] = [];
beforeAll(async () => {
    db = await createMigratedTestDatabase(6);
    const { sql } = db.database;
    await sql`insert into users (id, email, platform_role) values (${ADMIN}, 'adm4@example.com', 'admin')`;
    await sql`insert into users (id, email) values (${SETTER}, 'set4@example.com')`;
    const [s] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'sell4', 'S') returning id`;
    const [b] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('ai_lab', 'buy4', 'B') returning id`;
    seller = s?.id ?? "";
    customer = b?.id ?? "";
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${seller}, 'sold4', 'algorithmic', 'private', 'T', ${SETTER}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    for (const seq of [1, 2]) {
        const sha = createHash("sha256").update(`bundle-${seq}`).digest();
        const [v] = await sql<{ id: string }[]>`insert into task_versions
            (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
            values (${seller}, ${task?.id ?? ""}, ${seq}, ${seq === 1 ? "retired" : "released"}, ${sql.json({ spec_version: 1 })}, 's', 100, ${sha}, ${SETTER}, ${ADMIN}, now(), true, now())
            returning id`;
        versions.push({ id: v?.id ?? "", sha });
    }
    // Version 1 is retired and cannot be ordered; use two orders, one for version 2 and a second task below.
    const [task2] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${seller}, 'sold4b', 'algorithmic', 'private', 'T2', ${SETTER}) returning id`;
    const sha = createHash("sha256").update("bundle-3").digest();
    const [v3] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${seller}, ${task2?.id ?? ""}, 1, 'released', ${sql.json({ spec_version: 1 })}, 's', 100, ${sha}, ${SETTER}, ${ADMIN}, now(), true, now())
        returning id`;
    versions.push({ id: v3?.id ?? "", sha });
    await sql`alter table task_versions enable trigger task_versions_guard`;
    const [n] = await sql<
        { id: string }[]
    >`insert into judge_nodes (name, public_key, state, created_at)
        values ('wm-node', ${randomBytes(32)}, 'active', now()) returning id`;
    node = n?.id ?? "";
});
afterAll(async () => {
    await db.drop();
});

let placed = 0;
// An order for the released versions (index 1 and 2), placed with a fresh watermark id.
async function placedDelivery(items = [1, 2]): Promise<{ id: string; watermark: string }> {
    const watermark = (++placed).toString(16).padStart(32, "0");
    const rows = await inRole(db.database, "aura_app", admin, async (tx) => {
        const [order] = await tx<
            { id: string }[]
        >`select create_order(${customer}, 'T', 'L', 30, ${NOW}) as id`;
        for (const index of items)
            await tx`select add_order_item(${order?.id ?? ""}, ${versions[index]?.id ?? ""}, ${NOW})`;
        return tx<
            { id: string }[]
        >`select place_order(${order?.id ?? ""}, ${watermark}, ${NOW}) as id`;
    });
    return { id: rows[0]?.id ?? "", watermark };
}
const asWorker = <T>(work: Parameters<typeof inRole<T>>[3]) =>
    inRole(db.database, "aura_worker", WORKER, work);
const record = (
    delivery: string,
    index: number,
    sha: Buffer,
    answers = false,
    solutions = true,
    source = versions[index]?.sha,
) =>
    asWorker(
        (tx) =>
            tx<
                { o: string }[]
            >`select record_delivery_bundle(${delivery}, ${versions[index]?.id ?? ""}, ${source ?? null}, ${sha}, 100,
                ${answers}, ${solutions}, true, ${node}, ${NOW}) as o`,
    ).then((rows) => rows[0]?.o);
const buildJobs = async (delivery: string) =>
    (
        await db.database
            .sql`select 1 from jobs where kind = 'delivery.build' and payload->>'delivery_id' = ${delivery}`
    ).length;

describe("the tag", () => {
    it("is derived by the database: stable, secret-dependent, per version, top bit set, 32 bits", async () => {
        const { sql } = db.database;
        const tag = async (watermark: string, version: string) =>
            Number(
                (await sql<{ t: string }[]>`select delivery_tag(${watermark}, ${version}) as t`)[0]
                    ?.t,
            );
        const a = await tag("a".repeat(32), versions[1]?.id ?? "");
        expect(await tag("a".repeat(32), versions[1]?.id ?? "")).toBe(a);
        expect(await tag("b".repeat(32), versions[1]?.id ?? "")).not.toBe(a);
        expect(await tag("a".repeat(32), versions[2]?.id ?? "")).not.toBe(a);
        expect(a).toBeGreaterThanOrEqual(2 ** 31);
        expect(a).toBeLessThan(2 ** 32);
        await expect(
            asWorker((tx) => tx`select delivery_tag('x', ${versions[1]?.id ?? ""})`),
        ).rejects.toThrow(/permission denied/);
    });
});

describe("watermark jobs", () => {
    it("are queued per version when an order is placed, without a manifest build", async () => {
        const d = await placedDelivery();
        const jobs = await db.database
            .sql`select payload->>'task_version_id' as v from jobs where kind = 'delivery.watermark' and payload->>'delivery_id' = ${d.id} order by 1`;
        expect(jobs.length).toBe(2);
        expect(await buildJobs(d.id)).toBe(0);
        const input = await asWorker(
            (tx) =>
                tx<
                    { i: { tag: number; bundle_sha256: string; task_org_id: string } | null }[]
                >`select watermark_job_input(${d.id}, ${versions[1]?.id ?? ""}) as i`,
        );
        expect(input[0]?.i?.bundle_sha256).toBe(versions[1]?.sha.toString("hex"));
        expect(input[0]?.i?.task_org_id).toBe(seller);
        const stray = await asWorker(
            (tx) => tx`select watermark_job_input(${d.id}, ${versions[0]?.id ?? ""}) as i`,
        );
        expect(stray[0]?.["i"]).toBeNull(); // a version that is not in the order has nothing to do
    });
});

describe("recording a delivered bundle", () => {
    it("queues the manifest build exactly when the last version is recorded, once", async () => {
        const d = await placedDelivery();
        const marked = createHash("sha256").update("marked").digest();
        expect(await record(d.id, 1, marked)).toBe("recorded");
        expect(await buildJobs(d.id)).toBe(0);
        expect(await record(d.id, 2, versions[2]?.sha ?? marked, false, false)).toBe("recorded");
        expect(await buildJobs(d.id)).toBe(1);
        expect(await record(d.id, 2, versions[2]?.sha ?? marked, false, false)).toBe("already");
        expect(await buildJobs(d.id)).toBe(1);
        const [row] = await db.database.sql<
            { tag: string; attestation: string }[]
        >`select tag, attestation from delivery_bundles where delivery_id = ${d.id} and task_version_id = ${versions[1]?.id ?? ""}`;
        const [expected] = await db.database.sql<
            { t: string }[]
        >`select delivery_tag(${d.watermark}, ${versions[1]?.id ?? ""}) as t`;
        expect(row?.tag).toBe(expected?.t);
        expect(row?.attestation).toBe("development");
    });

    it("refuses another version's bundle, a node that is not live, and inconsistent marks", async () => {
        const d = await placedDelivery();
        const other = createHash("sha256").update("x").digest();
        await expect(record(d.id, 1, other, false, true, other)).rejects.toThrow(
            /not in this order/,
        );
        await expect(record(d.id, 1, other, false, false)).rejects.toThrow(
            /delivery_bundles_marks/,
        ); // changed bytes need a mark
        await expect(record(d.id, 1, versions[1]?.sha ?? other, false, true)).rejects.toThrow(
            /delivery_bundles_marks/,
        ); // a mark needs changed bytes
        await db.database.sql`update judge_nodes set state = 'revoked' where id = ${node}`;
        await expect(record(d.id, 1, other)).rejects.toThrow(/live node/);
        await db.database.sql`update judge_nodes set state = 'active' where id = ${node}`.catch(
            () => undefined,
        );
    });
});

describe("recorded bundles", () => {
    it("says gone for a revoked delivery, and its records never change or go", async () => {
        const [fresh] = await db.database.sql<
            { id: string }[]
        >`insert into judge_nodes (name, public_key, state, created_at) values ('wm-node-2', ${randomBytes(32)}, 'active', now()) returning id`;
        node = fresh?.id ?? node;
        const d = await placedDelivery();
        const marked = createHash("sha256").update("m2").digest();
        await record(d.id, 1, marked);
        await expect(
            db.database.sql`update delivery_bundles set bytes = 5 where delivery_id = ${d.id}`,
        ).rejects.toThrow(/never changes/);
        await expect(
            db.database.sql`delete from delivery_bundles where delivery_id = ${d.id}`,
        ).rejects.toThrow(/never changes/);
        const gone = await placedDelivery();
        await inRole(
            db.database,
            "aura_app",
            admin,
            (tx) => tx`select revoke_delivery(${gone.id}, 'no', ${NOW})`,
        );
        expect(await record(gone.id, 1, marked)).toBe("gone");
    });

    it("lets only platform administrators read the records", async () => {
        const d = await placedDelivery([1]);
        await record(d.id, 1, createHash("sha256").update("m3").digest());
        const read = (ctx: typeof admin | { actorKind: "user"; userId: string; orgIds: never[] }) =>
            inRole(
                db.database,
                "aura_app",
                ctx,
                (tx) => tx`select delivery_id from delivery_bundles where delivery_id = ${d.id}`,
            );
        expect((await read(admin)).length).toBe(1);
        expect((await read({ actorKind: "user", userId: SETTER, orgIds: [] })).length).toBe(0);
    });
});
