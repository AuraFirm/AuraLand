// Goal: employer access through the real HTTP app and PostgreSQL. Only a platform administrator approves an
// employer; only a member of an approved employer with a fresh passkey check may search or open a report; only PUBLIC,
// unrevoked credentials appear, and they name no one; every report is logged and the holder sees which organization
// looked and why, never which person; revoking the employer ends access.

import {
    credentialViewsResponseSchema,
    employerReportSchema,
    employerSearchResponseSchema,
} from "@aura/contracts/api/passport";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import { issuerDid } from "./modules/passport/documents.ts";
import { issueOnce } from "./modules/passport/issuing.ts";
import { systemRng } from "./platform/rng.ts";
import { createDevelopmentSigner } from "./platform/signer.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // holds the credentials
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // member of a company that was never approved
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const signer = createDevelopmentSigner({ keyId: "dev-employer-1", appEnvironment: "test" });
let h: Harness;
let acme = "";
let other = "";
const ids: Record<string, string> = {};

// `stale` means the person signed in more than fifteen minutes ago and has not confirmed with their passkey since.
const call = async (user: string | null, method: string, path: string, stale = false) => {
    const token = user === null ? null : (await h.login(user)).token;
    if (stale) h.clock.advance(16 * 60_000);
    return h.request(path, { method, headers: browser(token) });
};
const acmePath = () => encodeId("org", acme);

// Four credentials of CAROL's in four states: public, private, link-only and public-but-revoked.
async function seedCredentials(sql: Harness["db"]["database"]["sql"]) {
    const [host] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'emp-uni', 'Uni') returning id`;
    const work = <T>(fn: Parameters<typeof withRequestContext<T>>[2]) =>
        withRequestContext(sql, WORKER, fn);
    await work(
        (tx) =>
            tx`select register_signing_key('dev-employer-1', 'ES256', ${tx.json(signer.publicJwk())}, 'development', ${new Date(h.clock.nowUnixMs())})`,
    );
    for (const [name, n] of [
        ["public", 1],
        ["private", 2],
        ["link", 3],
        ["revoked", 4],
    ] as const) {
        await work((tx) =>
            issueOnce(
                tx,
                {
                    clock: h.clock,
                    rng: systemRng,
                    signer,
                    issuerDid: issuerDid(ORIGIN),
                    issuerName: "AuraLand (development)",
                    publicOrigin: ORIGIN,
                },
                {
                    subjectUserId: CAROL,
                    issuerOrgId: host?.id ?? "",
                    eventId: `018f0000-0000-7000-8000-00000000ab0${n}`,
                    assurance: 0,
                    expiresAtMs: null,
                    claim: {
                        kind: "contest_rank",
                        event_title: `Contest ${name}`,
                        host_name: "Uni",
                        rank: n,
                        participants: 9,
                        solved: 1,
                        finalized_at: new Date(h.clock.nowUnixMs()).toISOString(),
                    },
                },
            ),
        );
        const [row] = await sql<
            { id: string }[]
        >`select id from credentials where event_id = ${`018f0000-0000-7000-8000-00000000ab0${n}`}`;
        ids[name] = encodeId("crd", row?.id ?? "");
    }
    await sql`update credentials set visibility = 'public' where id in (select id from credentials where claim->>'event_title' in ('Contest public', 'Contest revoked'))`;
    await sql`update credentials set visibility = 'link' where claim->>'event_title' = 'Contest link'`;
    await sql`update credentials set revoked_at = now(), revoke_reason = 'wrong' where claim->>'event_title' = 'Contest revoked'`;
}

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [a] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'acme', 'Acme Hiring') returning id`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'other', 'Other Co') returning id`;
    acme = a?.id ?? "";
    other = o?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${acme}, ${BOB}, 'member'), (${other}, ${DAVE}, 'member')`;
    await seedCredentials(sql);
});
afterAll(async () => {
    await h.drop();
});

describe("approving employers", () => {
    it("is the platform administrator's, with a fresh passkey check, and nobody else's", async () => {
        expect((await call(BOB, "PUT", `/admin/employers/${acmePath()}`)).status).toBe(404);
        expect((await call(ALICE, "PUT", `/admin/employers/${acmePath()}`, true)).status).toBe(403); // no second factor
        expect((await call(null, "PUT", `/admin/employers/${acmePath()}`)).status).toBe(401);
        expect(
            (
                await call(
                    ALICE,
                    "PUT",
                    `/admin/employers/${encodeId("org", "018f0000-0000-7000-8000-0000000000ee")}`,
                )
            ).status,
        ).toBe(404);
        expect((await call(BOB, "GET", `/employer/credentials?org_id=${acmePath()}`)).status).toBe(
            404,
        ); // not approved yet
        expect((await call(ALICE, "PUT", `/admin/employers/${acmePath()}`)).status).toBe(204);
    });
});

describe("search and reports", () => {
    it("lists only public, unrevoked credentials, naming no one, to a member with a second factor", async () => {
        const search = await call(BOB, "GET", `/employer/credentials?org_id=${acmePath()}`);
        expect(search.status).toBe(200);
        const body = employerSearchResponseSchema.parse(await search.json());
        expect(body.credentials.map((c) => c.id)).toEqual([ids["public"]]);
        const text = JSON.stringify(body);
        expect(text).not.toContain(CAROL);
        expect(text).not.toContain("carol@");
        expect(
            (await call(BOB, "GET", `/employer/credentials?org_id=${acmePath()}`, true)).status,
        ).toBe(403);
        expect(
            (await call(DAVE, "GET", `/employer/credentials?org_id=${encodeId("org", other)}`))
                .status,
        ).toBe(404); // never approved
        expect((await call(DAVE, "GET", `/employer/credentials?org_id=${acmePath()}`)).status).toBe(
            404,
        ); // not a member of Acme
        expect(
            (await call(BOB, "GET", `/employer/credentials?org_id=${acmePath()}&kind=nonsense`))
                .status,
        ).toBe(400);
    });

    it("opens a report on a public credential only, and logs every look", async () => {
        const open = (
            credential: string,
            purpose = "hiring_screening",
            user = BOB,
            stale = false,
        ) =>
            call(
                user,
                "GET",
                `/employer/reports/${credential}?org_id=${acmePath()}&purpose=${purpose}`,
                stale,
            );
        const ok = await open(ids["public"] ?? "");
        expect(ok.status).toBe(200);
        const report = employerReportSchema.parse(await ok.json());
        expect(report).toMatchObject({
            outcome: "valid",
            environment: "development",
            logged: true,
            kind: "contest_rank",
        });
        expect(report.summary).toContain("Rank 1 of 9");
        expect(
            employerReportSchema.parse(await (await open(ids["revoked"] ?? "")).json()).outcome,
        ).toBe("revoked");
        for (const hidden of ["private", "link"])
            expect((await open(ids[hidden] ?? "")).status, hidden).toBe(404);
        expect((await open(ids["public"] ?? "", "snooping")).status).toBe(400);
        expect((await open(ids["public"] ?? "", "verification", BOB, true)).status).toBe(403);
        expect((await open(ids["public"] ?? "", "verification", DAVE)).status).toBe(404);
        const [logged] = await h.db.database.sql<
            { n: number }[]
        >`select count(*)::int as n from credential_views`;
        expect(logged?.n).toBe(2); // the two that opened; none for private, link, a bad purpose, no factor, a stranger
        // Each report that was opened is one billable event for the employer's organization, written by the same transaction.
        const [metered] = await h.db.database.sql<
            { n: number }[]
        >`select count(*)::int as n from usage_events where kind = 'employer_report'`;
        expect(metered?.n).toBe(2);
    });
});

describe("what the holder sees", () => {
    it("which organization looked, why and when; never the person; and only their own", async () => {
        const mine = await call(CAROL, "GET", `/credentials/${ids["public"]}/views`);
        const views = credentialViewsResponseSchema.parse(await mine.json()).views;
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ org_name: "Acme Hiring", purpose: "hiring_screening" });
        expect(JSON.stringify(views)).not.toContain(BOB);
        expect((await call(BOB, "GET", `/credentials/${ids["public"]}/views`)).status).toBe(404); // not their credential
        const asHolderSql = await withRequestContext(
            h.db.database.sql,
            { role: "aura_app", actorKind: "user", userId: CAROL, orgIds: [] },
            (tx) => tx`select * from credential_views`,
        );
        expect(asHolderSql).toEqual([]); // the table itself is not the holder's to read
        await expect(
            h.db.database.sql`update credential_views set purpose = 'verification'`,
        ).rejects.toThrow(/kept as it was/);
    });
});

describe("ending access", () => {
    it("stops an employer at once when the platform administrator revokes it", async () => {
        expect((await call(ALICE, "DELETE", `/admin/employers/${acmePath()}`)).status).toBe(204);
        expect((await call(BOB, "GET", `/employer/credentials?org_id=${acmePath()}`)).status).toBe(
            404,
        );
        expect((await call(ALICE, "DELETE", `/admin/employers/${acmePath()}`)).status).toBe(404); // already revoked
    });
});
