// Goal: housekeeping removes exactly the rows whose grace period has passed, nothing newer, in bounded
// batches; only the worker role may run it; the upload helpers close only unfinished expired uploads.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const WORKER = { actorKind: "worker", userId: null, orgIds: [] } as const;
const NOW = new Date("2026-10-11T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let db: TestDatabase;
const USER = "018f0000-0000-7000-8000-000000000a01";
beforeAll(async () => {
    db = await createMigratedTestDatabase(4);
    await db.database.sql`insert into users (id, email) values (${USER}, 'cleanup@example.com')`;
});
afterAll(async () => {
    await db.drop();
});

const cleanup = () =>
    inRole(db.database, "aura_worker", WORKER, async (tx) => {
        const rows = await tx`select cleanup_expired(${NOW}) as counts`;
        const counts = rows[0]?.["counts"];
        if (typeof counts !== "object" || counts === null) throw new Error("no counts returned");
        return Object.fromEntries(Object.entries(counts).map(([name, n]) => [name, Number(n)]));
    });

async function seedSession(label: string, absoluteExpiresDaysAgo: number) {
    const created = ago(absoluteExpiresDaysAgo + 1);
    await db.database
        .sql`insert into sessions (user_id, token_hash, auth_method, privileged, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at) values (${USER}, ${randomBytes(32)}, 'email_code', false, ${created}, ${created},
        ${ago(absoluteExpiresDaysAgo)}, ${ago(absoluteExpiresDaysAgo)})`;
    return label;
}

describe("cleanup_expired", () => {
    it("removes old rows after their grace period and keeps newer ones", async () => {
        await seedSession("long gone", 20);
        await seedSession("just expired", 1);
        await seedSession("future", -5);
        const first = await cleanup();
        expect(first["sessions"]).toBe(1);
        const [left] = await db.database.sql<
            { n: string }[]
        >`select count(*)::text as n from sessions`;
        expect(Number(left?.n)).toBe(2);
        // A second pass finds nothing more.
        expect((await cleanup())["sessions"]).toBe(0);
    });

    it("cleans challenges, flows, windows, finished uploads and old jobs on their own schedules", async () => {
        const { sql } = db.database;
        await sql`insert into webauthn_challenges (user_id, purpose, challenge, created_at, expires_at)
            values (${USER}, 'register', ${randomBytes(32).toString("base64url")}, ${ago(3)}, ${new Date(ago(3).getTime() + 300_000)}),
                   (${USER}, 'register', ${randomBytes(32).toString("base64url")}, ${ago(0)}, ${new Date(ago(0).getTime() + 300_000)})`;
        await sql`insert into rate_limit_counters (key_hash, window_start, count) values (${randomBytes(32)}, ${ago(5)}, 3), (${randomBytes(32)}, ${ago(0)}, 1)`;
        await sql`insert into jobs (kind, queue, payload, state, run_after, created_at, updated_at) values
            ('a.b', 'q', '{}'::jsonb, 'done', ${ago(10)}, ${ago(10)}, ${ago(10)}),
            ('a.b', 'q', '{}'::jsonb, 'done', ${ago(1)}, ${ago(1)}, ${ago(1)}),
            ('a.b', 'q', '{}'::jsonb, 'ready', ${ago(40)}, ${ago(40)}, ${ago(40)})`;
        const counts = await cleanup();
        expect(counts["webauthn_challenges"]).toBe(1);
        expect(counts["rate_limit_counters"]).toBe(1);
        expect(counts["jobs"]).toBe(1);
        const [kept] = await sql<{ n: string }[]>`select count(*)::text as n from jobs`;
        expect(Number(kept?.n)).toBe(2);
    });

    it("may be run by the worker role only", async () => {
        for (const role of ["aura_app", "aura_auth"] as const) {
            await expect(
                inRole(
                    db.database,
                    role,
                    { actorKind: "anonymous", userId: null, orgIds: [] },
                    (tx) => tx`select cleanup_expired(${NOW})`,
                ),
            ).rejects.toThrow(/permission denied/);
        }
    });
});

describe("upload helpers", () => {
    it("lists unfinished uploads past their expiry and closes each once", async () => {
        const { sql } = db.database;
        const [org] = await sql<
            { id: string }[]
        >`insert into orgs (kind, slug, name) values ('company', 'cleanup-org', 'x') returning id`;
        await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${USER}, 'owner')`;
        const [task] = await sql<
            { id: string }[]
        >`insert into tasks (org_id, slug, kind, title, created_by) values (${org?.id ?? ""}, 'cleanup-task', 'function', 'x', ${USER}) returning id`;
        const [version] = await sql<
            { id: string }[]
        >`insert into task_versions (org_id, task_id, seq, created_by) values (${org?.id ?? ""}, ${task?.id ?? ""}, 1, ${USER}) returning id`;
        const upload = async (createdDaysAgo: number) => {
            const created = ago(createdDaysAgo);
            const [row] = await sql<
                { id: string }[]
            >`insert into bundle_uploads (org_id, task_version_id, started_by, storage_upload_id,
                expected_bytes, expected_sha256, part_bytes, part_count, created_at, expires_at)
                values (${org?.id ?? ""}, ${version?.id ?? ""}, ${USER}, 'sid', 100, ${randomBytes(32)}, 8388608, 1, ${created}, ${new Date(created.getTime() + 3_600_000)}) returning id`;
            return row?.id ?? "";
        };
        const old = await upload(2);
        await upload(0);
        const listed = await inRole(
            db.database,
            "aura_worker",
            WORKER,
            (tx) => tx`select id from expired_uploads(${NOW}, 10)`,
        );
        expect(listed.map((r) => r["id"])).toEqual([old]);
        const closed = (
            await inRole(
                db.database,
                "aura_worker",
                WORKER,
                (tx) => tx`select close_upload(${old}, ${NOW}) as ok`,
            )
        )[0]?.["ok"];
        expect(closed).toBe(true);
        const again = (
            await inRole(
                db.database,
                "aura_worker",
                WORKER,
                (tx) => tx`select close_upload(${old}, ${NOW}) as ok`,
            )
        )[0]?.["ok"];
        expect(again).toBe(false);
        // A closed upload is not listed again.
        const after = await inRole(
            db.database,
            "aura_worker",
            WORKER,
            (tx) => tx`select id from expired_uploads(${NOW}, 10)`,
        );
        expect(after).toEqual([]);
    });
});
