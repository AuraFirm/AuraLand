// Goal: prove passkey registration and sign-in end to end through the real HTTP app and PostgreSQL,
// using a software authenticator that signs like a real one. Covers the happy paths, and each way a
// ceremony can be attacked or go wrong: replayed or expired challenges, another person's challenge,
// wrong origin or relying-party id, missing user verification, a counter that goes backwards, a
// credential presented with someone else's signature, suspended accounts, and limits.

import { sessionsResponseSchema } from "@aura/contracts/api/identity";
import { passkeysResponseSchema } from "@aura/contracts/api/passkeys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import {
    createVirtualAuthenticator,
    type VirtualAuthenticator,
} from "./modules/identity/virtual-authenticator.ts";

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
});
afterAll(async () => {
    await h.drop();
});

const TRUST = { AURA_TRUST_EDGE_REQUEST_ID: "true" };
let addressCounter = 0;
const freshAddress = () => `203.0.113.${++addressCounter}`;
const newAuthenticator = () => createVirtualAuthenticator({ origin: ORIGIN, rpId: "localhost" });

function post(path: string, body: unknown, token: string | null = null, address = freshAddress()) {
    return Promise.resolve(
        h.app(TRUST).request(`/api/v1${path}`, {
            method: "POST",
            headers: browser(token, {
                "content-type": "application/json",
                "x-forwarded-for": address,
            }),
            body: JSON.stringify(body),
        }),
    );
}

const issuedSchema = z.object({
    challenge_id: z.string(),
    options: z.record(z.string(), z.unknown()),
});
type Issued = z.infer<typeof issuedSchema>;
const issued = async (response: Response): Promise<Issued> => {
    expect(response.status).toBe(200);
    return issuedSchema.parse(await response.json());
};
const idOf = async (response: Response) =>
    z.object({ id: z.string() }).parse(await response.json()).id;

async function registerWith(token: string, authenticator: VirtualAuthenticator, name?: string) {
    const first = await issued(await post("/auth/passkey/register/options", {}, token));
    const credential = authenticator.register(first.options);
    return post(
        "/auth/passkey/register/verify",
        { challenge_id: first.challenge_id, credential, ...(name === undefined ? {} : { name }) },
        token,
    );
}

async function loginWith(
    authenticator: VirtualAuthenticator,
    behavior = {},
    token: string | null = null,
) {
    const first = await issued(await post("/auth/passkey/login/options", {}, token));
    const credential = authenticator.assert(first.options, behavior);
    return post(
        "/auth/passkey/login/verify",
        { challenge_id: first.challenge_id, credential },
        token,
    );
}

const sessionToken = (response: Response) =>
    response.headers
        .getSetCookie()
        .find((c) => c.startsWith("aura_session="))
        ?.split(";")[0]
        ?.split("=")[1] ?? "";

describe("registration", () => {
    it("issues options that require user verification, no attestation, and have an opaque user handle", async () => {
        const { token } = await h.login(ALICE);
        const { options } = await issued(await post("/auth/passkey/register/options", {}, token));
        expect(options["attestation"]).toBe("none");
        expect(options["authenticatorSelection"]).toMatchObject({
            userVerification: "required",
            residentKey: "preferred",
        });
        expect(options["rp"]).toMatchObject({ id: "localhost", name: "AuraLand" });
        expect(String(options["challenge"])).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // The stored user handle is the opaque account id, not anything personal.
        const user = options["user"];
        const handle =
            typeof user === "object" && user !== null && "id" in user ? String(user.id) : "";
        expect(Buffer.from(handle, "base64url").toString("hex")).toBe(ALICE.replaceAll("-", ""));
    });

    it("stores a passkey, lists it without key material and audits it", async () => {
        const { token } = await h.login(ALICE);
        const response = await registerWith(token, newAuthenticator(), "Work laptop");
        expect(response.status).toBe(201);
        const list = await h.request("/me/passkeys", { headers: browser(token) });
        const body = passkeysResponseSchema.parse(await list.json());
        expect(
            body.items.some(
                (item) => item.name === "Work laptop" && item.transports[0] === "internal",
            ),
        ).toBe(true);
        expect(JSON.stringify(body)).not.toMatch(/public|counter|credential/i);
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'auth.passkey_added' and actor_user_id = ${ALICE}`;
        expect(Number(row?.n)).toBeGreaterThanOrEqual(1);
    });

    it("keeps only the transports we know and ignores the rest", async () => {
        const { token } = await h.login(ALICE);
        const first = await issued(await post("/auth/passkey/register/options", {}, token));
        const credential = newAuthenticator().register(first.options);
        const response = z.record(z.string(), z.unknown()).parse(credential["response"]);
        const odd = { ...credential, response: { ...response, transports: ["usb", "telepathy"] } };
        const created = await post(
            "/auth/passkey/register/verify",
            { challenge_id: first.challenge_id, credential: odd },
            token,
        );
        expect(created.status).toBe(201);
        const id = (await idOf(created)).slice("pky_".length);
        const [row] = await h.db.database.sql<
            { transports: string[] }[]
        >`select transports from passkeys where id = ${id}`;
        expect(row?.transports).toEqual(["usb"]);
    });

    it("needs a signed-in person", async () => {
        expect((await post("/auth/passkey/register/options", {})).status).toBe(401);
        expect((await post("/auth/passkey/register/verify", {})).status).toBe(401);
    });

    it("refuses to register the same credential twice, even if the client ignores the exclude list", async () => {
        const { token } = await h.login(BOB);
        const authenticator = newAuthenticator();
        expect((await registerWith(token, authenticator)).status).toBe(201);
        expect((await registerWith(token, authenticator)).status).toBe(400);
        const other = await h.login(ALICE);
        expect((await registerWith(other.token, authenticator)).status).toBe(400);
    });
});

describe("registration refusals", () => {
    const attempt = async (
        tamper: (first: Issued, a: VirtualAuthenticator) => { credential: unknown; id?: string },
    ) => {
        const { token } = await h.login(ALICE);
        const first = await issued(await post("/auth/passkey/register/options", {}, token));
        const { credential, id } = tamper(first, newAuthenticator());
        return post(
            "/auth/passkey/register/verify",
            { challenge_id: id ?? first.challenge_id, credential },
            token,
        );
    };

    it("refuses a wrong origin, wrong relying-party id, missing user verification and wrong challenge", async () => {
        for (const behavior of [
            { origin: "https://evil.example" },
            { rpId: "evil.example" },
            { userVerified: false },
            { challenge: "A".repeat(43) },
        ]) {
            const response = await attempt((first, a) => ({
                credential: a.register(first.options, behavior),
            }));
            expect(response.status, JSON.stringify(behavior)).toBe(400);
        }
    });

    it("spends the challenge: a second answer fails, and a late answer fails", async () => {
        const { token } = await h.login(ALICE);
        const first = await issued(await post("/auth/passkey/register/options", {}, token));
        const credential = newAuthenticator().register(first.options);
        const answer = () =>
            post(
                "/auth/passkey/register/verify",
                { challenge_id: first.challenge_id, credential },
                token,
            );
        expect((await answer()).status).toBe(201);
        expect((await answer()).status).toBe(400);
        const late = await issued(await post("/auth/passkey/register/options", {}, token));
        const lateCredential = newAuthenticator().register(late.options);
        h.clock.advance(5 * 60 * 1000);
        expect(
            (
                await post(
                    "/auth/passkey/register/verify",
                    { challenge_id: late.challenge_id, credential: lateCredential },
                    token,
                )
            ).status,
        ).toBe(400);
    });
});

describe("registration refusals, continued", () => {
    it("does not let another person finish someone else's registration", async () => {
        const alice = await h.login(ALICE);
        const bob = await h.login(BOB);
        const first = await issued(await post("/auth/passkey/register/options", {}, alice.token));
        const credential = newAuthenticator().register(first.options);
        const response = await post(
            "/auth/passkey/register/verify",
            { challenge_id: first.challenge_id, credential },
            bob.token,
        );
        expect(response.status).toBe(400);
    });

    it("refuses malformed bodies and unknown fields", async () => {
        const { token } = await h.login(ALICE);
        for (const body of [
            {},
            { challenge_id: "nope", credential: {} },
            { challenge_id: crypto.randomUUID(), credential: {}, extra: 1 },
        ]) {
            expect((await post("/auth/passkey/register/verify", body, token)).status).toBe(400);
        }
    });
});

async function personWithPasskey(userId: string) {
    const { token } = await h.login(userId);
    const authenticator = newAuthenticator();
    expect((await registerWith(token, authenticator)).status).toBe(201);
    return authenticator;
}

describe("sign in with a passkey", () => {
    it("starts a passkey session, records the use, and the session works", async () => {
        const authenticator = await personWithPasskey(ALICE);
        const response = await loginWith(authenticator);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "signed_in" });
        const token = sessionToken(response);
        const me = await h.request("/me", { headers: browser(token) });
        expect(me.status).toBe(200);
        const sessions = await h.request("/me/sessions", { headers: browser(token) });
        const { items } = sessionsResponseSchema.parse(await sessions.json());
        expect(items.find((item) => item.current)?.auth_method).toBe("passkey");
        const [row] = await h.db.database.sql<
            { counter: string; last_used_at: Date | null }[]
        >`select counter, last_used_at from passkeys where credential_id = ${Buffer.from(authenticator.credentialId, "base64url")}`;
        expect(row?.counter).toBe("1");
        expect(row?.last_used_at).not.toBeNull();
    });

    it("ends the session the browser already had", async () => {
        const authenticator = await personWithPasskey(ALICE);
        const old = await h.login(ALICE);
        const response = await loginWith(authenticator, {}, old.token);
        expect(response.status).toBe(200);
        expect((await h.request("/me", { headers: browser(old.token) })).status).toBe(401);
    });

    it("answers options the same way for everyone, with no account named", async () => {
        const first = await issued(await post("/auth/passkey/login/options", {}));
        expect(first.options["allowCredentials"] ?? []).toEqual([]);
        expect(first.options["userVerification"]).toBe("required");
    });
});

describe("sign in with a passkey, continued", () => {
    it("works only once per challenge and refuses a replayed assertion", async () => {
        const authenticator = await personWithPasskey(ALICE);
        const first = await issued(await post("/auth/passkey/login/options", {}));
        const credential = authenticator.assert(first.options);
        const answer = () =>
            post("/auth/passkey/login/verify", { challenge_id: first.challenge_id, credential });
        expect((await answer()).status).toBe(200);
        expect((await answer()).status).toBe(400);
    });

    it("refuses an expired challenge and a challenge made for registration", async () => {
        const authenticator = await personWithPasskey(ALICE);
        const stale = await issued(await post("/auth/passkey/login/options", {}));
        const credential = authenticator.assert(stale.options);
        h.clock.advance(5 * 60 * 1000);
        expect(
            (
                await post("/auth/passkey/login/verify", {
                    challenge_id: stale.challenge_id,
                    credential,
                })
            ).status,
        ).toBe(400);
        const { token } = await h.login(ALICE);
        const registration = await issued(await post("/auth/passkey/register/options", {}, token));
        const answer = authenticator.assert(registration.options);
        expect(
            (
                await post("/auth/passkey/login/verify", {
                    challenge_id: registration.challenge_id,
                    credential: answer,
                })
            ).status,
        ).toBe(400);
    });
});

describe("sign in refusals", () => {
    it("refuses wrong origin, wrong relying-party id, no user verification and wrong challenge", async () => {
        const authenticator = await personWithPasskey(ALICE);
        for (const behavior of [
            { origin: "https://evil.example" },
            { rpId: "evil.example" },
            { userVerified: false },
            { challenge: "A".repeat(43) },
        ]) {
            const response = await loginWith(authenticator, behavior);
            expect(response.status, JSON.stringify(behavior)).toBe(400);
            expect(response.headers.getSetCookie().some((c) => c.startsWith("aura_session="))).toBe(
                false,
            );
        }
    });

    it("refuses a counter that goes backwards but accepts a counter that stays at zero", async () => {
        const authenticator = await personWithPasskey(ALICE);
        expect((await loginWith(authenticator, { counter: 7 })).status).toBe(200);
        expect((await loginWith(authenticator, { counter: 7 })).status).toBe(400);
        expect((await loginWith(authenticator, { counter: 3 })).status).toBe(400);
        expect((await loginWith(authenticator, { counter: 8 })).status).toBe(200);
        const flat = await personWithPasskey(BOB);
        expect((await loginWith(flat, { counter: 0 })).status).toBe(200);
        expect((await loginWith(flat, { counter: 0 })).status).toBe(200);
    });
});

describe("sign in refusals, continued", () => {
    it("refuses an unknown credential and a signature from a different key", async () => {
        const known = await personWithPasskey(ALICE);
        const stranger = newAuthenticator();
        const first = await issued(await post("/auth/passkey/login/options", {}));
        const strangerAnswer = stranger.assert(first.options);
        expect(
            (
                await post("/auth/passkey/login/verify", {
                    challenge_id: first.challenge_id,
                    credential: strangerAnswer,
                })
            ).status,
        ).toBe(400);
        const second = await issued(await post("/auth/passkey/login/options", {}));
        const forged = {
            ...stranger.assert(second.options),
            id: known.credentialId,
            rawId: known.credentialId,
        };
        expect(
            (
                await post("/auth/passkey/login/verify", {
                    challenge_id: second.challenge_id,
                    credential: forged,
                })
            ).status,
        ).toBe(400);
    });

    it("refuses a user handle that names someone else, and a suspended person", async () => {
        const authenticator = await personWithPasskey(ALICE);
        const bobHandle = Buffer.from(BOB.replaceAll("-", ""), "hex").toString("base64url");
        expect((await loginWith(authenticator, { userHandle: bobHandle })).status).toBe(400);
        await h.db.database.sql`update users set status = 'suspended' where id = ${ALICE}`;
        const refused = await loginWith(authenticator);
        expect(refused.status).toBe(400);
        expect(sessionToken(refused)).toBe("");
        await h.db.database.sql`update users set status = 'active' where id = ${ALICE}`;
    });

    it("refuses malformed bodies", async () => {
        for (const body of [
            {},
            { challenge_id: "x", credential: {} },
            { challenge_id: crypto.randomUUID(), credential: { id: "a" } },
        ]) {
            expect((await post("/auth/passkey/login/verify", body)).status).toBe(400);
        }
    });
});

describe("managing passkeys", () => {
    it("lets the owner rename and delete, audits the removal, and hides them from others", async () => {
        const alice = await h.login(ALICE);
        const bob = await h.login(BOB);
        const created = {
            id: await idOf(await registerWith(alice.token, newAuthenticator(), "Old name")),
        };
        const headers = (token: string) => browser(token, { "content-type": "application/json" });
        const patch = (token: string) =>
            h.request(`/me/passkeys/${created.id}`, {
                method: "PATCH",
                headers: headers(token),
                body: JSON.stringify({ name: "New name" }),
            });
        expect((await patch(bob.token)).status).toBe(404);
        expect((await patch(alice.token)).status).toBe(204);
        const listed = passkeysResponseSchema.parse(
            await (await h.request("/me/passkeys", { headers: browser(alice.token) })).json(),
        );
        expect(listed.items.find((item) => item.id === created.id)?.name).toBe("New name");
        const remove = (token: string) =>
            h.request(`/me/passkeys/${created.id}`, { method: "DELETE", headers: browser(token) });
        expect((await remove(bob.token)).status).toBe(404);
        expect((await remove(alice.token)).status).toBe(204);
        expect((await remove(alice.token)).status).toBe(404);
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'auth.passkey_removed' and target = ${created.id}`;
        expect(row?.n).toBe("1");
    });

    it("refuses malformed ids and names", async () => {
        const { token } = await h.login(ALICE);
        const headers = browser(token, { "content-type": "application/json" });
        expect(
            (await h.request("/me/passkeys/not-an-id", { method: "DELETE", headers })).status,
        ).toBe(400);
        const id = `pky_${crypto.randomUUID()}`;
        expect(
            (
                await h.request(`/me/passkeys/${id}`, {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify({ name: "" }),
                })
            ).status,
        ).toBe(400);
    });
});

describe("limits", () => {
    it("allows 20 passkeys and refuses options for the 21st with 409", async () => {
        const { token } = await h.login(BOB);
        const [have] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from passkeys where user_id = ${BOB}`;
        for (let n = Number(have?.n); n < 20; n++)
            expect((await registerWith(token, newAuthenticator())).status).toBe(201);
        expect((await post("/auth/passkey/register/options", {}, token)).status).toBe(409);
    });

    it("limits passkey sign-in attempts per address: the 31st in a minute gets 429", async () => {
        const address = freshAddress();
        for (let n = 0; n < 30; n++)
            expect((await post("/auth/passkey/login/options", {}, null, address)).status).toBe(200);
        const refused = await post("/auth/passkey/login/options", {}, null, address);
        expect(refused.status).toBe(429);
        expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    });
});
