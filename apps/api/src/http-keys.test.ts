// Goal: prove API keys, passkey step-up and organization verification end to end. Keys: shown once,
// stored as a hash, usable without cookies or the CSRF header, scoped to their organization, dead
// the moment they are revoked or expire. Step-up: privileged actions need a passkey check in the last
// 15 minutes. Verification: platform administrators only.

import {
    apiKeyCreatedSchema,
    apiKeysResponseSchema,
    keyIntrospectionSchema,
} from "@aura/contracts/api/api-keys";
import { encodeId } from "@aura/contracts/ids";
import { verifyAuditChain } from "@aura/db/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import { createVirtualAuthenticator } from "./modules/identity/virtual-authenticator.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const EVE = "018f0000-0000-7000-8000-0000000000e5";
const MINUTE = 60 * 1000;

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now()), (${DAVE}, 'dave@example.com', now()), (${EVE}, 'eve@example.com', now())`;
    await sql`insert into profiles (user_id, handle, display_name) values (${CAROL}, 'carol', 'Carol'), (${DAVE}, 'dave', 'Dave'), (${EVE}, 'eve', 'Eve')`;
    await sql`update users set platform_role = 'admin' where id = ${EVE}`;
});
afterAll(async () => {
    await h.drop();
});

const JSON_HEADERS = { "content-type": "application/json" };
const TRUST = { AURA_TRUST_EDGE_REQUEST_ID: "true" };
let addressCounter = 0;
const call = (token: string | null, method: string, path: string, body?: unknown) =>
    Promise.resolve(
        h.app(TRUST).request(`/api/v1${path}`, {
            method,
            headers: browser(token, {
                ...JSON_HEADERS,
                "x-forwarded-for": `203.0.113.${++addressCounter}`,
            }),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );
const withKey = (key: string, method = "GET", path = "/key") =>
    Promise.resolve(
        h.app(TRUST).request(`/api/v1${path}`, {
            method,
            headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "198.51.100.9" },
        }),
    );

let slugCounter = 0;
// A fresh team owned by ALICE, with BOB as admin and CAROL as member. Earlier organizations of the
// test people are removed first so the 20-organization limit never gets in the way.
async function team(reset = true) {
    const { sql } = h.db.database;
    if (reset)
        await sql`delete from orgs where id in (select org_id from memberships where user_id in (${ALICE}, ${BOB}, ${CAROL}, ${DAVE}, ${EVE}))`;
    await sql`delete from passkeys where user_id in (${ALICE}, ${BOB}, ${CAROL}, ${DAVE}, ${EVE})`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', ${`keys-team-${++slugCounter}`}, 'Keys Team') returning id`;
    const id = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${id}, ${ALICE}, 'owner'), (${id}, ${BOB}, 'admin'), (${id}, ${CAROL}, 'member')`;
    return { id, publicId: encodeId("org", id), owner: (await h.login(ALICE)).token };
}

async function createKey(
    token: string,
    orgId: string,
    body: Record<string, unknown> = { name: "ci" },
) {
    return call(token, "POST", `/orgs/${orgId}/api-keys`, body);
}
const parsedKey = async (response: Response) => apiKeyCreatedSchema.parse(await response.json());

describe("creating and listing keys", () => {
    it("shows the whole key once, stores only its hash, and lists it without the secret", async () => {
        const t = await team();
        const response = await createKey(t.owner, t.publicId, {
            name: "deploy",
            scopes: ["org:read"],
            expires_in_days: 30,
        });
        expect(response.status).toBe(201);
        const created = await parsedKey(response);
        expect(created.key).toMatch(/^aura_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
        expect(created.key.startsWith(`aura_${created.prefix}_`)).toBe(true);
        const list = await call(t.owner, "GET", `/orgs/${t.publicId}/api-keys`);
        const text = JSON.stringify(await list.json());
        expect(apiKeysResponseSchema.parse(JSON.parse(text)).items.length).toBe(1);
        const secret = created.key.split("_")[2] ?? "";
        expect(text).not.toContain(secret);
        const [row] = await h.db.database.sql<
            { secret_hash: Buffer }[]
        >`select secret_hash from api_keys where prefix = ${created.prefix}`;
        expect(row?.secret_hash.toString("hex")).not.toContain(secret);
        const [audit] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'api_key.created' and org_id = ${t.id}`;
        expect(audit?.n).toBe("1");
        const auditText = JSON.stringify(
            await h.db.database.sql`select detail, target from audit_log where org_id = ${t.id}`,
        );
        expect(auditText).not.toContain(secret);
    });

    it("lets owners and admins manage keys, refuses members with 403 and outsiders with 404", async () => {
        const t = await team();
        const bob = await h.login(BOB);
        const carol = await h.login(CAROL);
        const dave = await h.login(DAVE);
        expect((await createKey(bob.token, t.publicId)).status).toBe(201);
        expect((await createKey(carol.token, t.publicId)).status).toBe(403);
        expect((await createKey(dave.token, t.publicId)).status).toBe(404);
        expect((await call(carol.token, "GET", `/orgs/${t.publicId}/api-keys`)).status).toBe(403);
        expect((await call(dave.token, "GET", `/orgs/${t.publicId}/api-keys`)).status).toBe(404);
        expect((await createKey("", t.publicId)).status).toBe(401);
    });

    it("refuses bad input and caps live keys at 20", async () => {
        const t = await team();
        for (const bad of [
            {},
            { name: "" },
            { name: "x", scopes: [] },
            { name: "x", scopes: ["org:write"] },
            { name: "x", expires_in_days: 0 },
            { name: "x", expires_in_days: 366 },
            { name: "x", extra: 1 },
        ]) {
            expect((await createKey(t.owner, t.publicId, bad)).status, JSON.stringify(bad)).toBe(
                400,
            );
        }
        for (let n = 0; n < 20; n++)
            expect((await createKey(t.owner, t.publicId)).status).toBe(201);
        expect((await createKey(t.owner, t.publicId)).status).toBe(409);
    });
});

describe("using a key", () => {
    it("identifies the key and its organization, with no cookie and no CSRF header", async () => {
        const t = await team();
        const created = await parsedKey(await createKey(t.owner, t.publicId, { name: "reader" }));
        const response = await withKey(created.key);
        expect(response.status).toBe(200);
        const body = keyIntrospectionSchema.parse(await response.json());
        expect(body.org).toMatchObject({
            id: t.publicId,
            slug: expect.stringMatching(/^keys-team-/),
            verification_state: "unverified",
        });
        expect(body.key.id).toBe(created.id);
        const [row] = await h.db.database.sql<
            { last_used_at: Date | null }[]
        >`select last_used_at from api_keys where prefix = ${created.prefix}`;
        expect(row?.last_used_at).not.toBeNull();
    });
});

describe("using a key, refusals", () => {
    it("is not exposed to the CSRF check, yet cannot reach routes meant for people", async () => {
        const t = await team();
        const created = await parsedKey(await createKey(t.owner, t.publicId));
        for (const [method, path] of [
            ["POST", "/orgs"],
            ["GET", "/me"],
            ["GET", "/orgs"],
            ["POST", `/orgs/${t.publicId}/api-keys`],
        ] as const) {
            const response = await withKey(created.key, method, path);
            expect(response.status, `${method} ${path}`).toBe(401);
        }
    });

    it("refuses wrong, malformed, unknown, revoked and expired keys, and ignores a valid cookie beside a bad key", async () => {
        const t = await team();
        const created = await parsedKey(
            await createKey(t.owner, t.publicId, { name: "short", expires_in_days: 1 }),
        );
        const [mark, prefix, secret] = created.key.split("_");
        const tries = [
            `${mark}_${prefix}_${"A".repeat(43)}`,
            `${mark}_${"z".repeat(12)}_${secret}`,
            "aura_short",
            "nonsense",
            `${created.key}x`,
        ];
        for (const key of tries) expect((await withKey(key)).status, key).toBe(401);
        const cookieToo = await h.app(TRUST).request("/api/v1/key", {
            headers: { authorization: "Bearer nonsense", cookie: `aura_session=${t.owner}` },
        });
        expect(cookieToo.status).toBe(401);
        expect((await withKey(created.key)).status).toBe(200);
        h.clock.advance(24 * 60 * MINUTE);
        expect((await withKey(created.key)).status).toBe(401);
    });
});

describe("using a key, revocation", () => {
    it("stops working the moment it is revoked, and revoking twice answers 404", async () => {
        const t = await team();
        const created = await parsedKey(await createKey(t.owner, t.publicId));
        expect((await withKey(created.key)).status).toBe(200);
        const bob = await h.login(BOB);
        const carol = await h.login(CAROL);
        expect(
            (await call(carol.token, "DELETE", `/orgs/${t.publicId}/api-keys/${created.id}`))
                .status,
        ).toBe(403);
        expect(
            (await call(bob.token, "DELETE", `/orgs/${t.publicId}/api-keys/${created.id}`)).status,
        ).toBe(204);
        expect((await withKey(created.key)).status).toBe(401);
        expect(
            (await call(t.owner, "DELETE", `/orgs/${t.publicId}/api-keys/${created.id}`)).status,
        ).toBe(404);
        const other = await team(false);
        expect(
            (await call(other.owner, "DELETE", `/orgs/${other.publicId}/api-keys/${created.id}`))
                .status,
        ).toBe(404);
        expect(
            (await call(t.owner, "DELETE", `/orgs/${t.publicId}/api-keys/not-an-id`)).status,
        ).toBe(400);
    });

    it("sees only its own organization even when another has the same kind of key", async () => {
        const a = await team();
        const keyA = await parsedKey(await createKey(a.owner, a.publicId));
        const b = await team(false);
        const keyB = await parsedKey(await createKey(b.owner, b.publicId));
        expect(keyIntrospectionSchema.parse(await (await withKey(keyA.key)).json()).org.id).toBe(
            a.publicId,
        );
        expect(keyIntrospectionSchema.parse(await (await withKey(keyB.key)).json()).org.id).toBe(
            b.publicId,
        );
    });
});

const passkeyOptions = z.object({
    challenge_id: z.string(),
    options: z.record(z.string(), z.unknown()),
});
const newAuthenticator = () => createVirtualAuthenticator({ origin: ORIGIN, rpId: "localhost" });

async function registerPasskey(token: string, authenticator = newAuthenticator()) {
    const first = passkeyOptions.parse(
        await (await call(token, "POST", "/auth/passkey/register/options", {})).json(),
    );
    const credential = authenticator.register(first.options);
    const done = await call(token, "POST", "/auth/passkey/register/verify", {
        challenge_id: first.challenge_id,
        credential,
    });
    expect(done.status).toBe(201);
    return authenticator;
}

async function stepUp(token: string, authenticator: ReturnType<typeof newAuthenticator>) {
    const options = await call(token, "POST", "/auth/passkey/step-up/options", {});
    expect(options.status).toBe(200);
    const first = passkeyOptions.parse(await options.json());
    const credential = authenticator.assert(first.options);
    return call(token, "POST", "/auth/passkey/step-up/verify", {
        challenge_id: first.challenge_id,
        credential,
    });
}

const problemCode = async (response: Response) =>
    z.object({ code: z.string() }).parse(await response.json()).code;

describe("passkey step-up for privileged actions", () => {
    it("needs a recent passkey check: stale sessions get step_up_required until they step up", async () => {
        const t = await team();
        const authenticator = await registerPasskey(t.owner);
        expect((await createKey(t.owner, t.publicId)).status).toBe(201);
        h.clock.advance(16 * MINUTE);
        const stale = await createKey(t.owner, t.publicId);
        expect(stale.status).toBe(403);
        expect(await problemCode(stale)).toBe("step_up_required");
        expect((await stepUp(t.owner, authenticator)).status).toBe(204);
        expect((await createKey(t.owner, t.publicId)).status).toBe(201);
    });

    it("expires exactly 15 minutes after the check", async () => {
        const t = await team();
        const authenticator = await registerPasskey(t.owner);
        h.clock.advance(15 * MINUTE - 1);
        expect((await createKey(t.owner, t.publicId)).status).toBe(201);
        h.clock.advance(1);
        expect((await createKey(t.owner, t.publicId)).status).toBe(403);
        expect((await stepUp(t.owner, authenticator)).status).toBe(204);
    });
});

describe("passkey step-up, refusals", () => {
    it("cannot be done without a passkey, with someone else's passkey, or twice with one challenge", async () => {
        const t = await team();
        const none = await call(t.owner, "POST", "/auth/passkey/step-up/options", {});
        expect(none.status).toBe(409);
        const mine = await registerPasskey(t.owner);
        const bob = await h.login(BOB);
        const theirs = await registerPasskey(bob.token);
        h.clock.advance(16 * MINUTE);
        const first = passkeyOptions.parse(
            await (await call(t.owner, "POST", "/auth/passkey/step-up/options", {})).json(),
        );
        const wrongKey = theirs.assert(first.options);
        const refused = await call(t.owner, "POST", "/auth/passkey/step-up/verify", {
            challenge_id: first.challenge_id,
            credential: wrongKey,
        });
        expect(refused.status).toBe(400);
        const replay = await call(t.owner, "POST", "/auth/passkey/step-up/verify", {
            challenge_id: first.challenge_id,
            credential: mine.assert(first.options),
        });
        expect(replay.status).toBe(400);
        expect((await createKey(t.owner, t.publicId)).status).toBe(403);
    });

    it("refuses a challenge that was made for someone else, even with one's own passkey", async () => {
        const t = await team();
        const owner = await registerPasskey(t.owner);
        const bob = await h.login(BOB);
        await registerPasskey(bob.token);
        h.clock.advance(16 * MINUTE);
        const bobsChallenge = passkeyOptions.parse(
            await (await call(bob.token, "POST", "/auth/passkey/step-up/options", {})).json(),
        );
        const credential = owner.assert(bobsChallenge.options);
        const response = await call(t.owner, "POST", "/auth/passkey/step-up/verify", {
            challenge_id: bobsChallenge.challenge_id,
            credential,
        });
        expect(response.status).toBe(400);
        expect((await createKey(t.owner, t.publicId)).status).toBe(403);
    });
});

describe("passkey step-up, privileged actions", () => {
    it("applies to role changes and to removing admins or owners, but not to leaving or removing members", async () => {
        const t = await team();
        const authenticator = await registerPasskey(t.owner);
        h.clock.advance(16 * MINUTE);
        const carol = encodeId("usr", CAROL);
        const bob = encodeId("usr", BOB);
        const change = () =>
            call(t.owner, "PATCH", `/orgs/${t.publicId}/members/${carol}`, { role: "admin" });
        expect(await problemCode(await change())).toBe("step_up_required");
        expect(
            await problemCode(await call(t.owner, "DELETE", `/orgs/${t.publicId}/members/${bob}`)),
        ).toBe("step_up_required");
        expect((await call(t.owner, "DELETE", `/orgs/${t.publicId}/members/${carol}`)).status).toBe(
            204,
        );
        expect((await stepUp(t.owner, authenticator)).status).toBe(204);
        expect((await call(t.owner, "DELETE", `/orgs/${t.publicId}/members/${bob}`)).status).toBe(
            204,
        );
    });

    it("ends the sessions of someone who was just given more power, and keeps the others' sessions", async () => {
        const t = await team();
        await registerPasskey(t.owner);
        const carol = await h.login(CAROL);
        const dave = await h.login(DAVE);
        const response = await call(
            t.owner,
            "PATCH",
            `/orgs/${t.publicId}/members/${encodeId("usr", CAROL)}`,
            { role: "admin" },
        );
        expect(response.status).toBe(204);
        expect((await h.request("/me", { headers: browser(carol.token) })).status).toBe(401);
        expect((await h.request("/me", { headers: browser(dave.token) })).status).toBe(200);
        expect((await h.request("/me", { headers: browser(t.owner) })).status).toBe(200);
    });
});

async function passkeyLogin(authenticator: ReturnType<typeof newAuthenticator>) {
    const first = passkeyOptions.parse(
        await (await call(null, "POST", "/auth/passkey/login/options", {})).json(),
    );
    const response = await call(null, "POST", "/auth/passkey/login/verify", {
        challenge_id: first.challenge_id,
        credential: authenticator.assert(first.options),
    });
    expect(response.status).toBe(200);
}

describe("privileged sessions", () => {
    it("start with the stricter idle limit for owners and admins of teams, not for ordinary people", async () => {
        const { sql } = h.db.database;
        const t = await team();
        const owner = await registerPasskey(t.owner);
        await passkeyLogin(owner);
        const ordinary = await h.login(DAVE);
        const dave = await registerPasskey(ordinary.token);
        await passkeyLogin(dave);
        const latest = (userId: string) =>
            sql<
                { privileged: boolean }[]
            >`select privileged from sessions where user_id = ${userId} and auth_method = 'passkey' and ip_network is not null order by created_at desc, id desc limit 1`;
        expect((await latest(ALICE))[0]?.privileged).toBe(true);
        expect((await latest(DAVE))[0]?.privileged).toBe(false);
    });

    it("also bind a session that began before its owner gained power", async () => {
        const t = await team();
        const ordinary = await h.login(DAVE);
        expect((await h.request("/me", { headers: browser(t.owner) })).status).toBe(200);
        h.clock.advance(31 * MINUTE);
        // The owner of a team is held to the 30-minute idle limit even though this session was
        // created as an ordinary one; the other person's session is unaffected.
        expect((await h.request("/me", { headers: browser(t.owner) })).status).toBe(401);
        expect((await h.request("/me", { headers: browser(ordinary.token) })).status).toBe(200);
    });

    it("do not count a personal space, which everyone owns", async () => {
        const { sql } = h.db.database;
        await sql`delete from orgs where id in (select org_id from memberships where user_id = ${CAROL})`;
        const [org] = await sql<
            { id: string }[]
        >`insert into orgs (kind, slug, name) values ('personal', 'p-abcdef0123', 'Personal space') returning id`;
        await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${CAROL}, 'owner')`;
        const carol = await h.login(CAROL);
        await passkeyLogin(await registerPasskey(carol.token));
        const [row] = await sql<
            { privileged: boolean }[]
        >`select privileged from sessions where user_id = ${CAROL} and auth_method = 'passkey' and ip_network is not null order by created_at desc, id desc limit 1`;
        expect(row?.privileged).toBe(false);
    });
});

describe("organization verification", () => {
    it("lets a platform administrator verify an organization, with a fresh passkey check and an audit entry", async () => {
        const t = await team();
        const eve = await h.login(EVE);
        const authenticator = await registerPasskey(eve.token);
        expect((await call(eve.token, "POST", `/admin/orgs/${t.publicId}/verify`)).status).toBe(
            204,
        );
        const mine = await call(t.owner, "GET", `/orgs/${t.publicId}`);
        expect(await mine.json()).toMatchObject({ verification_state: "verified" });
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'admin.org_verified' and org_id = ${t.id}`;
        expect(row?.n).toBe("1");
        h.clock.advance(16 * MINUTE);
        expect(
            await problemCode(await call(eve.token, "POST", `/admin/orgs/${t.publicId}/verify`)),
        ).toBe("step_up_required");
        expect((await stepUp(eve.token, authenticator)).status).toBe(204);
        expect((await call(eve.token, "POST", `/admin/orgs/${t.publicId}/verify`)).status).toBe(
            204,
        );
    });

    it("looks like a missing route to everyone else, and answers 404 for unknown organizations", async () => {
        const t = await team();
        const bob = await h.login(BOB);
        expect((await call(t.owner, "POST", `/admin/orgs/${t.publicId}/verify`)).status).toBe(404);
        expect((await call(bob.token, "POST", `/admin/orgs/${t.publicId}/verify`)).status).toBe(
            404,
        );
        expect((await call(null, "POST", `/admin/orgs/${t.publicId}/verify`)).status).toBe(401);
        const eve = await h.login(EVE);
        expect(
            (
                await call(
                    eve.token,
                    "POST",
                    `/admin/orgs/${encodeId("org", "018f0000-0000-7000-8000-0000000000ee")}/verify`,
                )
            ).status,
        ).toBe(404);
        expect((await call(eve.token, "POST", "/admin/orgs/nope/verify")).status).toBe(400);
        const unverified = await call(t.owner, "GET", `/orgs/${t.publicId}`);
        expect(await unverified.json()).toMatchObject({ verification_state: "unverified" });
    });

    it("keeps the audit chain valid after all of the above", async () => {
        expect((await verifyAuditChain(h.db.database.sql)).ok).toBe(true);
    });
});

describe("changing how people sign in needs a fresh passkey check", () => {
    it("applies to removing a passkey, and the passkey itself can provide the check", async () => {
        const t = await team();
        const authenticator = await registerPasskey(t.owner);
        const list = z
            .object({ items: z.array(z.object({ id: z.string() })) })
            .parse(await (await call(t.owner, "GET", "/me/passkeys")).json());
        const id = list.items[0]?.id ?? "";
        h.clock.advance(16 * MINUTE);
        expect(await problemCode(await call(t.owner, "DELETE", `/me/passkeys/${id}`))).toBe(
            "step_up_required",
        );
        expect((await stepUp(t.owner, authenticator)).status).toBe(204);
        expect((await call(t.owner, "DELETE", `/me/passkeys/${id}`)).status).toBe(204);
    });

    it("applies to disconnecting a provider for someone who holds a passkey, not for someone who has none", async () => {
        const { sql } = h.db.database;
        const t = await team();
        await registerPasskey(t.owner);
        await sql`insert into oauth_identities (user_id, provider, provider_user_id) values (${ALICE}, 'github', 'gh-1')`;
        h.clock.advance(16 * MINUTE);
        expect(await problemCode(await call(t.owner, "DELETE", "/me/identities/github"))).toBe(
            "step_up_required",
        );
        await sql`delete from passkeys where user_id = ${ALICE}`;
        expect((await call(t.owner, "DELETE", "/me/identities/github")).status).toBe(204);
    });
});

describe("platform administrators ending someone's sessions", () => {
    it("ends every session of the person, audits it, and needs a fresh passkey check", async () => {
        const eve = await h.login(EVE);
        const authenticator = await registerPasskey(eve.token);
        const one = await h.login(DAVE);
        const two = await h.login(DAVE);
        const target = encodeId("usr", DAVE);
        const response = await call(eve.token, "POST", `/admin/users/${target}/revoke-sessions`);
        expect(response.status).toBe(200);
        expect(
            z.object({ revoked: z.number() }).parse(await response.json()).revoked,
        ).toBeGreaterThanOrEqual(2);
        for (const token of [one.token, two.token]) {
            expect((await h.request("/me", { headers: browser(token) })).status).toBe(401);
        }
        const [audit] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'admin.sessions_revoked' and actor_user_id = ${EVE}`;
        expect(audit?.n).toBe("1");
        h.clock.advance(16 * MINUTE);
        expect(
            await problemCode(
                await call(eve.token, "POST", `/admin/users/${target}/revoke-sessions`),
            ),
        ).toBe("step_up_required");
        expect((await stepUp(eve.token, authenticator)).status).toBe(204);
        expect(
            (await call(eve.token, "POST", `/admin/users/${target}/revoke-sessions`)).status,
        ).toBe(200);
    });

    it("looks like a missing route to everyone else", async () => {
        const bob = await h.login(BOB);
        const target = encodeId("usr", DAVE);
        expect(
            (await call(bob.token, "POST", `/admin/users/${target}/revoke-sessions`)).status,
        ).toBe(404);
        expect((await call(null, "POST", `/admin/users/${target}/revoke-sessions`)).status).toBe(
            401,
        );
        const eve = await h.login(EVE);
        expect((await call(eve.token, "POST", "/admin/users/nope/revoke-sessions")).status).toBe(
            400,
        );
    });
});

describe("ending sessions asks for a fresh check from people who hold a passkey", () => {
    it("guards ending other devices and everything at once, but not ending this device", async () => {
        const t = await team();
        const authenticator = await registerPasskey(t.owner);
        const other = await h.login(ALICE);
        h.clock.advance(16 * MINUTE);
        const otherId = encodeId("ses", other.session.id);
        for (const [method, path] of [
            ["DELETE", `/me/sessions/${otherId}`],
            ["POST", "/me/sessions/revoke-others"],
            ["POST", "/auth/logout-all"],
        ] as const) {
            expect(await problemCode(await call(t.owner, method, path)), path).toBe(
                "step_up_required",
            );
        }
        expect((await h.request("/me", { headers: browser(other.token) })).status).toBe(200);
        expect((await stepUp(t.owner, authenticator)).status).toBe(204);
        const response = await call(t.owner, "POST", "/me/sessions/revoke-others");
        expect(response.status).toBe(200);
        expect(
            z.object({ revoked: z.number() }).parse(await response.json()).revoked,
        ).toBeGreaterThanOrEqual(1);
        expect((await h.request("/me", { headers: browser(other.token) })).status).toBe(401);
        expect((await h.request("/me", { headers: browser(t.owner) })).status).toBe(200);
    });

    it("lets someone without a passkey do it, and lets anyone end the device they are on", async () => {
        await h.db.database.sql`delete from passkeys where user_id = ${CAROL}`;
        const carol = await h.login(CAROL);
        await h.login(CAROL);
        h.clock.advance(16 * MINUTE);
        expect((await call(carol.token, "POST", "/me/sessions/revoke-others")).status).toBe(200);
        const own = encodeId("ses", carol.session.id);
        expect((await call(carol.token, "DELETE", `/me/sessions/${own}`)).status).toBe(204);
    });
});
