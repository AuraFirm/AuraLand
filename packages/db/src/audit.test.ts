// Goal: the audit log is append-only and hash-chained. It must verify when untouched, detect any
// edit, deletion or truncation, serialize concurrent writers into one chain, refuse changes from
// the application roles, and stop one user from writing entries in another user's name.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEntry, appendAudit, verifyAuditChain } from "./audit.ts";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const USER_A = "018f0000-0000-7000-8000-0000000000aa";
const USER_B = "018f0000-0000-7000-8000-0000000000bb";
const ORG_X = "018f0000-0000-7000-8000-0000000000c1";
const ORG_Y = "018f0000-0000-7000-8000-0000000000c2";

const anonymous: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
const asUser = (userId: string, orgIds: string[] = []): RequestContext => ({
    actorKind: "user",
    userId,
    orgIds,
});

let db: TestDatabase;
beforeEach(async () => {
    db = await createMigratedTestDatabase();
});
afterEach(async () => {
    await db.drop();
});

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
    actorKind: "anonymous",
    actorUserId: null,
    orgId: null,
    action: "test.event",
    target: null,
    ip: null,
    detail: {},
    ...overrides,
});

async function appendMany(count: number, overrides: Partial<AuditEntry> = {}): Promise<void> {
    for (let i = 0; i < count; i++) {
        await inRole(db.database, "aura_auth", anonymous, (tx) =>
            appendAudit(tx, entry({ ...overrides, detail: { i } })),
        );
    }
}

// Tampering needs the owner, who can switch off the append-only trigger. Real operators can too,
// which is why the chain head is also meant to be anchored outside the database.
async function withTriggerOff(work: () => Promise<unknown>): Promise<void> {
    const { sql } = db.database;
    await sql`alter table audit_log disable trigger audit_log_append_only`;
    try {
        await work();
    } finally {
        await sql`alter table audit_log enable trigger audit_log_append_only`;
    }
}

describe("chain verification", () => {
    it("verifies an empty log and a log written in order", async () => {
        expect(await verifyAuditChain(db.database.sql)).toEqual({ ok: true, head: null });
        await appendMany(5);
        const result = await verifyAuditChain(db.database.sql);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.head?.seq).toBe("5");
    });

    it("keeps one valid chain under concurrent writers", async () => {
        const writers = Array.from({ length: 20 }, (_, w) =>
            inRole(db.database, "aura_auth", anonymous, async (tx) => {
                for (let i = 0; i < 5; i++) await appendAudit(tx, entry({ detail: { w, i } }));
            }),
        );
        await Promise.all(writers);
        const [count] = await db.database.sql<{ n: string }[]>`select count(*) as n from audit_log`;
        expect(count?.n).toBe("100");
        expect((await verifyAuditChain(db.database.sql)).ok).toBe(true);
    });

    it("detects an edited row", async () => {
        await appendMany(5);
        await withTriggerOff(
            () => db.database.sql`update audit_log set detail = '{"i": 999}' where seq = 3`,
        );
        expect(await verifyAuditChain(db.database.sql)).toEqual({
            ok: false,
            reason: "broken_chain",
            firstBadSeq: "3",
        });
    });

    it("detects a deleted row in the middle", async () => {
        await appendMany(5);
        await withTriggerOff(() => db.database.sql`delete from audit_log where seq = 3`);
        expect(await verifyAuditChain(db.database.sql)).toEqual({
            ok: false,
            reason: "broken_chain",
            firstBadSeq: "4",
        });
    });

    it("detects truncation of the tail only against an externally kept head", async () => {
        await appendMany(5);
        const before = await verifyAuditChain(db.database.sql);
        if (!before.ok || before.head === null) throw new Error("expected a head");
        await withTriggerOff(() => db.database.sql`delete from audit_log where seq >= 4`);
        expect((await verifyAuditChain(db.database.sql)).ok).toBe(true); // Unanchored, it looks fine.
        expect(await verifyAuditChain(db.database.sql, { expectedHead: before.head })).toEqual({
            ok: false,
            reason: "truncated",
        });
    });

    it("detects a rewritten hash that tries to hide an edit", async () => {
        await appendMany(3);
        await withTriggerOff(
            () =>
                db.database
                    .sql`update audit_log set detail = '{"i": 7}', hash = decode(repeat('ab', 32), 'hex') where seq = 2`,
        );
        const result = await verifyAuditChain(db.database.sql);
        expect(result.ok).toBe(false);
    });
});

describe("append-only protection", () => {
    it("refuses update, delete and truncate even from the owner while the trigger is on", async () => {
        await appendMany(2);
        const { sql } = db.database;
        await expect(sql`update audit_log set action = 'x.y' where seq = 1`).rejects.toThrow(
            /append-only/,
        );
        await expect(sql`delete from audit_log where seq = 1`).rejects.toThrow(/append-only/);
        await expect(sql`truncate audit_log`).rejects.toThrow(/append-only/);
    });

    it("gives the application roles no update, delete or truncate privilege at all", async () => {
        await appendMany(1);
        for (const role of ["aura_app", "aura_auth"] as const) {
            await expect(
                inRole(
                    db.database,
                    role,
                    anonymous,
                    (tx) => tx`update audit_log set action = 'x.y'`,
                ),
            ).rejects.toThrow(/permission denied/);
            await expect(
                inRole(db.database, role, anonymous, (tx) => tx`delete from audit_log`),
            ).rejects.toThrow(/permission denied/);
            await expect(
                inRole(db.database, role, anonymous, (tx) => tx`truncate audit_log`),
            ).rejects.toThrow(/permission denied/);
        }
    });
});

describe("writing and reading as the application", () => {
    it("lets a user log only as themselves", async () => {
        const asA = asUser(USER_A);
        await inRole(db.database, "aura_app", asA, (tx) =>
            appendAudit(tx, entry({ actorKind: "user", actorUserId: USER_A })),
        );
        const forged = inRole(db.database, "aura_app", asA, (tx) =>
            appendAudit(tx, entry({ actorKind: "user", actorUserId: USER_B })),
        );
        await expect(forged).rejects.toThrow(/row-level security/);
    });

    it("shows a member their organization's entries and their own, and nothing else", async () => {
        await inRole(db.database, "aura_auth", anonymous, async (tx) => {
            await appendAudit(tx, entry({ orgId: ORG_X, action: "org.x_event" }));
            await appendAudit(tx, entry({ orgId: ORG_Y, action: "org.y_event" }));
            await appendAudit(
                tx,
                entry({ actorKind: "user", actorUserId: USER_A, action: "me.event" }),
            );
            await appendAudit(tx, entry({ action: "nobody.event" }));
        });
        const seen = await inRole(
            db.database,
            "aura_app",
            asUser(USER_A, [ORG_X]),
            (tx) => tx<{ action: string }[]>`select action from audit_log order by seq`,
        );
        expect(seen.map((row) => row.action)).toEqual(["org.x_event", "me.event"]);
        const anonymousSeen = await inRole(
            db.database,
            "aura_app",
            anonymous,
            (tx) => tx`select 1 from audit_log`,
        );
        expect(anonymousSeen.length).toBe(0);
    });
});

describe("column rules", () => {
    it("rejects malformed rows at the database, whatever the application sends", async () => {
        const { sql } = db.database;
        const insert = (kind: string, action: string, target: string | null, detail: string) =>
            sql`insert into audit_log (actor_kind, action, target, detail) values (${kind}, ${action}, ${target}, ${detail}::jsonb)`;
        await expect(insert("anonymous", "Bad Action", null, "{}")).rejects.toThrow(
            /audit_log_action_format/,
        );
        await expect(insert("robot", "a.b", null, "{}")).rejects.toThrow(/audit_log_actor_kind/);
        await expect(insert("anonymous", "a.b", "x\ny", "{}")).rejects.toThrow(/audit_log_target/);
        const oversized = JSON.stringify({ k: "x".repeat(5000) });
        await expect(insert("anonymous", "a.b", null, oversized)).rejects.toThrow(
            /audit_log_detail_size/,
        );
    });
});
