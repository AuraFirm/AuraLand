// Goal: prove organizations and memberships end to end through the real HTTP app and PostgreSQL:
// everyone gets a personal space, creating a team makes the creator its owner, only members can see
// an organization (others get 404), roles limit who may rename, change roles or remove people, an
// organization never loses its last owner (also with simultaneous requests), and the limits hold.

import { membersResponseSchema, orgSchema, orgsResponseSchema } from "@aura/contracts/api/orgs";
import { encodeId } from "@aura/contracts/ids";
import { verifyAuditChain } from "@aura/db/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now()), (${DAVE}, 'dave@example.com', now())`;
    await sql`insert into profiles (user_id, handle, display_name) values (${CAROL}, 'carol', 'Carol'), (${DAVE}, 'dave', 'Dave')`;
});
afterAll(async () => {
    await h.drop();
});

const JSON_HEADERS = { "content-type": "application/json" };
const call = (token: string, method: string, path: string, body?: unknown) =>
    Promise.resolve(
        h.request(path, {
            method,
            headers: browser(token, JSON_HEADERS),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );

let slugCounter = 0;
async function makeOrg(token: string, overrides: Record<string, unknown> = {}) {
    const response = await call(token, "POST", "/orgs", {
        name: "Test Team",
        slug: `team-${++slugCounter}-x`,
        kind: "company",
        ...overrides,
    });
    return response;
}

// A fresh team owned by ALICE with the given extra members. Earlier tests' organizations are
// removed first, so no one runs into the 20-organization limit by accident.
async function teamWith(roles: Array<[string, string]>) {
    const { sql } = h.db.database;
    await sql`delete from orgs where id in (select org_id from memberships where user_id in (${ALICE}, ${BOB}, ${CAROL}, ${DAVE}))`;
    const [org] = await sql<{ id: string }[]>`
        insert into orgs (kind, slug, name) values ('company', ${`team-${++slugCounter}-y`}, 'Test Team') returning id`;
    const orgId = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${orgId}, ${ALICE}, 'owner')`;
    for (const [userId, role] of roles) {
        await sql`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
    }
    const owner = await h.login(ALICE);
    return { orgId: encodeId("org", orgId), ownerToken: owner.token };
}

describe("creating and reading organizations", () => {
    it("makes the creator the owner of a new, unverified organization and audits it", async () => {
        const { token } = await h.login(ALICE);
        const response = await makeOrg(token, {
            name: "Acme University",
            kind: "university",
            data_region: "us",
        });
        expect(response.status).toBe(201);
        const org = orgSchema.parse(await response.json());
        expect(org).toMatchObject({
            role: "owner",
            verification_state: "unverified",
            kind: "university",
            data_region: "us",
        });
        const [row] = await h.db.database.sql<
            { n: string }[]
        >`select count(*) n from audit_log where action = 'org.created' and org_id = ${org.id.slice(4)}`;
        expect(row?.n).toBe("1");
    });

    it("lists only the caller's organizations and shows one to members only", async () => {
        const alice = await h.login(ALICE);
        const bob = await h.login(BOB);
        const org = orgSchema.parse(await (await makeOrg(alice.token)).json());
        const mine = orgsResponseSchema.parse(
            await (await call(alice.token, "GET", "/orgs")).json(),
        );
        expect(mine.items.some((item) => item.id === org.id)).toBe(true);
        const theirs = orgsResponseSchema.parse(
            await (await call(bob.token, "GET", "/orgs")).json(),
        );
        expect(theirs.items.some((item) => item.id === org.id)).toBe(false);
        expect((await call(alice.token, "GET", `/orgs/${org.id}`)).status).toBe(200);
        expect((await call(bob.token, "GET", `/orgs/${org.id}`)).status).toBe(404);
        expect((await call(alice.token, "GET", "/orgs/not-an-id")).status).toBe(400);
    });

    it("refuses bad input, taken addresses, the personal-space shape and kinds nobody may create", async () => {
        const { token } = await h.login(ALICE);
        for (const bad of [
            { name: "" },
            { slug: "Bad Slug" },
            { slug: "admin" },
            { kind: "personal" },
            { kind: "platform" },
            { data_region: "mars" },
            { extra: 1 },
        ]) {
            expect((await makeOrg(token, bad)).status, JSON.stringify(bad)).toBe(400);
        }
        const first = await makeOrg(token, { slug: "taken-address" });
        expect(first.status).toBe(201);
        expect((await makeOrg(token, { slug: "taken-address" })).status).toBe(409);
        expect((await makeOrg(token, { slug: "p-0123456789" })).status).toBe(409);
        expect(
            (
                await h.request("/orgs", {
                    method: "POST",
                    headers: browser(null, JSON_HEADERS),
                    body: "{}",
                })
            ).status,
        ).toBe(401);
    });
});

describe("creating organizations, limits", () => {
    it("limits creation to five a day per person, and 20 organizations in all", async () => {
        const { token } = await h.login(CAROL);
        for (let n = 0; n < 5; n++) expect((await makeOrg(token)).status).toBe(201);
        const sixth = await makeOrg(token);
        expect(sixth.status).toBe(429);
        h.clock.advance(24 * 3600 * 1000);
        // Owning a team makes a session privileged (30-minute idle limit), so sign in again each day.
        for (let day = 0; day < 4; day++) {
            const { token: dave } = await h.login(DAVE);
            for (let n = 0; n < 5; n++)
                expect((await makeOrg(dave)).status, `day ${day} org ${n}`).toBe(201);
            h.clock.advance(24 * 3600 * 1000);
        }
        expect((await makeOrg((await h.login(DAVE)).token)).status).toBe(409);
    });
});

describe("renaming and listing members", () => {
    it("lets owners and admins rename, refuses members with 403 and strangers with 404", async () => {
        const { orgId, ownerToken } = await teamWith([
            [BOB, "admin"],
            [CAROL, "member"],
        ]);
        const bob = await h.login(BOB);
        const carol = await h.login(CAROL);
        const dave = await h.login(DAVE);
        const rename = (token: string) =>
            call(token, "PATCH", `/orgs/${orgId}`, { name: "Renamed" });
        expect((await rename(ownerToken)).status).toBe(200);
        expect((await rename(bob.token)).status).toBe(200);
        expect((await rename(carol.token)).status).toBe(403);
        expect((await rename(dave.token)).status).toBe(404);
        expect((await call(ownerToken, "PATCH", `/orgs/${orgId}`, { name: "" })).status).toBe(400);
        expect(
            (await call(ownerToken, "PATCH", `/orgs/${orgId}`, { slug: "new-slug" })).status,
        ).toBe(400);
    });

    it("shows members with their names to members only", async () => {
        const { orgId, ownerToken } = await teamWith([[CAROL, "member"]]);
        const list = membersResponseSchema.parse(
            await (await call(ownerToken, "GET", `/orgs/${orgId}/members`)).json(),
        );
        expect(list.items.map((item) => [item.handle, item.role])).toEqual([
            ["alice", "owner"],
            ["carol", "member"],
        ]);
        const dave = await h.login(DAVE);
        expect((await call(dave.token, "GET", `/orgs/${orgId}/members`)).status).toBe(404);
        const carol = await h.login(CAROL);
        expect((await call(carol.token, "GET", `/orgs/${orgId}/members`)).status).toBe(200);
    });
});

describe("changing roles and removing people", () => {
    it("lets only owners change roles, and audits it", async () => {
        const { orgId, ownerToken } = await teamWith([
            [BOB, "admin"],
            [CAROL, "member"],
        ]);
        const bob = await h.login(BOB);
        const path = `/orgs/${orgId}/members/${encodeId("usr", CAROL)}`;
        expect((await call(bob.token, "PATCH", path, { role: "admin" })).status).toBe(403);
        expect((await call(ownerToken, "PATCH", path, { role: "admin" })).status).toBe(204);
        expect((await call(ownerToken, "PATCH", path, { role: "boss" })).status).toBe(400);
        const [row] = await h.db.database.sql<
            { detail: unknown }[]
        >`select detail from audit_log where action = 'org.member_role_changed' and org_id = ${orgId.slice(4)}`;
        expect(row?.detail).toEqual({ from: "member", to: "admin" });
        const stranger = await call(
            ownerToken,
            "PATCH",
            `/orgs/${orgId}/members/${encodeId("usr", DAVE)}`,
            { role: "admin" },
        );
        expect(stranger.status).toBe(404);
    });

    it("lets admins remove plain members only, owners anyone, and anyone leave", async () => {
        const { orgId, ownerToken } = await teamWith([
            [BOB, "admin"],
            [CAROL, "member"],
            [DAVE, "member"],
        ]);
        const bob = await h.login(BOB);
        const carol = await h.login(CAROL);
        const remove = (token: string, user: string) =>
            call(token, "DELETE", `/orgs/${orgId}/members/${encodeId("usr", user)}`);
        expect((await remove(bob.token, ALICE)).status).toBe(403);
        expect((await remove(carol.token, BOB)).status).toBe(403);
        expect((await remove(bob.token, CAROL)).status).toBe(204);
        expect((await remove(bob.token, CAROL)).status).toBe(404);
        expect((await remove((await h.login(DAVE)).token, DAVE)).status).toBe(204);
        expect((await remove(ownerToken, BOB)).status).toBe(204);
        expect((await call(carol.token, "GET", `/orgs/${orgId}`)).status).toBe(404);
    });

    it("keeps the last owner: demoting or removing them answers 409", async () => {
        const { orgId, ownerToken } = await teamWith([[BOB, "admin"]]);
        const alice = encodeId("usr", ALICE);
        expect(
            (await call(ownerToken, "PATCH", `/orgs/${orgId}/members/${alice}`, { role: "admin" }))
                .status,
        ).toBe(409);
        expect((await call(ownerToken, "DELETE", `/orgs/${orgId}/members/${alice}`)).status).toBe(
            409,
        );
        expect((await call(ownerToken, "GET", `/orgs/${orgId}`)).status).toBe(200);
    });

    it("lets exactly one of two simultaneous owner departures succeed", async () => {
        for (let round = 0; round < 3; round++) {
            const { orgId, ownerToken } = await teamWith([[BOB, "owner"]]);
            const bob = await h.login(BOB);
            const leave = (token: string, user: string) =>
                call(token, "DELETE", `/orgs/${orgId}/members/${encodeId("usr", user)}`);
            const statuses = (await Promise.all([leave(ownerToken, ALICE), leave(bob.token, BOB)]))
                .map((r) => r.status)
                .sort();
            expect(statuses, `round ${round}`).toEqual([204, 409]);
        }
    });
});

describe("personal spaces and the audit trail", () => {
    it("gives every new account a personal space they own, and nobody else can see it", async () => {
        const started = await h
            .app({ AURA_TRUST_EDGE_REQUEST_ID: "true" })
            .request("/api/v1/auth/email/start", {
                method: "POST",
                headers: browser(null, { ...JSON_HEADERS, "x-forwarded-for": "198.51.100.77" }),
                body: JSON.stringify({ email: "newcomer@example.com" }),
            });
        const binding =
            started.headers
                .getSetCookie()
                .find((c) => c.startsWith("aura_login="))
                ?.split(";")[0] ?? "";
        const text = h.mail.outbox.at(-1)?.text ?? "";
        const token = /#t=([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? "";
        const verified = await h
            .app({ AURA_TRUST_EDGE_REQUEST_ID: "true" })
            .request("/api/v1/auth/email/verify", {
                method: "POST",
                headers: browser(null, {
                    ...JSON_HEADERS,
                    "x-forwarded-for": "198.51.100.77",
                    cookie: binding,
                }),
                body: JSON.stringify({ token }),
            });
        const session =
            verified.headers
                .getSetCookie()
                .find((c) => c.startsWith("aura_session="))
                ?.split(";")[0]
                ?.split("=")[1] ?? "";
        const mine = orgsResponseSchema.parse(await (await call(session, "GET", "/orgs")).json());
        expect(mine.items.map((item) => [item.kind, item.role])).toEqual([["personal", "owner"]]);
        expect(mine.items[0]?.slug).toMatch(/^p-[0-9a-f]{10}$/);
        const alice = await h.login(ALICE);
        expect((await call(alice.token, "GET", `/orgs/${mine.items[0]?.id}`)).status).toBe(404);
    });

    it("keeps the audit chain valid after all of the above", async () => {
        expect((await verifyAuditChain(h.db.database.sql)).ok).toBe(true);
    });
});
