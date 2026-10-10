// Goal: prove invitations end to end: an owner or admin sends one by email, the link works once, only
// for the person who signs in with that verified address, for seven days; revoking or re-sending
// kills older links; roles limit who may invite whom; and failures leave nothing half-done.

import { invitationsResponseSchema } from "@aura/contracts/api/invitations";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { MailUnavailableError } from "./platform/mail.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const EVE = "018f0000-0000-7000-8000-0000000000e5";
const DAY = 24 * 60 * 60 * 1000;

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now()), (${DAVE}, 'dave@example.com', now()), (${EVE}, 'eve@example.com', now())`;
    await sql`insert into profiles (user_id, handle, display_name) values (${CAROL}, 'carol', 'Carol'), (${DAVE}, 'dave', 'Dave'), (${EVE}, 'eve', 'Eve')`;
});
afterAll(async () => {
    await h.drop();
});

const JSON_HEADERS = { "content-type": "application/json" };
let addressCounter = 0;
const call = (token: string | null, method: string, path: string, body?: unknown) =>
    Promise.resolve(
        h.app({ AURA_TRUST_EDGE_REQUEST_ID: "true" }).request(`/api/v1${path}`, {
            method,
            headers: browser(token, {
                ...JSON_HEADERS,
                "x-forwarded-for": `203.0.113.${++addressCounter}`,
            }),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );

let slugCounter = 0;
async function team() {
    const { sql } = h.db.database;
    await sql`delete from orgs where id in (select org_id from memberships where user_id in (${ALICE}, ${BOB}, ${CAROL}, ${DAVE}, ${EVE}))`;
    await sql`update users set email_verified_at = now() where id in (${DAVE}, ${EVE})`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', ${`invites-team-${++slugCounter}`}, 'Invite Team') returning id`;
    const id = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${id}, ${ALICE}, 'owner'), (${id}, ${BOB}, 'admin'), (${id}, ${CAROL}, 'member')`;
    return { id, publicId: encodeId("org", id), owner: (await h.login(ALICE)).token };
}

const invite = (token: string, orgId: string, body: Record<string, unknown>) =>
    call(token, "POST", `/orgs/${orgId}/invitations`, body);
const lastToken = () => /#t=([A-Za-z0-9_-]{43})/.exec(h.mail.outbox.at(-1)?.text ?? "")?.[1] ?? "";
const accept = (token: string | null, secret: string) =>
    call(token, "POST", "/invitations/accept", { token: secret });
const roleOf = async (orgId: string, userId: string) => {
    const [row] = await h.db.database.sql<
        { role: string }[]
    >`select role from memberships where org_id = ${orgId} and user_id = ${userId}`;
    return row?.role ?? null;
};

describe("sending invitations", () => {
    it("emails a link, stores only its hash, lists it without the secret and audits it", async () => {
        const t = await team();
        const sent = h.mail.outbox.length;
        const response = await invite(t.owner, t.publicId, { email: "Newcomer@Example.com" });
        expect(response.status).toBe(201);
        expect(h.mail.outbox.length).toBe(sent + 1);
        const mail = h.mail.outbox.at(-1);
        expect(mail?.to).toBe("newcomer@example.com");
        expect(mail?.subject).toContain("Invite Team");
        const secret = lastToken();
        expect(secret).toHaveLength(43);
        const list = await call(t.owner, "GET", `/orgs/${t.publicId}/invitations`);
        const text = JSON.stringify(await list.json());
        expect(invitationsResponseSchema.parse(JSON.parse(text)).items).toHaveLength(1);
        expect(text).not.toContain(secret);
        const [stored] = await h.db.database.sql<
            { token_hash: Buffer }[]
        >`select token_hash from org_invitations where org_id = ${t.id}`;
        expect(stored?.token_hash.toString("hex")).not.toContain(secret);
        const [audit] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'org.invitation_sent' and org_id = ${t.id}`;
        expect(audit?.n).toBe("1");
    });

    it("lets owners invite admins and members, admins invite members, and nobody else invite", async () => {
        const t = await team();
        const bob = await h.login(BOB);
        const carol = await h.login(CAROL);
        const eve = await h.login(EVE);
        expect(
            (await invite(bob.token, t.publicId, { email: "a@example.com", role: "member" }))
                .status,
        ).toBe(201);
        expect(
            (await invite(bob.token, t.publicId, { email: "b@example.com", role: "admin" })).status,
        ).toBe(403);
        expect((await invite(carol.token, t.publicId, { email: "c@example.com" })).status).toBe(
            403,
        );
        expect((await invite(eve.token, t.publicId, { email: "d@example.com" })).status).toBe(404);
        expect(
            (await invite(t.owner, t.publicId, { email: "e@example.com", role: "owner" })).status,
        ).toBe(400);
        expect((await invite(t.owner, t.publicId, { email: "not-an-email" })).status).toBe(400);
        expect(
            (
                await call(null, "POST", `/orgs/${t.publicId}/invitations`, {
                    email: "f@example.com",
                })
            ).status,
        ).toBe(401);
    });
});

describe("sending invitations, roles and limits", () => {
    it("needs a fresh passkey check to invite an admin", async () => {
        const t = await team();
        h.clock.advance(16 * 60 * 1000);
        const response = await invite(t.owner, t.publicId, {
            email: "boss@example.com",
            role: "admin",
        });
        expect(response.status).toBe(403);
        expect(z.object({ code: z.string() }).parse(await response.json()).code).toBe(
            "step_up_required",
        );
        expect(
            (await invite(t.owner, t.publicId, { email: "worker@example.com", role: "member" }))
                .status,
        ).toBe(201);
    });

    it("saves nothing when the email cannot be sent, and refuses personal spaces", async () => {
        const t = await team();
        const failing = {
            send: async () => {
                throw new MailUnavailableError("down");
            },
        };
        const down = await h
            .app({ AURA_TRUST_EDGE_REQUEST_ID: "true" }, failing)
            .request(`/api/v1/orgs/${t.publicId}/invitations`, {
                method: "POST",
                headers: browser(t.owner, { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.200" }),
                body: JSON.stringify({ email: "lost@example.com" }),
            });
        expect(down.status).toBe(503);
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from org_invitations where org_id = ${t.id}`;
        expect(row?.n).toBe("0");
        const { sql } = h.db.database;
        const [personal] = await sql<
            { id: string }[]
        >`insert into orgs (kind, slug, name) values ('personal', 'p-1a2b3c4d5e', 'Personal space') returning id`;
        await sql`insert into memberships (org_id, user_id, role) values (${personal?.id ?? ""}, ${ALICE}, 'owner')`;
        const response = await invite(t.owner, encodeId("org", personal?.id ?? ""), {
            email: "x@example.com",
        });
        expect(response.status).toBe(409);
    });

    it("limits an organization to 20 invitations an hour", async () => {
        const t = await team();
        for (let n = 0; n < 20; n++)
            expect(
                (await invite(t.owner, t.publicId, { email: `bulk${n}@example.com` })).status,
            ).toBe(201);
        expect(
            (await invite(t.owner, t.publicId, { email: "one-too-many@example.com" })).status,
        ).toBe(429);
    });
});

describe("accepting", () => {
    it("adds the person who signs in with the invited address, once", async () => {
        const t = await team();
        await invite(t.owner, t.publicId, { email: "dave@example.com", role: "member" });
        const secret = lastToken();
        const dave = await h.login(DAVE);
        const response = await accept(dave.token, secret);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "joined", org_id: t.publicId });
        expect(await roleOf(t.id, DAVE)).toBe("member");
        expect((await accept(dave.token, secret)).status).toBe(400);
        const list = invitationsResponseSchema.parse(
            await (await call(t.owner, "GET", `/orgs/${t.publicId}/invitations`)).json(),
        );
        expect(list.items).toHaveLength(0);
        const [audit] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'org.member_joined' and org_id = ${t.id}`;
        expect(audit?.n).toBe("1");
    });

    it("gives the invited role, including admin", async () => {
        const t = await team();
        await invite(t.owner, t.publicId, { email: "dave@example.com", role: "admin" });
        expect((await accept((await h.login(DAVE)).token, lastToken())).status).toBe(200);
        expect(await roleOf(t.id, DAVE)).toBe("admin");
    });

    it("refuses another address, an unverified address and a stranger without a session, leaving the invitation usable", async () => {
        const t = await team();
        await invite(t.owner, t.publicId, { email: "dave@example.com" });
        const secret = lastToken();
        expect((await accept((await h.login(EVE)).token, secret)).status).toBe(400);
        await h.db.database.sql`update users set email_verified_at = null where id = ${DAVE}`;
        expect((await accept((await h.login(DAVE)).token, secret)).status).toBe(400);
        await h.db.database.sql`update users set email_verified_at = now() where id = ${DAVE}`;
        expect((await accept(null, secret)).status).toBe(401);
        expect((await accept((await h.login(DAVE)).token, "x".repeat(43))).status).toBe(400);
        expect((await accept((await h.login(DAVE)).token, secret)).status).toBe(200);
    });
});

describe("accepting, expiry and revocation", () => {
    it("expires exactly seven days after it was sent", async () => {
        const t = await team();
        await invite(t.owner, t.publicId, { email: "dave@example.com" });
        const secret = lastToken();
        h.clock.advance(7 * DAY - 1);
        const early = await h.login(DAVE);
        await invite(t.owner, t.publicId, { email: "eve@example.com" });
        const eveSecret = lastToken();
        h.clock.advance(1);
        expect((await accept(early.token, secret)).status).toBe(400);
        expect((await accept((await h.login(EVE)).token, eveSecret)).status).toBe(200);
    });

    it("stops working when revoked or replaced by a newer invitation to the same address", async () => {
        const t = await team();
        const sent = await invite(t.owner, t.publicId, { email: "dave@example.com" });
        const first = lastToken();
        const id = z.object({ id: z.string() }).parse(await sent.json()).id;
        await invite(t.owner, t.publicId, { email: "dave@example.com" });
        const second = lastToken();
        expect((await accept((await h.login(DAVE)).token, first)).status).toBe(400);
        const carol = await h.login(CAROL);
        expect(
            (await call(carol.token, "DELETE", `/orgs/${t.publicId}/invitations/${id}`)).status,
        ).toBe(403);
        const list = invitationsResponseSchema.parse(
            await (await call(t.owner, "GET", `/orgs/${t.publicId}/invitations`)).json(),
        );
        const pending = list.items[0]?.id ?? "";
        expect(
            (await call(t.owner, "DELETE", `/orgs/${t.publicId}/invitations/${pending}`)).status,
        ).toBe(204);
        expect(
            (await call(t.owner, "DELETE", `/orgs/${t.publicId}/invitations/${pending}`)).status,
        ).toBe(404);
        expect((await accept((await h.login(DAVE)).token, second)).status).toBe(400);
    });
});

describe("accepting, refusals that keep the invitation", () => {
    it("refuses someone who is already a member, without spending the invitation", async () => {
        const t = await team();
        await invite(t.owner, t.publicId, { email: "carol@example.com" });
        const secret = lastToken();
        expect((await accept((await h.login(CAROL)).token, secret)).status).toBe(400);
        const [row] = await h.db.database.sql<
            { accepted_at: Date | null }[]
        >`select accepted_at from org_invitations where org_id = ${t.id}`;
        expect(row?.accepted_at).toBeNull();
    });

    it("refuses when the person already belongs to 20 organizations, keeping the invitation", async () => {
        const t = await team();
        const { sql } = h.db.database;
        for (let n = 0; n < 20; n++) {
            const [org] = await sql<
                { id: string }[]
            >`insert into orgs (kind, slug, name) values ('company', ${`filler-${slugCounter}-${n}`}, 'x') returning id`;
            await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${DAVE}, 'owner')`;
        }
        await invite(t.owner, t.publicId, { email: "dave@example.com" });
        expect((await accept((await h.login(DAVE)).token, lastToken())).status).toBe(400);
        expect(await roleOf(t.id, DAVE)).toBeNull();
        const [row] = await sql<
            { accepted_at: Date | null }[]
        >`select accepted_at from org_invitations where org_id = ${t.id}`;
        expect(row?.accepted_at).toBeNull();
    });
});
