// Goal: the secrets behind email sign-in are unguessable and unlinkable: codes are uniform eight
// digits, hashes depend on the server key and on what the value is for, and what a person types is
// normalized strictly, never loosely.
import { describe, expect, it } from "vitest";
import { createFakeClock, createSeededRng } from "../../sim/world.ts";
import { LOGIN_CODE_TTL_S, LOGIN_LINK_TTL_S } from "./limits.ts";
import { formatCode, hashSecret, newChallenge, normalizeCode } from "./login.ts";

const KEY = Buffer.alloc(32, 7);
const START = 1_800_000_000_000;
const deps = (seed = 1) => ({
    clock: createFakeClock(START),
    rng: createSeededRng(seed),
    key: KEY,
});

describe("hashSecret", () => {
    it("is a 64-character hex HMAC that depends on the key, the purpose and the value", () => {
        const base = hashSecret(KEY, "code", "12345678");
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        expect(hashSecret(KEY, "code", "12345678")).toBe(base);
        expect(hashSecret(Buffer.alloc(32, 8), "code", "12345678")).not.toBe(base);
        expect(hashSecret(KEY, "link", "12345678")).not.toBe(base);
        expect(hashSecret(KEY, "binding", "12345678")).not.toBe(base);
        expect(hashSecret(KEY, "code", "12345679")).not.toBe(base);
    });

    it("rejects a key shorter than 32 bytes", () => {
        expect(() => hashSecret(Buffer.alloc(31), "code", "x")).toThrow(/key/);
    });
});

describe("normalizeCode and formatCode", () => {
    it("accepts exactly eight digits, tolerating the spaces and hyphens people type", () => {
        for (const input of [
            "12345678",
            "1234 5678",
            "1234-5678",
            " 1234 5678 ",
            "12 34 56 78",
            "00000000",
        ]) {
            expect(normalizeCode(input), input).toBe(input.replace(/[\s-]/g, ""));
        }
    });

    it("rejects everything else, including look-alike digits and wrong lengths", () => {
        for (const bad of [
            "",
            "1234567",
            "123456789",
            "1234567a",
            "１２３４５６７８",
            "1234_5678",
            "١٢٣٤٥٦٧٨",
            "1234\n5678\n9",
            "12345678 9",
        ]) {
            expect(normalizeCode(bad), bad).toBeNull();
        }
    });

    it("shows a code in two groups of four", () => {
        expect(formatCode("00123456")).toBe("0012 3456");
        expect(() => formatCode("123")).toThrow(/8 digits/);
    });
});

describe("newChallenge", () => {
    it("builds a record holding only hashes, with the documented lifetimes", () => {
        const { record, token, code, binding } = newChallenge(deps(), "ada@example.com");
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(code).toMatch(/^[0-9]{8}$/);
        expect(record.linkHash).toBe(hashSecret(KEY, "link", token));
        expect(record.codeHash).toBe(hashSecret(KEY, "code", code));
        expect(record.bindingHash).toBe(hashSecret(KEY, "binding", binding));
        expect(JSON.stringify(record)).not.toContain(token);
        expect(JSON.stringify(record)).not.toContain(binding);
        expect(record.linkExpiresAtMs - record.createdAtMs).toBe(LOGIN_LINK_TTL_S * 1000);
        expect(record.codeExpiresAtMs - record.createdAtMs).toBe(LOGIN_CODE_TTL_S * 1000);
        expect(record).toMatchObject({
            email: "ada@example.com",
            codeAttempts: 0,
            consumedAtMs: null,
            consumedBy: null,
        });
    });

    it("never repeats secrets, and keeps leading zeros in codes", () => {
        const d = deps(3);
        const made = Array.from({ length: 400 }, () => newChallenge(d, "a@example.com"));
        expect(new Set(made.map((m) => m.token)).size).toBe(400);
        expect(new Set(made.map((m) => m.binding)).size).toBe(400);
        expect(made.every((m) => m.code.length === 8)).toBe(true);
        expect(made.some((m) => m.code.startsWith("0"))).toBe(true);
    });

    it("draws codes uniformly across the digit range", () => {
        const d = deps(11);
        const buckets = new Array<number>(10).fill(0);
        for (let i = 0; i < 4000; i++) {
            const first = Number(newChallenge(d, "a@example.com").code[0]);
            buckets[first] = (buckets[first] ?? 0) + 1;
        }
        for (const count of buckets) expect(Math.abs(count - 400)).toBeLessThan(90);
    });

    it("refuses an email that is not already normalized", () => {
        expect(() => newChallenge(deps(), "Ada@Example.com")).toThrow(/email/);
    });
});
