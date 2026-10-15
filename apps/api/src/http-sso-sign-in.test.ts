// Goal: signing in through an organization's identity provider, end to end through the real HTTP app and PostgreSQL, against a fake
// provider that mints real signed id_tokens. The promises: a person is recognised by (organization, subject) and not by email; an
// existing account is attached only when the verified email is in a domain the organization proved it controls; a new account
// joins as a member only if the plan has room, and a full organization leaves no stray account; every check on the token and on
// the flow (state, cookie, nonce, signature, expiry, one use) refuses without a session; and when an organization requires SSO,
// no other way in works for its people, except for its owners.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import { createFakeIdp, type FakeIdp, type IdTokenClaims } from "./modules/sso/fake-idp.ts";

const REDIRECT = `${ORIGIN}/api/v1/auth/sso/callback`;
let h: Harness;
let idp: FakeIdp;
let org = "";
let orgPublic = "";
let addressCounter = 0;
let subjectCounter = 0;
const TRUST = { AURA_TRUST_EDGE_REQUEST_ID: "true" };
const address = () => `203.0.113.${++addressCounter}`;

beforeAll(async () => {
    h = await createHarness();
    idp = await createFakeIdp();
    idp.now = () => h.clock.nowUnixMs();
    const { sql } = h.db.database;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'acme', 'Acme') returning id`;
    org = o?.id ?? "";
    orgPublic = `org_${org}`;
    await sql`insert into memberships (org_id, user_id, role) values (${org}, ${ALICE}, 'owner')`;
    await sql`insert into customers (org_id, plan, updated_by, updated_at) values (${org}, 'enterprise', ${ALICE}, now())`;
    await sql`insert into sso_connections (org_id, issuer, client_id, client_secret, authorization_endpoint, token_endpoint, jwks_uri, created_by, updated_at)
        values (${org}, ${idp.issuer}, ${idp.clientId}, 'secret', ${idp.discovery.authorizationEndpoint}, ${idp.discovery.tokenEndpoint}, ${idp.discovery.jwksUri}, ${ALICE}, now())`;
    await sql`insert into sso_domains (org_id, domain, token, created_at, verified_at) values (${org}, 'acme.example', ${"a".repeat(32)}, now(), now())`;
});
afterAll(async () => {
    await h.drop();
});

const app = () => h.app(TRUST, undefined, undefined, undefined, undefined, { oidcTransport: idp });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    Promise.resolve(
        app().request(`/api/v1${path}`, {
            method: "POST",
            headers: browser(null, {
                "content-type": "application/json",
                "x-forwarded-for": address(),
                ...headers,
            }),
            body: JSON.stringify(body),
        }),
    );

interface Started {
    url: URL;
    state: string;
    nonce: string;
    cookie: string;
}
async function start(email: string): Promise<Started> {
    const response = await post("/auth/sso/start", { email });
    expect(response.status).toBe(200);
    const url = new URL(
        z.object({ authorization_url: z.string() }).parse(await response.json()).authorization_url,
    );
    const cookie =
        (response.headers.getSetCookie().find((c) => c.startsWith("aura_oauth=")) ?? "").split(
            ";",
        )[0] ?? "";
    return {
        url,
        state: url.searchParams.get("state") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        cookie,
    };
}
const callback = (query: Record<string, string>, cookies: string[]) =>
    Promise.resolve(
        app().request(`/api/v1/auth/sso/callback?${new URLSearchParams(query).toString()}`, {
            method: "GET",
            headers: { cookie: cookies.join("; "), "x-forwarded-for": address() },
        }),
    );

// A whole sign-in: start, the provider signs a token for the nonce it was given, come back.
async function signIn(
    email: string,
    over: IdTokenClaims = {},
    options: Parameters<FakeIdp["mint"]>[1] = {},
) {
    const started = await start(email);
    const code = `code-${++subjectCounter}`;
    idp.codes.set(
        code,
        await idp.mint(
            {
                sub: over.sub ?? `sub-${subjectCounter}`,
                email,
                email_verified: true,
                nonce: started.nonce,
                ...over,
            },
            options,
        ),
    );
    return {
        started,
        code,
        response: await callback({ code, state: started.state }, [started.cookie]),
    };
}
const location = (r: Response) => r.headers.get("location") ?? "";
const done = (status: string, reason?: string) =>
    `${ORIGIN}/auth/done?status=${status}${reason === undefined ? "" : `&reason=${reason}`}`;
const sessionOf = (r: Response) =>
    r.headers
        .getSetCookie()
        .find((c) => c.startsWith("aura_session="))
        ?.split(";")[0]
        ?.split("=")[1] ?? "";
const count = async (query: Promise<Array<Record<string, unknown>>>) =>
    Number((await query)[0]?.["n"]);
const users = (email: string) =>
    count(h.db.database.sql`select count(*)::int as n from users where email = ${email}`);

describe("starting", () => {
    it("sends the browser to the provider with state, a nonce, S256 PKCE and our fixed redirect", async () => {
        const started = await start("Ada@Acme.example");
        expect(started.url.origin + started.url.pathname).toBe(idp.discovery.authorizationEndpoint);
        const q = started.url.searchParams;
        expect([
            q.get("response_type"),
            q.get("client_id"),
            q.get("redirect_uri"),
            q.get("scope"),
            q.get("code_challenge_method"),
        ]).toEqual(["code", idp.clientId, REDIRECT, "openid email", "S256"]);
        expect(q.get("login_hint")).toBe("ada@acme.example");
        expect(started.state).toHaveLength(43);
        expect(started.nonce).toHaveLength(43);
        const stored = await h.db.database
            .sql`select count(*)::int as n from sso_flows where encode(state_hash, 'escape') = ${started.state}`;
        expect(stored[0]?.["n"]).toBe(0); // only a hash of the state is kept
    });

    it("answers 404 for an address whose domain no organization proved, and refuses nonsense", async () => {
        expect((await post("/auth/sso/start", { email: "x@unclaimed.example" })).status).toBe(404);
        expect((await post("/auth/sso/start", { email: "not-an-email" })).status).toBe(400);
        expect((await post("/auth/sso/start", { email: "a@acme.example", extra: 1 })).status).toBe(
            400,
        );
    });
});

describe("signing in", () => {
    it("creates an account, makes it a member, starts an sso session, and recognises the person next time", async () => {
        const first = await signIn("ada@acme.example", { sub: "ada-1" });
        expect(location(first.response)).toBe(done("signed_in"));
        const token = sessionOf(first.response);
        expect(token).not.toBe("");
        const me = await h.app().request("/api/v1/me", { headers: browser(token) });
        expect(me.status).toBe(200);
        const [member] = await h.db.database
            .sql`select m.role, s.auth_method from memberships m, sessions s, users u
            where m.org_id = ${org} and u.email = 'ada@acme.example' and m.user_id = u.id and s.user_id = u.id`;
        expect(member).toEqual({ role: "member", auth_method: "sso" });
        const second = await signIn("ada@acme.example", { sub: "ada-1" });
        expect(location(second.response)).toBe(done("signed_in"));
        expect(await users("ada@acme.example")).toBe(1);
        expect(
            await count(
                h.db.database
                    .sql`select count(*)::int as n from memberships m join users u on u.id = m.user_id where u.email = 'ada@acme.example' and m.org_id = ${org}`,
            ),
        ).toBe(1);
    });

    it("recognises the subject, not the email: a changed email still signs the same person in", async () => {
        const again = await signIn("ada.new@acme.example", { sub: "ada-1" });
        expect(location(again.response)).toBe(done("signed_in"));
        expect(await users("ada.new@acme.example")).toBe(0);
    });

    it("attaches an existing account when the verified email is in the organization's domain", async () => {
        await h.db.database
            .sql`insert into users (email, email_verified_at) values ('bea@acme.example', now())`;
        const result = await signIn("bea@acme.example", { sub: "bea-1" });
        expect(location(result.response)).toBe(done("signed_in"));
        expect(await users("bea@acme.example")).toBe(1);
        expect(
            await count(
                h.db.database
                    .sql`select count(*)::int as n from sso_identities where subject = 'bea-1'`,
            ),
        ).toBe(1);
    });

    it("refuses a token whose email is outside the verified domains, and creates nothing", async () => {
        const started = await start("cy@acme.example");
        const code = "code-outside";
        idp.codes.set(
            code,
            await idp.mint({
                sub: "cy-1",
                email: "cy@evil.example",
                email_verified: true,
                nonce: started.nonce,
            }),
        );
        const response = await callback({ code, state: started.state }, [started.cookie]);
        expect(location(response)).toBe(done("failed", "wrong_domain"));
        expect(sessionOf(response)).toBe("");
        expect(await users("cy@evil.example")).toBe(0);
    });
});

const refusal = async (
    mutate: (claims: IdTokenClaims) => IdTokenClaims,
    options: Parameters<FakeIdp["mint"]>[1] = {},
) => {
    const started = await start("dee@acme.example");
    const code = `code-r-${++subjectCounter}`;
    idp.codes.set(
        code,
        await idp.mint(
            mutate({
                sub: "dee-1",
                email: "dee@acme.example",
                email_verified: true,
                nonce: started.nonce,
            }),
            options,
        ),
    );
    const response = await callback({ code, state: started.state }, [started.cookie]);
    expect(sessionOf(response)).toBe("");
    return location(response);
};

describe("refusals", () => {
    it("refuses a bad signature, a wrong nonce, an expired token, an unverified email and another audience", async () => {
        const now = Math.floor(h.clock.nowUnixMs() / 1000);
        expect(await refusal((c) => c, { signWith: "other" })).toBe(done("failed", "invalid"));
        expect(await refusal((c) => ({ ...c, nonce: "x".repeat(43) }))).toBe(
            done("failed", "invalid"),
        );
        expect(await refusal((c) => ({ ...c, exp: now - 600, iat: now - 1200 }))).toBe(
            done("failed", "invalid"),
        );
        expect(await refusal((c) => ({ ...c, email_verified: false }))).toBe(
            done("failed", "email_unverified"),
        );
        expect(await refusal((c) => ({ ...c, aud: "someone-else" }))).toBe(
            done("failed", "invalid"),
        );
        expect(await users("dee@acme.example")).toBe(0);
    });

    it("uses a flow once, and only from the browser that started it", async () => {
        const started = await start("eve@acme.example");
        const code = "code-once";
        idp.codes.set(
            code,
            await idp.mint({
                sub: "eve-1",
                email: "eve@acme.example",
                email_verified: true,
                nonce: started.nonce,
            }),
        );
        const wrongBrowser = await callback({ code, state: started.state }, [
            `aura_oauth=${"A".repeat(43)}`,
        ]);
        expect(location(wrongBrowser)).toBe(done("failed", "invalid"));
        const first = await callback({ code, state: started.state }, [started.cookie]);
        expect(location(first)).toBe(done("signed_in"));
        const replay = await callback({ code, state: started.state }, [started.cookie]);
        expect(location(replay)).toBe(done("failed", "invalid"));
    });
});

describe("refusals, continued", () => {
    it("refuses a malformed state or code, a denial, and a provider that cannot be reached", async () => {
        expect(location(await callback({ code: "c", state: "short" }, ["aura_oauth=x"]))).toBe(
            done("failed", "invalid"),
        );
        const started = await start("fay@acme.example");
        expect(
            location(
                await callback({ error: "access_denied", state: started.state }, [started.cookie]),
            ),
        ).toBe(done("failed", "denied"));
        const again = await start("fay@acme.example");
        idp.codes.set(
            "code-down",
            await idp.mint({
                sub: "fay-1",
                email: "fay@acme.example",
                email_verified: true,
                nonce: again.nonce,
            }),
        );
        const keys = idp.jwks;
        idp.jwks = null;
        expect(
            location(await callback({ code: "code-down", state: again.state }, [again.cookie])),
        ).toBe(done("failed", "unavailable"));
        idp.jwks = keys;
    });

    it("refuses a suspended account", async () => {
        await h.db.database
            .sql`insert into users (email, email_verified_at, status) values ('gus@acme.example', now(), 'suspended')`;
        const result = await signIn("gus@acme.example", { sub: "gus-1" });
        expect(location(result.response)).toBe(done("failed", "suspended"));
        expect(sessionOf(result.response)).toBe("");
    });
});

describe("the plan", () => {
    it("leaves no stray account when the organization is full", async () => {
        await h.db.database
            .sql`update customers set plan = 'free', updated_at = now() where org_id = ${org}`;
        await h.db.database.sql`insert into users (email, email_verified_at)
            select 'filler' || n || '@acme.example', now() from generate_series(1, 6) n`;
        await h.db.database.sql`insert into memberships (org_id, user_id, role)
            select ${org}, id, 'member' from users where email like 'filler%@acme.example'
            on conflict do nothing`;
        const result = await signIn("hal@acme.example", { sub: "hal-1" });
        expect(location(result.response)).toBe(done("failed", "plan_full"));
        expect(await users("hal@acme.example")).toBe(0);
        await h.db.database
            .sql`update customers set plan = 'enterprise', updated_at = now() where org_id = ${org}`;
    });
});

const put = async (user: string, body: unknown) => {
    h.clock.advance(61_000);
    return h.request(`/orgs/${orgPublic}/sso/enforcement`, {
        method: "PUT",
        headers: browser((await h.login(user)).token, { "content-type": "application/json" }),
        body: JSON.stringify(body),
    });
};

describe("requiring SSO", () => {
    it("needs the administrator to have signed in through SSO first", async () => {
        const refused = await put(ALICE, { enforced: true });
        expect(refused.status).toBe(409);
        await h.db.database
            .sql`insert into sso_identities (org_id, subject, user_id, created_at) values (${org}, 'alice-1', ${ALICE}, now())`;
        const accepted = await put(ALICE, { enforced: true });
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toMatchObject({ enforced: true });
    });

    it("closes the other ways in for the organization's people, but not for owners or outsiders", async () => {
        const blocks = (user: string, method: string) =>
            h.db.database.sql`select sso_blocks_sign_in(${user}, ${method}) as blocked`.then(
                (r) => r[0]?.["blocked"],
            );
        const [ada] = await h.db.database.sql<
            { id: string }[]
        >`select id from users where email = 'ada@acme.example'`;
        for (const method of ["email_link", "email_code", "passkey", "github", "google"])
            expect(await blocks(ada?.id ?? "", method), method).toBe(true);
        expect(await blocks(ada?.id ?? "", "sso")).toBe(false);
        await h.db.database.sql`update users set email = 'alice@acme.example' where id = ${ALICE}`;
        expect(await blocks(ALICE, "passkey")).toBe(false); // an owner keeps a way in if the provider is down
        expect(await blocks(BOB, "passkey")).toBe(false); // bob@example.com is outside every verified domain
    });

    it("stops an email sign-in for one of its people, and still lets an outsider in", async () => {
        const viaEmail = async (email: string) => {
            const a = address();
            const started = await h.app(TRUST).request("/api/v1/auth/email/start", {
                method: "POST",
                headers: browser(null, {
                    "content-type": "application/json",
                    "x-forwarded-for": a,
                }),
                body: JSON.stringify({ email }),
            });
            const binding =
                started.headers
                    .getSetCookie()
                    .find((c) => c.startsWith("aura_login="))
                    ?.split(";")[0] ?? "";
            const token =
                /#t=([A-Za-z0-9_-]{43})/.exec(h.mail.outbox.at(-1)?.text ?? "")?.[1] ?? "";
            return h.app(TRUST).request("/api/v1/auth/email/verify", {
                method: "POST",
                headers: browser(null, {
                    "content-type": "application/json",
                    "x-forwarded-for": a,
                    cookie: binding,
                }),
                body: JSON.stringify({ token }),
            });
        };
        expect((await viaEmail("ada@acme.example")).status).toBe(400);
        expect((await viaEmail("outsider@example.com")).status).toBe(200);
    });
});

describe("requiring SSO, continued", () => {
    it("can be switched off again", async () => {
        const off = await put(ALICE, { enforced: false });
        expect(off.status).toBe(200);
        expect(await off.json()).toMatchObject({ enforced: false });
    });
});
