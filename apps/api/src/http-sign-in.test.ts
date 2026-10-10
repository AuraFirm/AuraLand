// Goal: prove email sign-in end to end through the real HTTP app, PostgreSQL and the mail port:
// the happy paths (link and code), that nothing reveals whether an account exists, that a link only
// works in the browser that asked for it, that links and codes are single-use and expire, that
// guessing is capped, that limits refuse floods, and that every outcome leaves the right audit trail.

import { meResponseSchema } from "@aura/contracts/api/identity";
import { problemSchema } from "@aura/contracts/errors";
import { verifyAuditChain } from "@aura/db/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import { createFixedOriginClient } from "./platform/egress.ts";
import { createMailpitMail, MailUnavailableError } from "./platform/mail.ts";
import { mailpitUrl } from "./platform/test-helpers.ts";

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
});
afterAll(async () => {
    await h.drop();
});

const TRUST = { AURA_TRUST_EDGE_REQUEST_ID: "true" };
let addressCounter = 0;
const freshAddress = () => `198.51.100.${++addressCounter}`;
let emailCounter = 0;
const freshEmail = () => `person${++emailCounter}@example.com`;

interface CallOptions {
    readonly cookie?: string;
    readonly address?: string;
    readonly headers?: Record<string, string>;
}

function post(path: string, body: unknown, options: CallOptions = {}) {
    const headers = browser(null, {
        "content-type": "application/json",
        "x-forwarded-for": options.address ?? freshAddress(),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...options.headers,
    });
    return Promise.resolve(
        h.app(TRUST).request(`/api/v1${path}`, {
            method: "POST",
            headers,
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    );
}

const bindingFrom = (response: Response) => {
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("aura_login="));
    return cookie?.split(";")[0] ?? "";
};

interface Started {
    readonly email: string;
    readonly token: string;
    readonly code: string;
    readonly binding: string;
}

async function start(email = freshEmail(), address = freshAddress()): Promise<Started> {
    const response = await post("/auth/email/start", { email }, { address });
    expect(response.status).toBe(202);
    const mail = h.mail.outbox.at(-1);
    expect(mail?.to).toBe(email);
    const token = /#t=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "")?.[1] ?? "";
    const code = (/(\d{4}) (\d{4})/.exec(mail?.text ?? "") ?? []).slice(1).join("");
    return { email, token, code, binding: bindingFrom(response) };
}

const verify = (body: unknown, binding: string, options: CallOptions = {}) =>
    post("/auth/email/verify", body, {
        ...options,
        cookie: [binding, options.cookie].filter(Boolean).join("; "),
    });

describe("start", () => {
    it("sends one email with a link and a code and sets the browser-binding cookie", async () => {
        const before = h.mail.outbox.length;
        const response = await post("/auth/email/start", { email: freshEmail() });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ status: "sent" });
        expect(h.mail.outbox.length).toBe(before + 1);
        const cookie = response.headers.getSetCookie().join("\n");
        expect(cookie).toMatch(
            /^aura_login=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=900$/,
        );
        const text = h.mail.outbox.at(-1)?.text ?? "";
        expect(text).toContain(`${ORIGIN}/auth/verify#t=`);
        expect(text).toMatch(/\b\d{4} \d{4}\b/);
    });

    it("answers identically for an existing and an unknown address", async () => {
        const known = await post("/auth/email/start", { email: "alice@example.com" });
        const unknown = await post("/auth/email/start", { email: freshEmail() });
        expect(known.status).toBe(unknown.status);
        expect(await known.json()).toEqual(await unknown.json());
        const shape = (r: Response) =>
            [...r.headers.keys()].filter((k) => !["x-request-id", "set-cookie"].includes(k)).sort();
        expect(shape(known)).toEqual(shape(unknown));
        expect(bindingFrom(known)).toMatch(/^aura_login=.{43}$/);
        expect(bindingFrom(unknown)).toMatch(/^aura_login=.{43}$/);
    });

    it("normalizes the address and refuses malformed or unexpected input", async () => {
        const ok = await post("/auth/email/start", { email: "  Mixed.Case@Example.COM " });
        expect(ok.status).toBe(202);
        expect(h.mail.outbox.at(-1)?.to).toBe("mixed.case@example.com");
        for (const body of [
            {},
            { email: "nope" },
            { email: freshEmail(), extra: 1 },
            "not json",
            { email: 5 },
        ]) {
            const response = await post("/auth/email/start", body);
            expect(response.status, JSON.stringify(body)).toBe(400);
            expect(problemSchema.parse(await response.json()).code).toBe("invalid_request");
        }
    });

    it("answers 503 and sets no cookie when the mail service is down", async () => {
        const failing = {
            send: async () => {
                throw new MailUnavailableError("down");
            },
        };
        const response = await h.app(TRUST, failing).request("/api/v1/auth/email/start", {
            method: "POST",
            headers: browser(null, {
                "content-type": "application/json",
                "x-forwarded-for": freshAddress(),
            }),
            body: JSON.stringify({ email: freshEmail() }),
        });
        expect(response.status).toBe(503);
        expect(response.headers.getSetCookie()).toEqual([]);
    });
});

describe("verify with the link", () => {
    it("creates the account, starts a session and clears the binding cookie", async () => {
        const s = await start();
        const response = await verify({ token: s.token }, s.binding);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "signed_in", new_account: true });
        const cookies = response.headers.getSetCookie();
        const session = cookies.find((c) => c.startsWith("aura_session="));
        expect(session).toMatch(/^aura_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax/);
        expect(cookies.some((c) => c.startsWith("aura_login=;") && c.includes("Max-Age=0"))).toBe(
            true,
        );
        const token = session?.split(";")[0]?.split("=")[1] ?? "";
        const me = await h.request("/me", { headers: browser(token) });
        const body = meResponseSchema.parse(await me.json());
        expect(body).toMatchObject({ email: s.email, email_verified: true });
        expect(body.handle).toMatch(/^user_[0-9a-f]{10}$/);
    });

    it("works once only", async () => {
        const s = await start();
        expect((await verify({ token: s.token }, s.binding)).status).toBe(200);
        const again = await verify({ token: s.token }, s.binding);
        expect(again.status).toBe(400);
        expect(again.headers.getSetCookie().some((c) => c.startsWith("aura_session="))).toBe(false);
    });

    it("needs the browser that asked: no cookie, or another browser's cookie, fails", async () => {
        const mine = await start();
        const theirs = await start();
        expect((await post("/auth/email/verify", { token: mine.token })).status).toBe(400);
        expect((await verify({ token: mine.token }, theirs.binding)).status).toBe(400);
        // The failed tries did not spend the link.
        expect((await verify({ token: mine.token }, mine.binding)).status).toBe(200);
    });

    it("expires exactly after 15 minutes", async () => {
        const s = await start();
        h.clock.advance(15 * 60 * 1000 - 1);
        const early = await start();
        h.clock.advance(1);
        expect((await verify({ token: s.token }, s.binding)).status).toBe(400);
        expect((await verify({ token: early.token }, early.binding)).status).toBe(200);
    });
});

describe("verify with the link, existing people and sessions", () => {
    it("signs in an existing person without creating anything and keeps their handle", async () => {
        const s = await start("alice@example.com");
        const response = await verify({ token: s.token }, s.binding);
        expect(await response.json()).toEqual({ status: "signed_in", new_account: false });
        const [count] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from users where email = 'alice@example.com'`;
        expect(count?.n).toBe("1");
        const [profile] = await h.db.database.sql<
            { handle: string }[]
        >`select handle from profiles where user_id = ${ALICE}`;
        expect(profile?.handle).toBe("alice");
    });

    it("refuses a suspended person and creates no session", async () => {
        await h.db.database.sql`update users set status = 'suspended' where id = ${BOB}`;
        const s = await start("bob@example.com");
        const response = await verify({ token: s.token }, s.binding);
        expect(response.status).toBe(400);
        expect(response.headers.getSetCookie().some((c) => c.startsWith("aura_session="))).toBe(
            false,
        );
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'auth.login_refused'`;
        expect(Number(row?.n)).toBeGreaterThanOrEqual(1);
        await h.db.database.sql`update users set status = 'active' where id = ${BOB}`;
    });

    it("ends the session the browser already had and replaces any stale-cookie clearing", async () => {
        const old = await h.login(ALICE);
        const s = await start("alice@example.com");
        const response = await verify({ token: s.token }, s.binding, {
            cookie: `aura_session=${old.token}`,
        });
        expect(response.status).toBe(200);
        expect((await h.request("/me", { headers: browser(old.token) })).status).toBe(401);
        const cookies = response.headers.getSetCookie();
        expect(cookies.filter((c) => c.startsWith("aura_session=")).length).toBe(1);
        expect(cookies.find((c) => c.startsWith("aura_session="))).not.toContain("Max-Age=0");
        const stale = await start();
        const withStale = await verify({ token: stale.token }, stale.binding, {
            cookie: `aura_session=${"Z".repeat(43)}`,
        });
        expect(
            withStale.headers.getSetCookie().find((c) => c.startsWith("aura_session=")),
        ).not.toContain("Max-Age=0");
    });
});

describe("verify with the code", () => {
    it("accepts the code with or without the display spacing", async () => {
        const a = await start();
        expect((await verify({ code: a.code }, a.binding)).status).toBe(200);
        const b = await start();
        const spaced = `${b.code.slice(0, 4)} - ${b.code.slice(4)}`;
        expect((await verify({ code: spaced }, b.binding)).status).toBe(200);
    });

    it("locks after five wrong guesses, even for the right code, and audits the lock", async () => {
        const s = await start();
        const wrong = s.code === "00000000" ? "11111111" : "00000000";
        for (let n = 0; n < 5; n++)
            expect((await verify({ code: wrong }, s.binding)).status).toBe(400);
        expect((await verify({ code: s.code }, s.binding)).status).toBe(400);
        expect((await verify({ token: s.token }, s.binding)).status).toBe(200);
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'auth.code_locked'`;
        expect(Number(row?.n)).toBeGreaterThanOrEqual(1);
    });

    it("expires exactly after 10 minutes while the link still works", async () => {
        const s = await start();
        h.clock.advance(10 * 60 * 1000 - 1);
        const edge = await start();
        h.clock.advance(1);
        expect((await verify({ code: s.code }, s.binding)).status).toBe(400);
        expect((await verify({ code: edge.code }, edge.binding)).status).toBe(200);
        const linkOnly = await start();
        h.clock.advance(10 * 60 * 1000);
        expect((await verify({ code: linkOnly.code }, linkOnly.binding)).status).toBe(400);
        expect((await verify({ token: linkOnly.token }, linkOnly.binding)).status).toBe(200);
    });

    it("refuses malformed proofs, both proofs at once, and unknown fields", async () => {
        const s = await start();
        for (const body of [
            {},
            { code: "12ab5678" },
            { code: "１２３４５６７８" },
            { token: "short" },
            { token: s.token, code: s.code },
            { code: s.code, extra: true },
            "[]",
        ]) {
            expect((await verify(body, s.binding)).status, JSON.stringify(body)).toBe(400);
        }
        // None of those spent the real code.
        expect((await verify({ code: s.code }, s.binding)).status).toBe(200);
    });
});

describe("limits and guards", () => {
    it("refuses a cross-site or header-less request before doing any work", async () => {
        const noHeader = await h.app(TRUST).request("/api/v1/auth/email/start", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() },
            body: JSON.stringify({ email: freshEmail() }),
        });
        expect(noHeader.status).toBe(403);
        const foreign = await post(
            "/auth/email/start",
            { email: freshEmail() },
            { headers: { origin: "https://evil.example" } },
        );
        expect(foreign.status).toBe(403);
    });

    it("limits starts per address: the 11th in a minute is refused with Retry-After", async () => {
        const address = freshAddress();
        for (let n = 0; n < 10; n++)
            expect(
                (await post("/auth/email/start", { email: freshEmail() }, { address })).status,
            ).toBe(202);
        const refused = await post("/auth/email/start", { email: freshEmail() }, { address });
        expect(refused.status).toBe(429);
        expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        expect((await post("/auth/email/start", { email: freshEmail() })).status).toBe(202);
    });

    it("limits starts per email: the 6th in an hour is refused", async () => {
        const email = freshEmail();
        for (let n = 0; n < 5; n++)
            expect((await post("/auth/email/start", { email })).status).toBe(202);
        const sent = h.mail.outbox.length;
        expect((await post("/auth/email/start", { email })).status).toBe(429);
        expect(h.mail.outbox.length).toBe(sent);
    });

    it("limits verification per address, and the count survives refused requests", async () => {
        const address = freshAddress();
        for (let n = 0; n < 30; n++)
            expect((await verify({ code: "00000000" }, "", { address })).status).toBe(400);
        expect((await verify({ code: "00000000" }, "", { address })).status).toBe(429);
    });

    it("keeps the audit chain valid after all of the above", async () => {
        expect((await verifyAuditChain(h.db.database.sql)).ok).toBe(true);
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action in ('auth.signup', 'auth.login_succeeded')`;
        expect(Number(row?.n)).toBeGreaterThan(0);
    });
});

describe("with a real Mailpit", () => {
    it("delivers a message whose link signs the person in", async () => {
        const base = mailpitUrl();
        await fetch(`${base}/api/v1/messages`, { method: "DELETE" });
        const mail = createMailpitMail(createFixedOriginClient(base), "no-reply@auraland.test");
        const email = freshEmail();
        const started = await h.app(TRUST, mail).request("/api/v1/auth/email/start", {
            method: "POST",
            headers: browser(null, {
                "content-type": "application/json",
                "x-forwarded-for": freshAddress(),
            }),
            body: JSON.stringify({ email }),
        });
        expect(started.status).toBe(202);
        const list = z
            .object({ messages: z.array(z.object({ ID: z.string() })) })
            .parse(await (await fetch(`${base}/api/v1/messages`)).json());
        expect(list.messages.length).toBe(1);
        const full = z
            .object({ Text: z.string() })
            .parse(await (await fetch(`${base}/api/v1/message/${list.messages[0]?.ID}`)).json());
        const token = /#t=([A-Za-z0-9_-]{43})/.exec(full.Text)?.[1] ?? "";
        const response = await verify({ token }, bindingFrom(started));
        expect(response.status).toBe(200);
    });
});
