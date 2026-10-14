// Goal: the lifecycle of signing keys holds in the database. The system registers the first key of an environment
// (repeating it changes nothing); a second active key is refused; only a platform administrator rotates or revokes;
// rotation leaves exactly one active key; a key never changes, never goes back, is never deleted, and the table
// refuses a private key. Setup runs as the owner; behaviour under test runs as the application roles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const ADMIN = "018f0000-0000-7000-8000-000000000a01";
const PERSON = "018f0000-0000-7000-8000-000000000a02";
const NOW = new Date(Date.UTC(2026, 10, 1, 9));
const jwk = (x: string) => ({ kty: "EC", crv: "P-256", x, y: "y" });
let db: TestDatabase;

beforeAll(async () => {
    db = await createMigratedTestDatabase(9);
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at, platform_role) values (${ADMIN}, 'admin@example.com', now(), 'admin')`;
    await sql`insert into users (id, email, email_verified_at) values (${PERSON}, 'p@example.com', now())`;
});
afterAll(async () => {
    await db.drop();
});

const worker = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
const app = <T>(
    user: string,
    work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>,
) => inRole(db.database, "aura_app", { actorKind: "user", userId: user, orgIds: [] }, work);
const register = (kid: string, key: Record<string, string>, env = "development") =>
    worker(
        (tx) =>
            tx`select register_signing_key(${kid}, 'ES256', ${tx.json(key)}, ${env}, ${NOW}) as created`,
    );
const rotate = (user: string, kid: string, key: Record<string, string>, env = "development") =>
    app(
        user,
        (tx) => tx`select rotate_signing_key(${kid}, 'ES256', ${tx.json(key)}, ${env}, ${NOW})`,
    );

describe("signing keys", () => {
    it("registers the first key once, and refuses a second active key or a changed key under the same id", async () => {
        expect((await register("dev-1", jwk("a")))[0]?.["created"]).toBe(true);
        expect((await register("dev-1", jwk("a")))[0]?.["created"]).toBe(false); // repeat: nothing changes
        await expect(register("dev-1", jwk("b"))).rejects.toThrow(/different key/);
        await expect(register("dev-2", jwk("b"))).rejects.toThrow(/rotate instead/);
        expect((await register("prod-1", jwk("c"), "production"))[0]?.["created"]).toBe(true); // another environment
    });

    it("lets only a platform administrator rotate, leaving exactly one active key", async () => {
        await expect(rotate(PERSON, "dev-2", jwk("b"))).rejects.toThrow(/platform administrator/);
        await rotate(ADMIN, "dev-2", jwk("b"));
        const rows = await db.database.sql<{ kid: string; status: string }[]>`
            select kid, status from signing_keys where environment = 'development' order by kid`;
        expect(rows).toEqual([
            { kid: "dev-1", status: "retired" },
            { kid: "dev-2", status: "active" },
        ]);
    });

    it("revokes a key for an administrator only, and keeps the history", async () => {
        const revoke = (user: string, kid: string) =>
            app(user, (tx) => tx`select revoke_signing_key(${kid}, 'suspected leak', ${NOW})`);
        await expect(revoke(PERSON, "dev-1")).rejects.toThrow(/platform administrator/);
        await revoke(ADMIN, "dev-1");
        await expect(revoke(ADMIN, "dev-1")).rejects.toThrow(/no such key/); // already revoked
        const [row] = await db.database.sql<{ status: string; revoke_reason: string }[]>`
            select status, revoke_reason from signing_keys where kid = 'dev-1'`;
        expect(row).toEqual({ status: "revoked", revoke_reason: "suspected leak" });
    });

    it("never changes a key, moves it back, deletes it, or stores a private member", async () => {
        const { sql } = db.database;
        await expect(
            sql`update signing_keys set public_jwk = ${sql.json(jwk("z"))} where kid = 'dev-2'`,
        ).rejects.toThrow(/never changes/);
        await expect(
            sql`update signing_keys set status = 'active' where kid = 'dev-1'`,
        ).rejects.toThrow(/cannot move/);
        await expect(sql`delete from signing_keys where kid = 'dev-1'`).rejects.toThrow(/kept/);
        await expect(
            sql`insert into signing_keys (kid, alg, public_jwk, environment, not_before)
                values ('leaky', 'ES256', ${sql.json({ ...jwk("q"), d: "secret" })}, 'production', now())`,
        ).rejects.toThrow(/signing_keys_public/);
    });

    it("is readable by anyone, as public keys are, and writable by no application role directly", async () => {
        const rows = await inRole(
            db.database,
            "aura_app",
            { actorKind: "anonymous", userId: null, orgIds: [] },
            (tx) => tx`select kid from signing_keys`,
        );
        expect(rows.length).toBeGreaterThanOrEqual(3);
        await expect(
            app(
                ADMIN,
                (tx) =>
                    tx`insert into signing_keys (kid, alg, public_jwk, environment, not_before) values ('x1x', 'ES256', '{}', 'development', now())`,
            ),
        ).rejects.toThrow();
    });
});
