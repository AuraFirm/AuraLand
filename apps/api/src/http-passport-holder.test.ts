// Goal: a holder's controls through the real HTTP app and PostgreSQL. A person sees and changes only their own
// credentials; credentials are private until chosen; a link works for whoever holds it until it expires or is
// revoked or the credential goes private, and never shows a stranger anything else; the secret is not stored.

import { createHash } from "node:crypto";
import {
    createShareResponseSchema,
    myCredentialsResponseSchema,
    verifyResponseSchema,
} from "@aura/contracts/api/passport";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import { issuerDid } from "./modules/passport/documents.ts";
import { issueOnce } from "./modules/passport/issuing.ts";
import { publishPassport } from "./modules/passport/publish.ts";
import { systemRng } from "./platform/rng.ts";
import { createDevelopmentSigner } from "./platform/signer.ts";

const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const DAY = 86_400_000;
const signer = createDevelopmentSigner({ keyId: "dev-holder-1", appEnvironment: "test" });
let h: Harness;
let alice = "";
let bob = "";

const work = <T>(fn: Parameters<typeof withRequestContext<T>>[2]) =>
    withRequestContext(h.db.database.sql, WORKER, fn);
const publish = () =>
    work((tx) =>
        publishPassport(tx, {
            clock: h.clock,
            storage: h.storage,
            signer,
            issuerDid: issuerDid(ORIGIN),
            publicOrigin: ORIGIN,
        }),
    );
const call = async (user: string | null, method: string, path: string, body?: unknown) =>
    h.request(path, {
        method,
        headers: browser(
            user === null ? null : (await h.login(user)).token,
            body === undefined ? {} : { "content-type": "application/json" },
        ),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const verify = async (id: string, token?: string) => {
    const query = token === undefined ? "" : `?s=${token}`;
    const response = await h.app().request(`/api/public/credentials/${id}${query}`);
    return verifyResponseSchema.parse(await response.json());
};
const tokenOf = (url: string) => new URL(url).searchParams.get("s") ?? "";

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'holder-uni', 'Uni') returning id`;
    await work(
        (tx) =>
            tx`select register_signing_key('dev-holder-1', 'ES256', ${tx.json(signer.publicJwk())}, 'development', ${new Date(h.clock.nowUnixMs())})`,
    );
    for (const [n, user] of [
        [1, ALICE],
        [2, BOB],
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
                    subjectUserId: user,
                    issuerOrgId: org?.id ?? "",
                    eventId: `018f0000-0000-7000-8000-00000000ee0${n}`,
                    assurance: 0,
                    expiresAtMs: null,
                    claim: {
                        kind: "contest_rank",
                        event_title: `Contest ${n}`,
                        host_name: "Uni",
                        rank: n,
                        participants: 9,
                        solved: 1,
                        finalized_at: new Date(h.clock.nowUnixMs()).toISOString(),
                    },
                },
            ),
        );
    }
    const rows = await sql<
        { id: string; subject_user_id: string }[]
    >`select id, subject_user_id from credentials`;
    alice = encodeId("crd", rows.find((r) => r.subject_user_id === ALICE)?.id ?? "");
    bob = encodeId("crd", rows.find((r) => r.subject_user_id === BOB)?.id ?? "");
});
afterAll(async () => {
    await h.drop();
});

const mine = async (user: string) =>
    myCredentialsResponseSchema.parse(await (await call(user, "GET", "/me/credentials")).json())
        .credentials;

describe("a person's own credentials", () => {
    it("lists only theirs, private to begin with, and needs a signed-in person", async () => {
        const list = await mine(ALICE);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            id: alice,
            visibility: "private",
            revoked: false,
            shares: [],
        });
        expect(JSON.stringify(list)).not.toContain(bob);
        expect((await call(null, "GET", "/me/credentials")).status).toBe(401);
    });

    it("lets only the holder change visibility, and only to the three values", async () => {
        expect(
            (await call(BOB, "PUT", `/credentials/${alice}/visibility`, { visibility: "public" }))
                .status,
        ).toBe(404);
        expect(
            (
                await call(ALICE, "PUT", `/credentials/${alice}/visibility`, {
                    visibility: "everyone",
                })
            ).status,
        ).toBe(400);
        expect(
            (await call(ALICE, "PUT", `/credentials/${alice}/visibility`, { visibility: "link" }))
                .status,
        ).toBe(204);
        expect((await mine(ALICE))[0]?.visibility).toBe("link");
        expect(
            (await call(null, "PUT", `/credentials/${alice}/visibility`, { visibility: "public" }))
                .status,
        ).toBe(401);
    });
});

describe("links", () => {
    it("create a link that shows the credential to its holder-of-the-link only, and keep no secret", async () => {
        await call(ALICE, "PUT", `/credentials/${alice}/visibility`, { visibility: "link" });
        const created = await call(ALICE, "POST", `/credentials/${alice}/shares`, { days: 3 });
        expect(created.status).toBe(201);
        const share = createShareResponseSchema.parse(await created.json());
        const token = tokenOf(share.url);
        expect(share.url).toBe(`${ORIGIN}/verify/${alice}?s=${token}`);
        const [stored] = await h.db.database.sql<
            { token_hash: Buffer }[]
        >`select token_hash from credential_shares`;
        expect(stored?.token_hash.equals(createHash("sha256").update(token).digest())).toBe(true);
        expect(
            JSON.stringify(await h.db.database.sql`select * from credential_shares`),
        ).not.toContain(token);

        await publish();
        expect(await verify(alice)).toMatchObject({ outcome: "unknown" }); // link-only: not public
        expect(await verify(alice, token)).toMatchObject({ outcome: "valid", name: "Contest 1" });
        expect(
            await verify(alice, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`),
        ).toMatchObject({ outcome: "unknown" });
        expect(
            await verify(encodeId("crd", "018f0000-0000-7000-8000-00000000ffff"), token),
        ).toMatchObject({ outcome: "invalid", reason: expect.stringContaining("another") }); // a link opens its own credential only
    });

    it("stop at their expiry even before the next publish, and when revoked or when the credential goes private", async () => {
        const first = createShareResponseSchema.parse(
            await (await call(ALICE, "POST", `/credentials/${alice}/shares`, { days: 1 })).json(),
        );
        const long = createShareResponseSchema.parse(
            await (await call(ALICE, "POST", `/credentials/${alice}/shares`, { days: 10 })).json(),
        );
        await publish();
        expect((await verify(alice, tokenOf(first.url))).outcome).toBe("valid");
        h.clock.advance(DAY + 1000);
        expect((await verify(alice, tokenOf(first.url))).outcome).toBe("unknown"); // expired, file still there
        expect((await verify(alice, tokenOf(long.url))).outcome).toBe("valid");

        expect(
            (await call(BOB, "DELETE", `/credentials/${alice}/shares/${long.share_id}`)).status,
        ).toBe(404);
        expect(
            (await call(ALICE, "DELETE", `/credentials/${alice}/shares/${long.share_id}`)).status,
        ).toBe(204);
        await publish();
        expect((await verify(alice, tokenOf(long.url))).outcome).toBe("unknown");

        const again = createShareResponseSchema.parse(
            await (await call(ALICE, "POST", `/credentials/${alice}/shares`, {})).json(),
        );
        await publish();
        expect((await verify(alice, tokenOf(again.url))).outcome).toBe("valid");
        await call(ALICE, "PUT", `/credentials/${alice}/visibility`, { visibility: "private" });
        await publish();
        expect((await verify(alice, tokenOf(again.url))).outcome).toBe("unknown"); // private means nobody
    });
});

describe("limits and publication", () => {
    it("are limited to five live links and a sensible lifetime, and are the holder's alone", async () => {
        await call(ALICE, "PUT", `/credentials/${alice}/visibility`, { visibility: "link" });
        expect((await call(BOB, "POST", `/credentials/${alice}/shares`, { days: 2 })).status).toBe(
            404,
        );
        for (const days of [0, 31, 1.5])
            expect(
                (await call(ALICE, "POST", `/credentials/${alice}/shares`, { days })).status,
                String(days),
            ).toBe(400);
        const live =
            (await mine(ALICE))[0]?.shares.filter(
                (s) => !s.revoked && Date.parse(s.expires_at) > h.clock.nowUnixMs(),
            ).length ?? 0;
        for (let n = live; n < 5; n++)
            expect(
                (await call(ALICE, "POST", `/credentials/${alice}/shares`, { days: 2 })).status,
            ).toBe(201);
        expect(
            (await call(ALICE, "POST", `/credentials/${alice}/shares`, { days: 2 })).status,
        ).toBe(409);
    });

    it("publish a public credential for everyone and audit what the holder did", async () => {
        await call(ALICE, "PUT", `/credentials/${alice}/visibility`, { visibility: "public" });
        await publish();
        expect(await verify(alice)).toMatchObject({ outcome: "valid" });
        const [audit] = await h.db.database.sql<
            { n: number }[]
        >`select count(*)::int as n from audit_log where action like 'passport.%'`;
        expect(audit?.n).toBeGreaterThanOrEqual(6);
    });
});
