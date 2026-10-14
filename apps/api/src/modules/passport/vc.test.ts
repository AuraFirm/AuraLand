// Goal: a credential we sign verifies for a verifier that shares none of our code, and every way of damaging it is
// caught. Method: sign with the development signer, verify with our verifier (jose) and with did-jwt, an independent
// library with its own JWT, key and DID handling; then tamper, swap keys, expire, and attack the algorithm.

import { randomBytes } from "node:crypto";
import { makeUuidV7 } from "@aura/contracts/ids";
import { verifyJWT } from "did-jwt";
import { describe, expect, it } from "vitest";
import { createDevelopmentSigner } from "../../platform/signer.ts";
import { didDocument, issuerDid, type PublicKey } from "./documents.ts";
import { issueCredentialJwt } from "./issue.ts";
import { verifyCredentialJwt } from "./verify.ts";

const ORIGIN = "https://passport.example";
const DID = issuerDid(ORIGIN);
const NOW = Date.UTC(2026, 10, 1, 12);
const signer = createDevelopmentSigner({ keyId: "dev-vc-1", appEnvironment: "test" });
const keyOf = (s: typeof signer, status: PublicKey["status"] = "active"): PublicKey => ({
    kid: s.keyId,
    alg: s.alg,
    status,
    jwk: s.publicJwk(),
});
const id = () => makeUuidV7(NOW, randomBytes(10));

const claim = {
    kind: "exam_result",
    event_title: "Lab exam",
    host_name: "Uni",
    points_band: "75-100",
    ai_mode: "ai_free",
    released_at: new Date(NOW).toISOString(),
} as const;
const sign = (over: { expiresAtMs?: number | null; nowMs?: number } = {}) =>
    issueCredentialJwt(signer, {
        id: id(),
        subject: id(),
        issuerDid: DID,
        issuerName: "AuraLand (development)",
        claim,
        assurance: 1,
        eventId: id(),
        issuedAtMs: over.nowMs ?? NOW,
        expiresAtMs: over.expiresAtMs === undefined ? NOW + 86_400_000 : over.expiresAtMs,
        status: { listUrl: `${ORIGIN}/status/0`, index: 7 },
    });

describe("issuing and verifying", () => {
    it("verifies with our verifier and reads back what was signed", async () => {
        const jwt = await sign();
        const result = await verifyCredentialJwt(jwt, [keyOf(signer)], NOW + 1000);
        expect(result).toMatchObject({
            outcome: "valid",
            kid: "dev-vc-1",
            environment: "development",
            assurance: 1,
        });
        if (result.outcome === "invalid") throw new Error("expected a valid credential");
        expect(result.status).toEqual({ listUrl: `${ORIGIN}/status/0`, index: 7 });
    });

    it("verifies with an independent library through the DID document alone", async () => {
        const jwt = await sign();
        const document = didDocument(DID, [keyOf(signer)]);
        const resolver = {
            resolve: async () => ({
                didDocument: document,
                didDocumentMetadata: {},
                didResolutionMetadata: {},
            }),
        };
        const verified = await verifyJWT(jwt, {
            resolver,
            policies: { now: Math.floor(NOW / 1000) + 1 },
        });
        expect(verified.verified).toBe(true);
        expect(verified.issuer).toBe(DID);
        // The same independent check refuses a damaged copy.
        const [h, p, s] = jwt.split(".");
        const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p ?? "", "base64url").toString()), aura_assurance: 3 })).toString("base64url")}.${s}`;
        await expect(verifyJWT(forged, { resolver })).rejects.toThrow();
    });

    it("says expired after the expiry instant, valid just before, and not valid yet before issuance", async () => {
        const jwt = await sign({ expiresAtMs: NOW + 10_000 });
        const keys = [keyOf(signer)];
        expect((await verifyCredentialJwt(jwt, keys, NOW + 9_999)).outcome).toBe("valid");
        expect((await verifyCredentialJwt(jwt, keys, NOW + 10_000)).outcome).toBe("expired");
        expect(await verifyCredentialJwt(jwt, keys, NOW - 2000)).toMatchObject({
            outcome: "invalid",
            reason: "not valid yet",
        });
        const forever = await sign({ expiresAtMs: null });
        expect((await verifyCredentialJwt(forever, keys, NOW + 1e12)).outcome).toBe("valid");
    });
});

describe("damage and attacks", () => {
    it("refuses tampering, another key, a retired-then-revoked key, and missing keys", async () => {
        const jwt = await sign();
        const [h, p, s] = jwt.split(".");
        const payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString());
        const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, aura_assurance: 3 })).toString("base64url")}.${s}`;
        expect(await verifyCredentialJwt(forged, [keyOf(signer)], NOW)).toMatchObject({
            outcome: "invalid",
        });
        const other = createDevelopmentSigner({ keyId: "dev-vc-1", appEnvironment: "test" }); // same kid, different key
        expect(await verifyCredentialJwt(jwt, [keyOf(other)], NOW)).toMatchObject({
            outcome: "invalid",
            reason: "signature does not match",
        });
        expect(await verifyCredentialJwt(jwt, [keyOf(signer, "revoked")], NOW)).toMatchObject({
            outcome: "invalid",
            reason: "unknown or revoked key",
        });
        expect(await verifyCredentialJwt(jwt, [], NOW)).toMatchObject({ outcome: "invalid" });
        expect((await verifyCredentialJwt(jwt, [keyOf(signer, "retired")], NOW)).outcome).toBe(
            "valid",
        ); // rotation keeps old credentials alive
    });

    it("refuses algorithm tricks and garbage", async () => {
        const jwt = await sign();
        const [, p, s] = jwt.split(".");
        const header = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const none = `${header({ alg: "none", kid: `${DID}#dev-vc-1` })}.${p}.`;
        const hs = `${header({ alg: "HS256", kid: `${DID}#dev-vc-1` })}.${p}.${s}`;
        for (const bad of [
            none,
            hs,
            "",
            "a.b.c",
            "x".repeat(9000),
            `${header({ alg: "ES256" })}.${p}.${s}`,
        ])
            expect(
                (await verifyCredentialJwt(bad, [keyOf(signer)], NOW)).outcome,
                bad.slice(0, 20),
            ).toBe("invalid");
    });
});

describe("the public documents", () => {
    it("list active and retired keys, leave out revoked ones, and carry no private member", () => {
        const a = createDevelopmentSigner({ keyId: "dev-a", appEnvironment: "test" });
        const b = createDevelopmentSigner({ keyId: "dev-b", appEnvironment: "test" });
        const c = createDevelopmentSigner({ keyId: "dev-c", appEnvironment: "test" });
        const document = didDocument(DID, [
            keyOf(a, "retired"),
            keyOf(b, "active"),
            keyOf(c, "revoked"),
        ]);
        expect(document.verificationMethod.map((m) => m.id)).toEqual([
            `${DID}#dev-a`,
            `${DID}#dev-b`,
        ]);
        expect(JSON.stringify(document)).not.toContain('"d"');
        expect(issuerDid("http://localhost:3000")).toBe("did:web:localhost%3A3000");
    });
});
