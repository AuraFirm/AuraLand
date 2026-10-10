// Goal: prove sign-in with GitHub and Google end to end through the real HTTP app and PostgreSQL,
// against a fake provider that checks PKCE like the real ones. The core promises: a new identity
// with a provider-verified email creates an account; an email that already belongs to an account
// never links silently (no pre-account takeover); linking needs a signed-in person; the state, the
// cookie and the provider must all match; and refusals leave no session and no link behind.

import { createHash } from "node:crypto";
import { sessionsResponseSchema } from "@aura/contracts/api/identity";
import { identitiesResponseSchema } from "@aura/contracts/api/oauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import {
    type FakeOAuthProvider,
    type FakeProfile,
    startFakeOAuthProvider,
} from "./modules/identity/fake-oauth-provider.ts";
import {
    createGithubProvider,
    createGoogleProvider,
    type ProviderName,
} from "./modules/identity/oauth-providers.ts";

let h: Harness;
let fake: FakeOAuthProvider;
beforeAll(async () => {
    h = await createHarness();
    fake = await startFakeOAuthProvider();
});
afterAll(async () => {
    await fake.close();
    await h.drop();
});

const TRUST = { AURA_TRUST_EDGE_REQUEST_ID: "true" };
const credentials = { clientId: "cid", clientSecret: "csecret" };
const providers = () =>
    new Map([
        ["github" as const, createGithubProvider(credentials, fake.endpoints)],
        ["google" as const, createGoogleProvider(credentials, fake.endpoints)],
    ]);
let addressCounter = 0;
const freshAddress = () => `192.0.2.${++addressCounter}`;
let idCounter = 1000;
const profileOf = (email: string | null, verified = true): FakeProfile => ({
    id: String(++idCounter),
    email,
    emailVerified: verified,
});

const app = (extra: { map?: ReturnType<typeof providers> } = {}) =>
    h.app(TRUST, undefined, extra.map ?? providers());

function call(path: string, init: RequestInit & { headers: Record<string, string> }) {
    return Promise.resolve(app().request(`/api/v1${path}`, init));
}

interface Started {
    readonly state: string;
    readonly challenge: string;
    readonly cookie: string;
    readonly url: URL;
}

async function start(
    provider: string,
    token: string | null = null,
    purpose?: "link",
    address = freshAddress(),
) {
    const response = await call(`/auth/oauth/${provider}/start`, {
        method: "POST",
        headers: browser(token, { "content-type": "application/json", "x-forwarded-for": address }),
        body: JSON.stringify(purpose === undefined ? {} : { purpose }),
    });
    return response;
}

async function begin(
    provider: string,
    token: string | null = null,
    purpose?: "link",
): Promise<Started> {
    const response = await start(provider, token, purpose);
    expect(response.status).toBe(200);
    const url = new URL(
        z.object({ authorization_url: z.string() }).parse(await response.json()).authorization_url,
    );
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("aura_oauth=")) ?? "";
    return {
        url,
        state: url.searchParams.get("state") ?? "",
        challenge: url.searchParams.get("code_challenge") ?? "",
        cookie: cookie.split(";")[0] ?? "",
    };
}

function callback(
    provider: string,
    query: Record<string, string>,
    cookies: string[],
    address = freshAddress(),
) {
    return call(`/auth/oauth/${provider}/callback?${new URLSearchParams(query).toString()}`, {
        method: "GET",
        headers: { cookie: cookies.join("; "), "x-forwarded-for": address },
    });
}

// Runs a whole sign-in: start, approve at the provider, come back.
async function signInAs(
    provider: ProviderName,
    profile: FakeProfile,
    token: string | null = null,
    purpose?: "link",
) {
    const started = await begin(provider, token, purpose);
    const code = fake.authorize(profile, started.challenge);
    const cookies = [started.cookie, ...(token === null ? [] : [`aura_session=${token}`])];
    return callback(provider, { code, state: started.state }, cookies);
}

const location = (response: Response) => response.headers.get("location") ?? "";
const sessionOf = (response: Response) =>
    response.headers
        .getSetCookie()
        .find((c) => c.startsWith("aura_session="))
        ?.split(";")[0]
        ?.split("=")[1] ?? "";
const done = (status: string, reason?: string) =>
    `${ORIGIN}/auth/done?status=${status}${reason === undefined ? "" : `&reason=${reason}`}`;
const countRows = async (query: Promise<Array<Record<string, unknown>>>) =>
    Number((await query)[0]?.["n"]);

describe("starting", () => {
    it("builds the provider URL with state, S256 PKCE and our fixed redirect, and sets the verifier cookie", async () => {
        const started = await begin("github");
        expect(started.url.searchParams.get("redirect_uri")).toBe(
            `${ORIGIN}/api/v1/auth/oauth/github/callback`,
        );
        expect(started.url.searchParams.get("client_id")).toBe("cid");
        expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const verifier = started.cookie.split("=")[1] ?? "";
        expect(createHash("sha256").update(verifier).digest("base64url")).toBe(started.challenge);
        expect(started.url.toString()).not.toContain(verifier);
    });

    it("answers 404 for a provider that is not configured or does not exist", async () => {
        const onlyGithub = h.app(
            TRUST,
            undefined,
            new Map([["github" as const, createGithubProvider(credentials, fake.endpoints)]]),
        );
        const headers = browser(null, {
            "content-type": "application/json",
            "x-forwarded-for": freshAddress(),
        });
        const missing = await onlyGithub.request("/api/v1/auth/oauth/google/start", {
            method: "POST",
            headers,
            body: "{}",
        });
        expect(missing.status).toBe(404);
        expect((await start("facebook")).status).toBe(404);
    });

    it("needs a signed-in person to link, refuses unknown fields, and needs the CSRF header", async () => {
        expect((await start("github", null, "link")).status).toBe(401);
        const headers = browser(null, {
            "content-type": "application/json",
            "x-forwarded-for": freshAddress(),
        });
        const extra = await call("/auth/oauth/github/start", {
            method: "POST",
            headers,
            body: '{"purpose":"login","x":1}',
        });
        expect(extra.status).toBe(400);
        delete headers["x-aura-request"];
        expect(
            (await call("/auth/oauth/github/start", { method: "POST", headers, body: "{}" }))
                .status,
        ).toBe(403);
    });
});

describe.each(["github", "google"] as const)("signing in with %s", (provider) => {
    it("creates an account from a verified email and starts a session for that provider", async () => {
        const email = `new-${provider}@example.com`;
        const response = await signInAs(provider, profileOf(email));
        expect(response.status).toBe(302);
        expect(location(response)).toBe(done("signed_in"));
        const token = sessionOf(response);
        const me = await h.request("/me", { headers: browser(token) });
        expect(await me.json()).toMatchObject({ email, email_verified: true });
        const sessions = sessionsResponseSchema.parse(
            await (await h.request("/me/sessions", { headers: browser(token) })).json(),
        );
        expect(sessions.items.find((item) => item.current)?.auth_method).toBe(provider);
        const cookies = response.headers.getSetCookie();
        expect(cookies.some((c) => c.startsWith("aura_oauth=;") && c.includes("Max-Age=0"))).toBe(
            true,
        );
    });

    it("signs the same person back in by provider id, even after their email changed", async () => {
        const profile = profileOf(`first-${provider}@example.com`);
        const first = await signInAs(provider, profile);
        const second = await signInAs(provider, {
            ...profile,
            email: `moved-${provider}@example.com`,
        });
        expect(location(second)).toBe(done("signed_in"));
        const a = await (await h.request("/me", { headers: browser(sessionOf(first)) })).json();
        const b = await (await h.request("/me", { headers: browser(sessionOf(second)) })).json();
        expect(b).toEqual(a);
    });
});

describe("refusals that protect existing accounts", () => {
    it("never links an email that already has an account, creating no session and no link", async () => {
        const before = await countRows(h.db.database.sql`select count(*) n from oauth_identities`);
        const response = await signInAs("github", profileOf("alice@example.com"));
        expect(location(response)).toBe(done("failed", "account_exists"));
        expect(sessionOf(response)).toBe("");
        expect(await countRows(h.db.database.sql`select count(*) n from oauth_identities`)).toBe(
            before,
        );
    });

    it("does not touch an existing account when its email shows up at a provider", async () => {
        await h.db.database.sql`insert into users (email) values ('untouched@example.com')`;
        const response = await signInAs("google", profileOf("untouched@example.com"));
        expect(location(response)).toBe(done("failed", "account_exists"));
        const [row] = await h.db.database.sql<
            { email_verified_at: Date | null }[]
        >`select email_verified_at from users where email = 'untouched@example.com'`;
        expect(row?.email_verified_at).toBeNull();
    });

    it("refuses an email the provider has not verified, or no email at all", async () => {
        const unverified = await signInAs("github", profileOf("victim@example.com", false));
        expect(location(unverified)).toBe(done("failed", "email_unverified"));
        const none = await signInAs("google", profileOf(null, false));
        expect(location(none)).toBe(done("failed", "email_unverified"));
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from users where email = 'victim@example.com'`;
        expect(row?.n).toBe("0");
    });

    it("refuses a suspended person's linked identity", async () => {
        const profile = profileOf("suspendme@example.com");
        await signInAs("github", profile);
        await h.db.database
            .sql`update users set status = 'suspended' where email = 'suspendme@example.com'`;
        const response = await signInAs("github", profile);
        expect(location(response)).toBe(done("failed", "suspended"));
        expect(sessionOf(response)).toBe("");
    });

    it("audits refusals without any personal data", async () => {
        const rows = await h.db.database.sql<
            { detail: unknown }[]
        >`select detail from audit_log where action = 'auth.oauth_refused'`;
        expect(rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(rows)).not.toContain("@");
    });
});

describe("the callback checks state, cookie and provider", () => {
    it("refuses a missing cookie, another flow's cookie, a wrong state and a wrong provider", async () => {
        const mine = await begin("github");
        const other = await begin("github");
        const code = () => fake.authorize(profileOf("tamper@example.com"), mine.challenge);
        const cases: Array<[string, string, Record<string, string>, string[]]> = [
            ["github", "no cookie", { code: code(), state: mine.state }, []],
            ["github", "other cookie", { code: code(), state: mine.state }, [other.cookie]],
            ["github", "wrong state", { code: code(), state: other.state }, [mine.cookie]],
            ["google", "wrong provider", { code: code(), state: mine.state }, [mine.cookie]],
            ["github", "junk state", { code: code(), state: "x" }, [mine.cookie]],
            ["github", "no code", { state: mine.state }, [mine.cookie]],
        ];
        for (const [provider, name, query, cookies] of cases) {
            const response = await callback(provider, query, cookies);
            expect(location(response), name).toBe(done("failed", "invalid"));
            expect(sessionOf(response), name).toBe("");
        }
        // None of those spent the real flow.
        const ok = await callback("github", { code: code(), state: mine.state }, [mine.cookie]);
        expect(location(ok)).toBe(done("signed_in"));
    });

    it("spends the flow: a second use of the same state fails", async () => {
        const started = await begin("github");
        const profile = profileOf("once@example.com");
        const query = () => ({
            code: fake.authorize(profile, started.challenge),
            state: started.state,
        });
        expect(location(await callback("github", query(), [started.cookie]))).toBe(
            done("signed_in"),
        );
        expect(location(await callback("github", query(), [started.cookie]))).toBe(
            done("failed", "invalid"),
        );
    });

    it("refuses an expired flow", async () => {
        const started = await begin("github");
        const code = fake.authorize(profileOf("late@example.com"), started.challenge);
        h.clock.advance(10 * 60 * 1000);
        const response = await callback("github", { code, state: started.state }, [started.cookie]);
        expect(location(response)).toBe(done("failed", "invalid"));
    });
});

describe("the callback and the provider", () => {
    it("reports denial, a rejected code and a provider outage as distinct, harmless failures", async () => {
        const denied = await begin("github");
        const deniedResponse = await callback(
            "github",
            { error: "access_denied", state: denied.state },
            [denied.cookie],
        );
        expect(location(deniedResponse)).toBe(done("failed", "denied"));
        const rejected = await begin("github");
        const bad = await callback("github", { code: "never-issued", state: rejected.state }, [
            rejected.cookie,
        ]);
        expect(location(bad)).toBe(done("failed", "invalid"));
        const outage = await begin("google");
        fake.failNextWith(503);
        const down = await callback("google", { code: "c", state: outage.state }, [outage.cookie]);
        expect(location(down)).toBe(done("failed", "unavailable"));
    });

    it("rejects a code issued for a different PKCE challenge", async () => {
        const started = await begin("github");
        const code = fake.authorize(profileOf("pkce@example.com"), "A".repeat(43));
        const response = await callback("github", { code, state: started.state }, [started.cookie]);
        expect(location(response)).toBe(done("failed", "invalid"));
    });
});

describe("linking a provider to a signed-in person", () => {
    it("attaches the identity to the person, and sign-in with it then reaches the same account", async () => {
        const { token } = await h.login(ALICE);
        const profile = profileOf("alice-work@example.com");
        const linked = await signInAs("github", profile, token, "link");
        expect(location(linked)).toBe(done("linked"));
        expect(sessionOf(linked)).toBe("");
        const list = identitiesResponseSchema.parse(
            await (await h.request("/me/identities", { headers: browser(token) })).json(),
        );
        expect(list.items.map((item) => item.provider)).toEqual(["github"]);
        expect(JSON.stringify(list)).not.toContain(profile.id);
        const again = await signInAs("github", profile);
        const me = await (await h.request("/me", { headers: browser(sessionOf(again)) })).json();
        expect(me).toMatchObject({ email: "alice@example.com" });
    });

    it("needs the same person signed in when the flow ends, and refuses identities owned by others", async () => {
        const alice = await h.login(ALICE);
        const bob = await h.login(BOB);
        const started = await begin("google", alice.token, "link");
        const code = fake.authorize(profileOf("x@example.com"), started.challenge);
        const stranger = await callback("google", { code, state: started.state }, [
            started.cookie,
            `aura_session=${bob.token}`,
        ]);
        expect(location(stranger)).toBe(done("failed", "invalid"));
        const taken = profileOf("shared@example.com");
        expect(location(await signInAs("google", taken, bob.token, "link"))).toBe(done("linked"));
        expect(location(await signInAs("google", taken, alice.token, "link"))).toBe(
            done("failed", "identity_taken"),
        );
        expect(
            location(await signInAs("google", profileOf("second@example.com"), bob.token, "link")),
        ).toBe(done("failed", "identity_taken"));
    });

    it("unlinks only one's own identity and audits it", async () => {
        const alice = await h.login(ALICE);
        const bob = await h.login(BOB);
        const headers = (token: string) => browser(token);
        const remove = (token: string) =>
            h.request("/me/identities/github", { method: "DELETE", headers: headers(token) });
        expect((await remove(bob.token)).status).toBe(404);
        expect((await remove(alice.token)).status).toBe(204);
        expect((await remove(alice.token)).status).toBe(404);
        expect(
            (
                await h.request("/me/identities/facebook", {
                    method: "DELETE",
                    headers: headers(alice.token),
                })
            ).status,
        ).toBe(400);
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'auth.identity_unlinked' and actor_user_id = ${ALICE}`;
        expect(row?.n).toBe("1");
        expect((await h.request("/me/identities", { headers: {} })).status).toBe(401);
    });
});

describe("sessions and limits", () => {
    it("ends the session the browser already had when someone signs in with a provider", async () => {
        const old = await h.login(ALICE);
        const response = await signInAs("google", profileOf("fresh-start@example.com"), old.token);
        expect(location(response)).toBe(done("signed_in"));
        expect((await h.request("/me", { headers: browser(old.token) })).status).toBe(401);
    });

    it("limits start and callback per address: the 11th request in a minute gets 429", async () => {
        const address = freshAddress();
        for (let n = 0; n < 10; n++)
            expect((await start("github", null, undefined, address)).status).toBe(200);
        const refused = await start("github", null, undefined, address);
        expect(refused.status).toBe(429);
        expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        const callbackAddress = freshAddress();
        for (let n = 0; n < 10; n++) await callback("github", {}, [], callbackAddress);
        expect((await callback("github", {}, [], callbackAddress)).status).toBe(429);
    });
});
