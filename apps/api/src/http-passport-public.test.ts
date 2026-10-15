// Goal: the public Passport endpoints answer from the published files alone. Method: issue and publish through the
// real code with the database up, then close the database connection and ask the real HTTP app: verification, the
// DID document, the key set and the revocation list must still answer, with cacheable headers; bad ids are 404.

import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import { issuerDid } from "./modules/passport/documents.ts";
import { issueOnce } from "./modules/passport/issuing.ts";
import { publishPassport } from "./modules/passport/publish.ts";
import { systemRng } from "./platform/rng.ts";
import { createDevelopmentSigner } from "./platform/signer.ts";

const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
let h: Harness;
let credential = "";

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    const signer = createDevelopmentSigner({ keyId: "dev-http-1", appEnvironment: "test" });
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'pub-http', 'Uni') returning id`;
    const work = <T>(fn: Parameters<typeof withRequestContext<T>>[2]) =>
        withRequestContext(sql, WORKER, fn);
    await work(
        (tx) =>
            tx`select register_signing_key('dev-http-1', 'ES256', ${tx.json(signer.publicJwk())}, 'development', ${new Date(h.clock.nowUnixMs())})`,
    );
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
                subjectUserId: "018f0000-0000-7000-8000-0000000000a1",
                issuerOrgId: org?.id ?? "",
                eventId: "018f0000-0000-7000-8000-00000000ee01",
                assurance: 0,
                expiresAtMs: null,
                claim: {
                    kind: "contest_rank",
                    event_title: "Open",
                    host_name: "Uni",
                    rank: 1,
                    participants: 5,
                    solved: 3,
                    finalized_at: new Date(h.clock.nowUnixMs()).toISOString(),
                },
            },
        ),
    );
    const [row] = await sql<
        { id: string }[]
    >`update credentials set visibility = 'public' returning id`;
    credential = encodeId("crd", row?.id ?? "");
    await work((tx) =>
        publishPassport(tx, {
            clock: h.clock,
            storage: h.storage,
            signer,
            issuerDid: issuerDid(ORIGIN),
            publicOrigin: ORIGIN,
        }),
    );
});
afterAll(async () => {
    await h.drop();
});

const get = (path: string) => h.app().request(`/api/public${path}`);

describe("with the database closed", () => {
    it("still verifies a public credential and serves the documents a verifier needs", async () => {
        await h.db.database.close(0);
        await expect(h.db.database.sql`select 1`).rejects.toThrow();

        const verified = await get(`/credentials/${credential}`);
        expect(verified.status).toBe(200);
        expect(verified.headers.get("cache-control")).toContain("stale-if-error");
        expect(await verified.json()).toMatchObject({
            outcome: "valid",
            status_known: true,
            name: "Open",
        });

        const did = await get("/did.json");
        expect(did.status).toBe(200);
        expect(did.headers.get("content-type")).toContain("application/did+json");
        expect(z.object({ id: z.string() }).parse(await did.json()).id).toBe(
            "did:web:localhost%3A3000",
        );
        expect(
            z.object({ keys: z.array(z.unknown()) }).parse(await (await get("/jwks.json")).json())
                .keys,
        ).toHaveLength(1);
        const list = await get("/status-lists/0");
        expect(list.status).toBe(200);
        expect(list.headers.get("content-type")).toContain("application/vc+jwt");
        expect((await list.text()).split(".")).toHaveLength(3);
    });

    it("answers unknown for an id nobody has, and 404 for things that are not ids", async () => {
        const unknown = await get(
            `/credentials/${encodeId("crd", "018f0000-0000-7000-8000-00000000ffff")}`,
        );
        expect(unknown.status).toBe(200);
        expect(await unknown.json()).toMatchObject({ outcome: "unknown", status_known: false });
        for (const path of [
            "/credentials/abc",
            "/credentials/crd_nope",
            "/status-lists/x",
            "/status-lists/99",
            "/nothing",
        ]) {
            expect((await get(path)).status, path).toBe(404);
        }
    });
});
