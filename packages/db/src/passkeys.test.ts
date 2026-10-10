// Goal: passkeys keep only public keys, never exceed 20 per person (even under concurrency), never
// accept a counter that goes backwards, show the application role only its own rows and never the
// key or counter; challenges are single-use, short-lived and owned correctly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const ADA = "018f0000-0000-7000-8000-0000000000a1";
const GRACE = "018f0000-0000-7000-8000-0000000000b2";
const anonymous: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const bytes = (n: number, size = 32) => Buffer.alloc(size, n);
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    await db.database
        .sql`insert into users (id, email) values (${ADA}, 'ada@example.com'), (${GRACE}, 'grace@example.com')`;
});
afterAll(async () => {
    await db.drop();
});

interface PasskeyInput {
    readonly credentialId: Buffer;
    readonly publicKey: Buffer;
    readonly transports: string[];
    readonly deviceType: string;
    readonly backedUp: boolean;
    readonly name: string;
}

async function addPasskey(userId: string, seed: number, overrides: Partial<PasskeyInput> = {}) {
    const row: PasskeyInput = {
        credentialId: bytes(seed),
        publicKey: bytes(seed, 77),
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        name: "Laptop",
        ...overrides,
    };
    await db.database.sql`
        insert into passkeys (user_id, credential_id, public_key, transports, device_type, backed_up, name)
        values (${userId}, ${row.credentialId}, ${row.publicKey}, ${row.transports},
                ${row.deviceType}, ${row.backedUp}, ${row.name})`;
}

describe("passkeys constraints", () => {
    it("accepts a valid passkey and refuses a repeated credential id", async () => {
        await addPasskey(ADA, 1);
        await fails(addPasskey(GRACE, 1), /duplicate key/);
    });

    it("refuses malformed values", async () => {
        await fails(
            addPasskey(ADA, 2, { credentialId: bytes(2, 4) }),
            /passkeys_credential_id_size/,
        );
        await fails(addPasskey(ADA, 3, { publicKey: bytes(3, 4) }), /passkeys_public_key_size/);
        await fails(addPasskey(ADA, 4, { transports: ["telepathy"] }), /passkeys_transports/);
        await fails(addPasskey(ADA, 5, { deviceType: "other" }), /passkeys_device_type/);
        await fails(addPasskey(ADA, 6, { name: "" }), /passkeys_name/);
        await fails(addPasskey(ADA, 7, { name: "a\nb" }), /passkeys_name/);
        await fails(addPasskey(ADA, 8, { name: "x".repeat(81) }), /passkeys_name/);
    });

    it("never lets the counter fall, but allows it to stay at zero", async () => {
        const { sql } = db.database;
        await sql`update passkeys set counter = 0 where credential_id = ${bytes(1)}`;
        await sql`update passkeys set counter = 5 where credential_id = ${bytes(1)}`;
        await fails(
            sql`update passkeys set counter = 4 where credential_id = ${bytes(1)}`,
            /only move forward/,
        );
        await fails(
            sql`update passkeys set counter = 4294967296 where credential_id = ${bytes(1)}`,
            /passkeys_counter_range/,
        );
    });

    it("caps one person at 20 passkeys, also with 10 simultaneous registrations", async () => {
        const { sql } = db.database;
        await sql`delete from passkeys where user_id = ${GRACE}`;
        await Promise.all(Array.from({ length: 10 }, (_, i) => addPasskey(GRACE, 100 + i)));
        const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, i) => addPasskey(GRACE, 120 + i)),
        );
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(10);
        const [row] = await sql<
            { n: string }[]
        >`select count(*) n from passkeys where user_id = ${GRACE}`;
        expect(row?.n).toBe("20");
        await fails(addPasskey(GRACE, 200), /at most 20/);
    });
});

describe("who may touch passkeys", () => {
    it("shows the application role only its own passkeys, and never the key or counter", async () => {
        const rows = await inRole(
            db.database,
            "aura_app",
            as(ADA),
            (tx) => tx`select id, user_id, name from passkeys`,
        );
        expect(rows.length).toBe(1);
        expect(rows[0]?.["user_id"]).toBe(ADA);
        const asAda = (work: Parameters<typeof inRole>[3]) =>
            inRole(db.database, "aura_app", as(ADA), work);
        await fails(
            asAda((tx) => tx`select public_key from passkeys`),
            /permission denied/,
        );
        await fails(
            asAda((tx) => tx`select counter from passkeys`),
            /permission denied/,
        );
        await fails(
            asAda((tx) => tx`select credential_id from passkeys`),
            /permission denied/,
        );
        await fails(
            inRole(db.database, "aura_app", as(ADA), (tx) => tx`select * from passkeys`),
            /permission denied/,
        );
    });
});

describe("who may touch passkeys, continued", () => {
    it("lets the owner rename and delete, not touch another person's passkey, and not insert", async () => {
        const [mine] = await inRole(
            db.database,
            "aura_app",
            as(ADA),
            (tx) => tx<{ id: string }[]>`select id from passkeys`,
        );
        const changed = await inRole(
            db.database,
            "aura_app",
            as(GRACE),
            (tx) =>
                tx`update passkeys set name = 'stolen' where id = ${mine?.id ?? ""} returning id`,
        );
        expect(changed.length).toBe(0);
        const deleted = await inRole(
            db.database,
            "aura_app",
            as(GRACE),
            (tx) => tx`delete from passkeys where id = ${mine?.id ?? ""} returning id`,
        );
        expect(deleted.length).toBe(0);
        await inRole(
            db.database,
            "aura_app",
            as(ADA),
            (tx) => tx`update passkeys set name = 'Renamed' where id = ${mine?.id ?? ""}`,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(ADA),
                (tx) => tx`update passkeys set counter = 99 where id = ${mine?.id ?? ""}`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(ADA),
                (tx) =>
                    tx`insert into passkeys (user_id, credential_id, public_key, device_type, backed_up, name) values (${ADA}, ${bytes(50)}, ${bytes(50, 77)}, 'singleDevice', false, 'x')`,
            ),
            /permission denied/,
        );
    });

    it("lets the identity role record use but not rewrite the key", async () => {
        await inRole(
            db.database,
            "aura_auth",
            anonymous,
            (tx) =>
                tx`update passkeys set counter = 9, last_used_at = now() where credential_id = ${bytes(1)}`,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) =>
                    tx`update passkeys set public_key = ${bytes(9, 77)} where credential_id = ${bytes(1)}`,
            ),
            /permission denied/,
        );
    });
});

describe("webauthn_challenges", () => {
    const challenge = (n: number) => Buffer.alloc(32, n).toString("base64url");
    const insert = (purpose: string, userId: string | null, n: number, minutes = 5) =>
        db.database
            .sql`insert into webauthn_challenges (challenge, purpose, user_id, created_at, expires_at)
            values (${challenge(n)}, ${purpose}, ${userId}, now(), now() + make_interval(mins => ${minutes}))`;

    it("ties registration to a person and login to nobody, and caps the lifetime at 5 minutes", async () => {
        await insert("register", ADA, 1);
        await insert("login", null, 2);
        await fails(insert("register", null, 3), /webauthn_challenges_owner/);
        await fails(insert("login", ADA, 4), /webauthn_challenges_owner/);
        await fails(insert("login", null, 5, 6), /webauthn_challenges_expiry/);
        await fails(insert("login", null, 2), /duplicate key/);
        await fails(insert("login", null, 6, 0), /webauthn_challenges_expiry/);
    });

    it("can be consumed once, and only by the identity role", async () => {
        const [row] = await db.database.sql<
            { id: string }[]
        >`select id from webauthn_challenges where challenge = ${challenge(2)}`;
        const id = row?.id ?? "";
        await inRole(
            db.database,
            "aura_auth",
            anonymous,
            (tx) => tx`update webauthn_challenges set consumed_at = now() where id = ${id}`,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) => tx`update webauthn_challenges set consumed_at = null where id = ${id}`,
            ),
            /used once/,
        );
        await fails(
            inRole(db.database, "aura_app", as(ADA), (tx) => tx`select 1 from webauthn_challenges`),
            /permission denied/,
        );
    });
});
