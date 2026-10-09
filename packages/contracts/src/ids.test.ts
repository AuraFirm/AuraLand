// Goal: public ids must round-trip, reject every malformed or wrong-type form, and never let a
// string from the outside reach a query unless it is a lowercase UUIDv7 with the right prefix.
import { describe, expect, it } from "vitest";
import { decodeId, encodeId, ID_PREFIXES, idSchema } from "./ids.ts";

const UUID = "018f0000-0000-7000-8000-00000000000a";

describe("encodeId and decodeId", () => {
    it("round-trips for every prefix", () => {
        for (const prefix of ID_PREFIXES) {
            const text = encodeId(prefix, UUID);
            expect(text).toBe(`${prefix}_${UUID}`);
            expect(decodeId(prefix, text)).toBe(UUID);
        }
    });

    it("rejects the wrong prefix, so an org id can never be used as a user id", () => {
        expect(() => decodeId("usr", encodeId("org", UUID))).toThrow(/prefix/);
    });

    it("rejects malformed input of every shape", () => {
        const bad = [
            "",
            "usr_",
            `usr${UUID}`,
            `usr-${UUID}`,
            `USR_${UUID}`,
            `usr_${UUID.toUpperCase()}`,
            ` usr_${UUID}`,
            `usr_${UUID} `,
            `usr_${UUID}\n`,
            `usr_${UUID}x`,
            "usr_018f0000-0000-4000-8000-00000000000a", // version 4, not 7
            "usr_018f0000-0000-7000-7000-00000000000a", // invalid variant
            "usr_018f0000000070008000-00000000000a", // missing dashes
            "usr_' or '1'='1",
            "usr_../../etc/passwd",
        ];
        for (const text of bad) expect(() => decodeId("usr", text)).toThrow();
    });

    it("rejects a uuid that is not valid when encoding", () => {
        expect(() => encodeId("usr", "not-a-uuid")).toThrow(/uuid/);
        expect(() => encodeId("usr", UUID.toUpperCase())).toThrow(/uuid/);
    });
});

describe("idSchema", () => {
    it("parses a valid id and rejects the wrong type, including non-strings", () => {
        const schema = idSchema("org");
        expect(schema.safeParse(encodeId("org", UUID)).success).toBe(true);
        expect(schema.safeParse(encodeId("usr", UUID)).success).toBe(false);
        for (const value of [null, undefined, 42, {}, [], true]) {
            expect(schema.safeParse(value).success).toBe(false);
        }
    });
});
