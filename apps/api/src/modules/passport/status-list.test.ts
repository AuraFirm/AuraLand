// Goal: the revocation list sets exactly the bits of the revoked credentials, reads back the same, signs, and
// cannot be abused. Method: edges (first and last bit, byte boundaries), a golden encoding, 300 random sets,
// a compression bomb, and a signed list that is replaced, re-addressed or signed by a revoked key.

import { gzipSync } from "node:zlib";
import { STATUS_LIST_ENTRIES } from "@aura/contracts/limits";
import { describe, expect, it } from "vitest";
import { createDevelopmentSigner } from "../../platform/signer.ts";
import type { PublicKey } from "./documents.ts";
import {
    encodeStatusList,
    isRevokedIn,
    readStatusList,
    signStatusList,
    verifyStatusList,
} from "./status-list.ts";

const URL0 = "https://passport.example/passport/status/0";
const DID = "did:web:passport.example";
const signer = createDevelopmentSigner({ keyId: "dev-list-1", appEnvironment: "test" });
const keys = (status: PublicKey["status"] = "active"): PublicKey[] => [
    { kid: signer.keyId, alg: signer.alg, status, jwk: signer.publicJwk() },
];

function setBits(bits: Uint8Array): number[] {
    const found: number[] = [];
    for (let i = 0; i < STATUS_LIST_ENTRIES; i++) if (isRevokedIn(bits, i)) found.push(i);
    return found;
}

describe("the bit string", () => {
    it("sets exactly the revoked bits, most significant bit first", () => {
        const bits = readStatusList(encodeStatusList([0, 7, 8, 131071]));
        expect(bits).not.toBeNull();
        if (bits === null) return;
        expect(setBits(bits)).toEqual([0, 7, 8, 131071]);
        expect(bits[0]).toBe(0b10000001); // bits 0 and 7 of the first byte
        expect(bits[1]).toBe(0b10000000);
        expect(bits[bits.length - 1]).toBe(0b00000001);
    });

    it("is stable: the same set always encodes to the same text (golden)", () => {
        const empty = encodeStatusList([]);
        expect(encodeStatusList([])).toBe(empty);
        expect(encodeStatusList([9, 0])).toBe(encodeStatusList([0, 9]));
        expect(encodeStatusList([0, 9])).not.toBe(empty);
        expect(empty.startsWith("u")).toBe(true);
        expect(empty.length).toBeLessThan(200); // a list of zeros compresses to almost nothing
    });

    it("round-trips 300 random sets", () => {
        let state = 17;
        const next = (n: number) => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state % n;
        };
        for (let round = 0; round < 300; round++) {
            const wanted = new Set(
                Array.from({ length: next(40) }, () => next(STATUS_LIST_ENTRIES)),
            );
            const bits = readStatusList(encodeStatusList(wanted));
            expect(bits && setBits(bits)).toEqual([...wanted].sort((a, b) => a - b));
        }
    });

    it("refuses indexes outside the list and text that is not a list, including a compression bomb", () => {
        expect(() => encodeStatusList([STATUS_LIST_ENTRIES])).toThrow();
        expect(() => encodeStatusList([-1])).toThrow();
        expect(() => isRevokedIn(new Uint8Array(16384), STATUS_LIST_ENTRIES)).toThrow();
        expect(readStatusList("not a list")).toBeNull();
        expect(readStatusList("uAAAA")).toBeNull();
        const bomb = `u${gzipSync(Buffer.alloc(64 * 1024 * 1024)).toString("base64url")}`;
        expect(readStatusList(bomb)).toBeNull();
        expect(readStatusList(`u${gzipSync(Buffer.alloc(100)).toString("base64url")}`)).toBeNull(); // wrong size
    });
});

describe("the signed list", () => {
    const sign = (encodedList: string, listUrl = URL0) =>
        signStatusList(signer, {
            listUrl,
            issuerDid: DID,
            encodedList,
            issuedAtMs: Date.UTC(2026, 10, 1),
        });

    it("verifies and shows the revoked bits", async () => {
        const result = await verifyStatusList(await sign(encodeStatusList([5])), keys(), URL0);
        expect(result.ok && setBits(result.bits)).toEqual([5]);
    });

    it("is refused when edited, addressed to another list, or signed by a key that is not trusted", async () => {
        const jwt = await sign(encodeStatusList([5]));
        const [h, p, s] = jwt.split(".");
        const payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString());
        payload.vc.credentialSubject.encodedList = encodeStatusList([]);
        const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
        expect(await verifyStatusList(forged, keys(), URL0)).toMatchObject({
            ok: false,
            reason: "signature does not match",
        });
        expect(await verifyStatusList(jwt, keys(), `${URL0.slice(0, -1)}1`)).toMatchObject({
            ok: false,
            reason: "this is another list",
        });
        expect(await verifyStatusList(jwt, keys("revoked"), URL0)).toMatchObject({ ok: false });
        expect(await verifyStatusList(jwt, [], URL0)).toMatchObject({ ok: false });
        expect(await verifyStatusList("garbage", keys(), URL0)).toMatchObject({ ok: false });
    });
});
