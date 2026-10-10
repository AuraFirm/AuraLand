// Goal: provider identities are unique per provider id and per person, owned correctly, listable and
// removable only by their owner; sign-in flows are single-use, short-lived and belong to the right
// person, and hold only hashes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const ADA = "018f0000-0000-7000-8000-0000000000a1";
const GRACE = "018f0000-0000-7000-8000-0000000000b2";
const anonymous: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const hash = (n: number) => Buffer.alloc(32, n);
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
beforeAll(async () => {
    db = await createMigratedTestDatabase(6);
    await db.database
        .sql`insert into users (id, email) values (${ADA}, 'ada@example.com'), (${GRACE}, 'grace@example.com')`;
});
afterAll(async () => {
    await db.drop();
});

const link = (userId: string, provider: string, providerUserId: string) =>
    db.database
        .sql`insert into oauth_identities (user_id, provider, provider_user_id, email_at_link)
        values (${userId}, ${provider}, ${providerUserId}, 'x@example.com')`;

describe("oauth_identities rules", () => {
    it("accepts a link and refuses the same provider identity for anyone else", async () => {
        await link(ADA, "github", "1001");
        await fails(link(GRACE, "github", "1001"), /oauth_identities_unique_identity/);
        await link(GRACE, "github", "1002");
    });

    it("allows one identity per provider per person, and different providers side by side", async () => {
        await fails(link(ADA, "github", "1003"), /oauth_identities_one_per_provider/);
        await link(ADA, "google", "g-1");
    });

    it("refuses unknown providers and malformed provider ids", async () => {
        await fails(link(ADA, "facebook", "1"), /oauth_identities_provider/);
        await fails(link(ADA, "google", ""), /oauth_identities_provider_user_id/);
        await fails(link(GRACE, "google", "a\nb"), /oauth_identities_provider_user_id/);
    });
});

describe("who may touch oauth_identities", () => {
    it("shows the application role only its own links, and lets it unlink only those", async () => {
        const mine = await inRole(
            db.database,
            "aura_app",
            as(ADA),
            (tx) => tx`select provider from oauth_identities order by provider`,
        );
        expect(mine.map((row) => row["provider"])).toEqual(["github", "google"]);
        const stolen = await inRole(
            db.database,
            "aura_app",
            as(GRACE),
            (tx) => tx`delete from oauth_identities where provider = 'google' returning id`,
        );
        expect(stolen.length).toBe(0);
        const removed = await inRole(
            db.database,
            "aura_app",
            as(ADA),
            (tx) => tx`delete from oauth_identities where provider = 'google' returning id`,
        );
        expect(removed.length).toBe(1);
    });

    it("keeps the application role from creating or editing links", async () => {
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(ADA),
                (tx) =>
                    tx`insert into oauth_identities (user_id, provider, provider_user_id) values (${ADA}, 'google', 'g-9')`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(ADA),
                (tx) => tx`update oauth_identities set provider = 'github'`,
            ),
            /permission denied/,
        );
    });

    it("lets the identity role record a login time but not repoint a link", async () => {
        await inRole(
            db.database,
            "aura_auth",
            anonymous,
            (tx) =>
                tx`update oauth_identities set last_login_at = now() where provider_user_id = '1001'`,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) =>
                    tx`update oauth_identities set user_id = ${GRACE} where provider_user_id = '1001'`,
            ),
            /permission denied/,
        );
    });
});

describe("oauth_flows", () => {
    const flow = (purpose: string, userId: string | null, n: number, minutes = 10) =>
        db.database
            .sql`insert into oauth_flows (provider, purpose, user_id, state_hash, verifier_hash, created_at, expires_at)
            values ('github', ${purpose}, ${userId}, ${hash(n)}, ${hash(n + 100)}, now(), now() + make_interval(mins => ${minutes}))`;

    it("ties link flows to a person and login flows to nobody, and caps the lifetime at 10 minutes", async () => {
        await flow("login", null, 1);
        await flow("link", ADA, 2);
        await fails(flow("link", null, 3), /oauth_flows_owner/);
        await fails(flow("login", ADA, 4), /oauth_flows_owner/);
        await fails(flow("login", null, 5, 11), /oauth_flows_expiry/);
        await fails(flow("login", null, 1), /duplicate key/);
    });

    it("can be spent once, only by the identity role, and is invisible to the application role", async () => {
        const spend = () =>
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) =>
                    tx`update oauth_flows set consumed_at = now() where state_hash = ${hash(1)}`,
            );
        await spend();
        await fails(spend(), /used once/);
        await fails(
            inRole(db.database, "aura_app", as(ADA), (tx) => tx`select 1 from oauth_flows`),
            /permission denied/,
        );
    });
});
