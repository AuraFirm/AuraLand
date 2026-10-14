// Goal: the platform status banner. Anyone reads it, briefly cached; only a platform administrator with a
// fresh step-up sets it; the shape is strict (an ok status says nothing, any other says something short and
// plain); and setting it leaves an audit entry.

import { platformStatusSchema } from "@aura/contracts/api/status";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
    await h.db.database.sql`update users set platform_role = 'admin' where id = ${ALICE}`;
});
afterAll(async () => {
    await h.drop();
});

const put = async (user: string | null, body: unknown, privileged = true) =>
    h.request("/admin/status", {
        method: "PUT",
        headers: browser(user === null ? null : (await h.login(user, privileged)).token, {
            "content-type": "application/json",
        }),
        body: JSON.stringify(body),
    });
const read = async () => h.request("/status", { headers: browser(null) });

describe("the status banner", () => {
    it("starts quiet, is public and briefly cached", async () => {
        const response = await read();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("s-maxage=5");
        expect(platformStatusSchema.parse(await response.json())).toMatchObject({
            level: "ok",
            message: "",
        });
    });

    it("is set by an administrator with a fresh step-up, and read back", async () => {
        expect((await put(null, { level: "degraded", message: "x" })).status).toBe(401);
        expect((await put(BOB, { level: "degraded", message: "x" })).status).toBe(404);
        const stale = await h.login(ALICE, true);
        h.clock.advance(16 * 60_000);
        const late = await h.request("/admin/status", {
            method: "PUT",
            headers: browser(stale.token, { "content-type": "application/json" }),
            body: JSON.stringify({ level: "degraded", message: "Judging is slow." }),
        });
        expect(late.status).toBe(403);
        expect(
            (
                await put(ALICE, {
                    level: "degraded",
                    message: "Judging is slow; contests are unaffected.",
                })
            ).status,
        ).toBe(204);
        expect(platformStatusSchema.parse(await (await read()).json())).toMatchObject({
            level: "degraded",
            message: "Judging is slow; contests are unaffected.",
        });
        const [entry] = await h.db.database.sql<
            { action: string }[]
        >`select action from audit_log where action = 'admin.status_set'`;
        expect(entry?.action).toBe("admin.status_set");
        expect((await put(ALICE, { level: "ok", message: "" })).status).toBe(204);
        expect(platformStatusSchema.parse(await (await read()).json()).level).toBe("ok");
    });

    it("refuses an ok with a message, a notice without one, long text, control characters and extra fields", async () => {
        for (const body of [
            { level: "ok", message: "all fine" },
            { level: "outage", message: "" },
            { level: "outage", message: "x".repeat(281) },
            { level: "outage", message: "bad\u0007bell" },
            { level: "panic", message: "x" },
            { level: "outage", message: "x", extra: 1 },
        ]) {
            expect((await put(ALICE, body)).status, JSON.stringify(body)).toBe(400);
        }
    });
});
