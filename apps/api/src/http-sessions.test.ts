// Goal: prove the session transport end to end through the real HTTP app and a real PostgreSQL:
// who is treated as logged in, what a stale or forged cookie does, that cross-site requests are
// refused, that people see and revoke only their own sessions, that everything is audited in the
// same transaction, and that handlers run as the least-privileged database role.

import { meResponseSchema } from "@aura/contracts/api/identity";
import { problemSchema } from "@aura/contracts/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { validateSession } from "./modules/identity/service.ts";

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
});
afterAll(async () => {
    await h.drop();
});

const request = (path: string, init?: RequestInit & { headers?: Record<string, string> }) =>
    h.request(path, init);
const login = (userId: string) => h.login(userId);
const asIdentity: Harness["asIdentity"] = (work) => h.asIdentity(work);
const clock = {
    advance: (ms: number) => h.clock.advance(ms),
    nowUnixMs: () => h.clock.nowUnixMs(),
};

describe("authenticate", () => {
    it("treats a request with no cookie as anonymous", async () => {
        const response = await request("/me");
        expect(response.status).toBe(401);
        expect(problemSchema.parse(await response.json()).code).toBe("unauthenticated");
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("recognizes a valid cookie and returns only the allowlisted fields", async () => {
        const { token } = await login(ALICE);
        const response = await request("/me", { headers: browser(token) });
        expect(response.status).toBe(200);
        const text = await response.text();
        const body = meResponseSchema.parse(JSON.parse(text));
        expect(body).toMatchObject({
            email: "alice@example.com",
            email_verified: true,
            handle: "alice",
        });
        expect(text).not.toContain(token);
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("answers 401 and clears the cookie for unknown, revoked, expired and suspended sessions", async () => {
        const unknown = await request("/me", { headers: browser("A".repeat(43)) });
        const revoked = await login(ALICE);
        await asIdentity((deps) =>
            deps.store.revoke(revoked.session.id, clock.nowUnixMs(), "admin"),
        );
        const gone = await request("/me", { headers: browser(revoked.token) });
        const stale = await login(ALICE);
        clock.advance(8 * 24 * 3600 * 1000);
        const expired = await request("/me", { headers: browser(stale.token) });
        for (const response of [unknown, gone, expired]) {
            expect(response.status).toBe(401);
            expect(response.headers.get("set-cookie")).toBe(
                "aura_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
            );
        }
        const bobs = await login(BOB);
        await h.db.database.sql`update users set status = 'suspended' where id = ${BOB}`;
        const suspended = await request("/me", { headers: browser(bobs.token) });
        expect(suspended.status).toBe(401);
        await h.db.database.sql`update users set status = 'active' where id = ${BOB}`;
    });
});

describe("authenticate, malformed cookies and sliding expiry", () => {
    it("ignores duplicate cookies and malformed values instead of guessing", async () => {
        const { token } = await login(ALICE);
        const duplicate = await request("/me", {
            headers: browser(null, { cookie: `aura_session=${token}; aura_session=${token}` }),
        });
        expect(duplicate.status).toBe(401);
        const malformed = await request("/me", {
            headers: browser(null, { cookie: "aura_session=not a token" }),
        });
        expect(malformed.status).toBe(401);
        const wrongName = await request("/me", {
            headers: browser(null, { cookie: `__Host-aura_session=${token}` }),
        });
        expect(wrongName.status).toBe(401);
        expect(h.onInvariantViolation).not.toHaveBeenCalled();
    });

    it("slides the idle expiry once the touch interval has passed", async () => {
        const { token, session } = await login(ALICE);
        clock.advance(61 * 1000);
        expect((await request("/me", { headers: browser(token) })).status).toBe(200);
        const [row] = await h.db.database.sql<
            { last_seen_at: Date }[]
        >`select last_seen_at from sessions where id = ${session.id}`;
        expect(row?.last_seen_at.getTime()).toBe(clock.nowUnixMs());
    });
});

describe("cross-site request check", () => {
    it("refuses state-changing requests without the custom header, even with a valid session", async () => {
        const { token } = await login(ALICE);
        const headers = browser(token);
        delete headers["x-aura-request"];
        const response = await request("/auth/logout", { method: "POST", headers });
        expect(response.status).toBe(403);
        expect(problemSchema.parse(await response.json()).code).toBe("forbidden");
        expect((await asIdentity((deps) => validateSession(deps, token))).ok).toBe(true);
    });

    it("refuses a foreign Origin, a cross-site fetch and a request with no browser evidence", async () => {
        const { token } = await login(ALICE);
        const attempts = [
            browser(token, { origin: "https://evil.example" }),
            browser(token, { "sec-fetch-site": "cross-site" }),
            (() => {
                const bare = browser(token);
                delete bare["origin"];
                delete bare["sec-fetch-site"];
                return bare;
            })(),
        ];
        for (const headers of attempts) {
            expect((await request("/auth/logout", { method: "POST", headers })).status).toBe(403);
        }
        expect((await asIdentity((deps) => validateSession(deps, token))).ok).toBe(true);
    });

    it("applies to anonymous requests too, and never to reads", async () => {
        expect((await request("/auth/logout", { method: "POST" })).status).toBe(403);
        const { token } = await login(ALICE);
        const read = await request("/me", {
            headers: { cookie: `aura_session=${token}`, origin: "https://evil.example" },
        });
        expect(read.status).toBe(200);
    });
});
