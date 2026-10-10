// Goal: the sessions routes show and revoke only the caller's own sessions, never expose a token
// or its hash, write one audit entry per action inside the same transaction, clear the cookie with
// the production attributes where it matters, and run as the least-privileged database role.
import { sessionsResponseSchema } from "@aura/contracts/api/identity";
import { problemSchema } from "@aura/contracts/errors";
import { encodeId } from "@aura/contracts/ids";
import { verifyAuditChain } from "@aura/db/audit";
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

const valid = async (token: string) =>
    (await h.asIdentity((deps) => validateSession(deps, token))).ok;
const post = (path: string, token: string | null) =>
    h.request(path, { method: "POST", headers: browser(token) });
const auditActions = async (userId: string) =>
    (
        await h.db.database.sql<{ action: string }[]>`
            select action from audit_log where actor_user_id = ${userId} order by seq`
    ).map((row) => row.action);

describe("GET /me/sessions", () => {
    it("lists only the caller's active sessions, newest first, marking the current one", async () => {
        const first = await h.login(ALICE);
        h.clock.advance(1000);
        const second = await h.login(ALICE);
        await h.login(BOB);
        const revoked = await h.login(ALICE);
        await h.asIdentity((deps) =>
            deps.store.revoke(revoked.session.id, h.clock.nowUnixMs(), "admin"),
        );
        const response = await h.request("/me/sessions", { headers: browser(first.token) });
        const text = await response.text();
        const body = sessionsResponseSchema.parse(JSON.parse(text));
        const ids: string[] = body.items.map((item) => item.id);
        expect(ids).toContain(encodeId("ses", first.session.id));
        expect(ids).toContain(encodeId("ses", second.session.id));
        expect(ids).not.toContain(encodeId("ses", revoked.session.id));
        expect(ids.indexOf(encodeId("ses", second.session.id))).toBeLessThan(
            ids.indexOf(encodeId("ses", first.session.id)),
        );
        expect(body.items.filter((item) => item.current).map((item) => item.id)).toEqual([
            encodeId("ses", first.session.id),
        ]);
        for (const secret of [first.token, second.token, first.session.tokenHash])
            expect(text).not.toContain(secret);
    });

    it("requires a session", async () => {
        expect((await h.request("/me/sessions")).status).toBe(401);
    });
});

describe("DELETE /me/sessions/{id}", () => {
    const remove = (id: string, token: string) =>
        h.request(`/me/sessions/${id}`, { method: "DELETE", headers: browser(token) });

    it("revokes one of the caller's other sessions and audits it", async () => {
        const mine = await h.login(ALICE);
        const other = await h.login(ALICE);
        const response = await remove(encodeId("ses", other.session.id), mine.token);
        expect(response.status).toBe(204);
        expect(await valid(other.token)).toBe(false);
        expect(await valid(mine.token)).toBe(true);
        expect(
            (await auditActions(ALICE)).filter((a) => a === "session.revoked").length,
        ).toBeGreaterThan(0);
    });

    it("answers 404 for another person's session, a missing one and an already revoked one", async () => {
        const mine = await h.login(ALICE);
        const bobs = await h.login(BOB);
        const gone = await h.login(ALICE);
        await remove(encodeId("ses", gone.session.id), mine.token);
        const ghost = encodeId("ses", "018f0000-0000-7000-8000-0000000000ff");
        for (const id of [
            encodeId("ses", bobs.session.id),
            ghost,
            encodeId("ses", gone.session.id),
        ]) {
            const response = await remove(id, mine.token);
            expect(response.status, id).toBe(404);
            expect(problemSchema.parse(await response.json()).code).toBe("not_found");
        }
        expect(await valid(bobs.token)).toBe(true);
    });

    it("answers 400 for malformed ids without ever tripping an invariant", async () => {
        const mine = await h.login(ALICE);
        for (const id of [
            "nope",
            "usr_018f0000-0000-7000-8000-0000000000ff",
            "ses_",
            "ses_1' or '1'='1",
            "%00",
        ]) {
            const response = await remove(id, mine.token);
            expect(response.status, id).toBe(400);
        }
        expect(h.onInvariantViolation).not.toHaveBeenCalled();
    });

    it("revoking the current session also clears the cookie", async () => {
        const mine = await h.login(ALICE);
        const response = await remove(encodeId("ses", mine.session.id), mine.token);
        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        expect(await valid(mine.token)).toBe(false);
    });
});

describe("logout", () => {
    it("ends the session, clears the cookie and writes one audit entry", async () => {
        const mine = await h.login(ALICE);
        const before = (await auditActions(ALICE)).filter((a) => a === "auth.logout").length;
        const response = await post("/auth/logout", mine.token);
        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toBe(
            "aura_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        expect(await valid(mine.token)).toBe(false);
        expect((await auditActions(ALICE)).filter((a) => a === "auth.logout").length).toBe(
            before + 1,
        );
    });

    it("is idempotent: logging out without a session still succeeds and clears the cookie", async () => {
        const response = await post("/auth/logout", null);
        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });

    it("uses the production cookie attributes when configured for production", async () => {
        const prod = h.app({
            AURA_ENV: "prod",
            AURA_PUBLIC_ORIGIN: "https://app.example",
            AURA_LOG_LEVEL: "info",
            AURA_MAIL_DRIVER: "disabled",
            // Production cannot use the in-memory storage driver.
            AURA_STORAGE_DRIVER: "s3",
            AURA_S3_ENDPOINT: "https://s3.example",
            AURA_S3_PUBLIC_ENDPOINT: "https://s3.example",
            AURA_S3_BUCKET: "aura-prod",
            AURA_S3_REGION: "eu-west-1",
            AURA_S3_ACCESS_KEY_ID: "id",
            AURA_S3_SECRET_ACCESS_KEY: "secret",
        });
        const response = await prod.request("/api/v1/auth/logout", {
            method: "POST",
            headers: {
                origin: "https://app.example",
                "sec-fetch-site": "same-origin",
                "x-aura-request": "1",
            },
        });
        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toBe(
            "__Host-aura_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
        );
    });
});

describe("logout everywhere", () => {
    it("ends every one of the caller's sessions and no one else's, and audits the count", async () => {
        const a = await h.login(ALICE);
        const b = await h.login(ALICE);
        const bobs = await h.login(BOB);
        const response = await post("/auth/logout-all", a.token);
        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        expect(await valid(a.token)).toBe(false);
        expect(await valid(b.token)).toBe(false);
        expect(await valid(bobs.token)).toBe(true);
        const [entry] = await h.db.database.sql<{ detail: { sessions_revoked: number } }[]>`
            select detail from audit_log where action = 'auth.logout_all' and actor_user_id = ${ALICE}
            order by seq desc limit 1`;
        expect(entry?.detail.sessions_revoked).toBeGreaterThanOrEqual(2);
    });

    it("requires a session", async () => {
        expect((await post("/auth/logout-all", null)).status).toBe(401);
    });
});

describe("transaction and role", () => {
    it("runs handlers as the application role, and rolls back when the response is an error", async () => {
        const app = h.app();
        app.get("/v1/_probe/role", async (c) => {
            const [row] = await c.get("tx")`select current_user as name`;
            return c.json({ role: row?.["name"] });
        });
        app.post("/v1/_probe/write-then-fail", async (c) => {
            const actor = c.get("actor");
            await c.get("tx")`insert into audit_log (actor_user_id, actor_kind, action)
                values (${actor.kind === "user" ? actor.userId : null}, 'user', 'probe.rolled_back')`;
            return c.json({ nope: true }, 404);
        });
        const { token } = await h.login(ALICE);
        const role = await app.request("/api/v1/_probe/role", { headers: browser(token) });
        expect(await role.json()).toEqual({ role: "aura_app" });
        const failing = await app.request("/api/v1/_probe/write-then-fail", {
            method: "POST",
            headers: browser(token),
        });
        expect(failing.status).toBe(404);
        expect(await auditActions(ALICE)).not.toContain("probe.rolled_back");
    });

    it("leaves the audit chain intact after everything above", async () => {
        const result = await verifyAuditChain(h.db.database.sql);
        expect(result.ok).toBe(true);
    });
});
