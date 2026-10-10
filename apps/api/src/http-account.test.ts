// Goal: the account routes: the sign-in methods list reflects configuration, the data export holds
// what the person can see and nothing secret and is bounded, and a deletion request is recorded,
// ends every session, can be taken back, and is audited.

import { authMethodsResponseSchema, exportSchema } from "@aura/contracts/api/account";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { createGithubProvider } from "./modules/identity/oauth-providers.ts";

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
});
afterAll(async () => {
    await h.drop();
});

describe("sign-in methods", () => {
    it("lists email and passkeys, and only the OAuth providers that are configured", async () => {
        const none = await h.request("/auth/methods");
        expect(authMethodsResponseSchema.parse(await none.json())).toEqual({
            email: true,
            passkey: true,
            oauth: [],
        });
        const github = new Map([
            ["github" as const, createGithubProvider({ clientId: "a", clientSecret: "b" })],
        ]);
        const some = await h.app({}, undefined, github).request("/api/v1/auth/methods");
        expect(authMethodsResponseSchema.parse(await some.json()).oauth).toEqual(["github"]);
    });

    it("says email is off when the mail driver is disabled", async () => {
        const response = await h
            .app({ AURA_MAIL_DRIVER: "disabled" })
            .request("/api/v1/auth/methods");
        expect(authMethodsResponseSchema.parse(await response.json()).email).toBe(false);
    });
});

describe("data export", () => {
    it("holds the person's own data, no secrets, and is a download", async () => {
        const { token } = await h.login(ALICE);
        await h.db.database
            .sql`insert into passkeys (user_id, credential_id, public_key, device_type, backed_up, name)
            values (${ALICE}, ${Buffer.alloc(32, 3)}, ${Buffer.alloc(77, 4)}, 'singleDevice', false, 'Laptop')`;
        const response = await h.request("/me/export", { headers: browser(token) });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toContain("attachment");
        const text = await response.text();
        const body = exportSchema.parse(JSON.parse(text));
        expect(body.account).toMatchObject({
            email: "alice@example.com",
            handle: "alice",
            email_verified: true,
        });
        expect(body.passkeys.map((p) => p.name)).toContain("Laptop");
        expect(body.sessions.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/token_hash|public_key|secret|bob@example/i);
    });

    it("needs a session, is audited, and never includes another person's data", async () => {
        expect((await h.request("/me/export")).status).toBe(401);
        const { token } = await h.login(BOB);
        const body = exportSchema.parse(
            await (await h.request("/me/export", { headers: browser(token) })).json(),
        );
        expect(body.account.email).toBe("bob@example.com");
        expect(body.passkeys).toHaveLength(0);
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'account.exported' and actor_user_id = ${BOB}`;
        expect(row?.n).toBe("1");
    });

    it("keeps the audit part to the 200 most recent entries", async () => {
        const { token } = await h.login(ALICE);
        for (let n = 0; n < 250; n++) {
            await h.db.database
                .sql`insert into audit_log (actor_user_id, actor_kind, action) values (${ALICE}, 'user', 'test.filler')`;
        }
        const body = exportSchema.parse(
            await (await h.request("/me/export", { headers: browser(token) })).json(),
        );
        expect(body.audit).toHaveLength(200);
    });
});

describe("deletion request", () => {
    it("is recorded, ends every session and clears the cookie, and shows in /me", async () => {
        const first = await h.login(ALICE);
        const second = await h.login(ALICE);
        const response = await h.request("/me/delete-request", {
            method: "POST",
            headers: browser(first.token),
        });
        expect(response.status).toBe(202);
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        for (const token of [first.token, second.token]) {
            expect((await h.request("/me", { headers: browser(token) })).status).toBe(401);
        }
        const [row] = await h.db.database.sql<
            { deletion_requested_at: Date | null }[]
        >`select deletion_requested_at from users where id = ${ALICE}`;
        expect(row?.deletion_requested_at).not.toBeNull();
        const [audit] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'account.deletion_requested' and actor_user_id = ${ALICE}`;
        expect(audit?.n).toBe("1");
    });

    it("can be taken back after signing in again, and needs a session and the CSRF header", async () => {
        const { token } = await h.login(ALICE);
        const me = await (await h.request("/me", { headers: browser(token) })).json();
        expect(me).toMatchObject({ deletion_requested_at: expect.any(String) });
        const headers = browser(token);
        delete headers["x-aura-request"];
        expect((await h.request("/me/delete-request", { method: "DELETE", headers })).status).toBe(
            403,
        );
        expect(
            (await h.request("/me/delete-request", { method: "DELETE", headers: browser(null) }))
                .status,
        ).toBe(401);
        expect(
            (await h.request("/me/delete-request", { method: "DELETE", headers: browser(token) }))
                .status,
        ).toBe(204);
        expect(await (await h.request("/me", { headers: browser(token) })).json()).toMatchObject({
            deletion_requested_at: null,
        });
    });
});
