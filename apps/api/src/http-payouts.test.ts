// Goal: platform administrators record a contractor's payout and its payment over HTTP, with a fresh
// passkey check and an audit row each; the contractor sees only their own; nobody else sees the routes
// or the records; an agreement for someone who did not author the version is refused.
import { createHash } from "node:crypto";
import { payoutSchema, payoutsResponseSchema } from "@aura/contracts/api/payouts";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";

let h: Harness;
let version = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
    ] as const)
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'maker-co', 'M') returning id`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${org?.id ?? ""}, 'made-task', 'algorithmic', 'private', 'T', ${CAROL}) returning id`;
    await sql.begin(async (tx) => {
        await tx`alter table task_versions disable trigger task_versions_guard`;
        const [row] = await tx<{ id: string }[]>`insert into task_versions
            (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
            values (${org?.id ?? ""}, ${task?.id ?? ""}, 1, 'released', '{}'::jsonb, 'S', 6, ${createHash("sha256").update("b").digest()}, ${CAROL}, ${DAVE}, now(), true, now())
            returning id`;
        version = row?.id ?? "";
        await tx`alter table task_versions enable trigger task_versions_guard`;
    });
});
afterAll(async () => {
    await h.drop();
});

const call = async (userId: string | null, method: string, path: string, body?: unknown) => {
    const token = userId === null ? null : (await h.login(userId)).token;
    return h.request(path, {
        method,
        headers: browser(token, body === undefined ? {} : { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};
const agreement = (contractor: string) => ({
    contractor_id: encodeId("usr", contractor),
    task_version_id: encodeId("tsv", version),
    amount_minor: 25000,
    currency: "USD",
});

describe("payouts", () => {
    it("are agreed, paid once and audited, and the contractor sees only their own", async () => {
        const created = await call(ALICE, "POST", "/admin/payouts", agreement(CAROL));
        expect(created.status).toBe(201);
        const payout = payoutSchema.parse(await created.json());
        expect(payout.paid_at).toBeNull();
        const paid = await call(ALICE, "POST", `/admin/payouts/${payout.id}/paid`, {
            reference: "wire-77",
        });
        expect(payoutSchema.parse(await paid.json()).paid_reference).toBe("wire-77");
        expect(
            (await call(ALICE, "POST", `/admin/payouts/${payout.id}/paid`, { reference: "again" }))
                .status,
        ).toBe(404);
        const mine = payoutsResponseSchema.parse(
            await (await call(CAROL, "GET", "/me/payouts")).json(),
        );
        expect(mine.payouts.map((p) => p.id)).toContain(payout.id);
        const others = payoutsResponseSchema.parse(
            await (await call(DAVE, "GET", "/me/payouts")).json(),
        );
        expect(others.payouts.length).toBe(0);
        const actions = await h.db.database.sql<
            { action: string }[]
        >`select action from audit_log where action like 'payout.%' order by seq`;
        expect(actions.map((a) => a.action)).toEqual(["payout.recorded", "payout.paid"]);
    });

    it("refuse someone who did not author the version, and hide the admin routes from everyone else", async () => {
        expect((await call(ALICE, "POST", "/admin/payouts", agreement(DAVE))).status).toBe(409);
        expect(
            (await call(ALICE, "POST", "/admin/payouts", { ...agreement(CAROL), amount_minor: 0 }))
                .status,
        ).toBe(400);
        expect((await call(BOB, "GET", "/admin/payouts")).status).toBe(404);
        expect((await call(CAROL, "POST", "/admin/payouts", agreement(CAROL))).status).toBe(404);
        expect((await call(null, "GET", "/admin/payouts")).status).toBe(401);
        const { token } = await h.login(ALICE);
        h.clock.advance(16 * 60 * 1000);
        const stale = await h.request("/admin/payouts", {
            method: "POST",
            headers: browser(token, { "content-type": "application/json" }),
            body: JSON.stringify(agreement(CAROL)),
        });
        expect(stale.status).toBe(403);
    });
});
