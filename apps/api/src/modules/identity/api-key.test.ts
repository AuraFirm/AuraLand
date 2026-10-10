// Goal: keys have a fixed, checkable shape; the stored hash matches only its own secret; parsing
// refuses anything else; generation is random enough to differ and uses the whole alphabet.
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../../sim/world.ts";
import {
    API_KEY_PREFIX_LENGTH,
    bearerKeyFrom,
    hashApiKeySecret,
    newApiKey,
    parseApiKey,
    secretMatches,
} from "./api-key.ts";

describe("newApiKey", () => {
    it("builds aura_<prefix>_<secret> and stores only the hash of the secret", () => {
        const made = newApiKey(createSeededRng(1));
        expect(made.key).toMatch(/^aura_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
        expect(made.prefix).toHaveLength(API_KEY_PREFIX_LENGTH);
        const parsed = parseApiKey(made.key);
        expect(parsed?.prefix).toBe(made.prefix);
        expect(made.secretHash).toBe(hashApiKeySecret(parsed?.secret ?? ""));
        expect(made.secretHash).not.toContain(parsed?.secret ?? "?");
    });

    it("makes different keys each time and draws every prefix character over many keys", () => {
        const rng = createSeededRng(7);
        const seen = new Set<string>();
        const keys = new Set<string>();
        for (let n = 0; n < 400; n++) {
            const made = newApiKey(rng);
            keys.add(made.key);
            for (const char of made.prefix) seen.add(char);
        }
        expect(keys.size).toBe(400);
        expect(seen.size).toBe(36);
    });
});

describe("parseApiKey and secretMatches", () => {
    const made = newApiKey(createSeededRng(3));
    const parsed = parseApiKey(made.key);

    it("accepts the made key and verifies its secret, not another", () => {
        expect(parsed).not.toBeNull();
        expect(secretMatches(parsed?.secret ?? "", made.secretHash)).toBe(true);
        expect(secretMatches("x".repeat(43), made.secretHash)).toBe(false);
        expect(secretMatches("", made.secretHash)).toBe(false);
    });

    it("refuses wrong marks, lengths, characters and extras", () => {
        const [mark, prefix, secret] = made.key.split("_");
        const bad = [
            "",
            "aura",
            `x_${prefix}_${secret}`,
            `aura_${prefix?.slice(1)}_${secret}`,
            `aura_${prefix}_${secret?.slice(1)}`,
            `aura_${prefix?.toUpperCase()}_${secret}`,
            `${made.key} `,
            ` ${made.key}`,
            `${made.key}\n`,
            `${mark}_${prefix}_${secret}_more`,
            `aura_${prefix}_${secret?.slice(0, 42)}!`,
        ];
        for (const text of bad) expect(parseApiKey(text), JSON.stringify(text)).toBeNull();
    });
});

describe("bearerKeyFrom", () => {
    it("takes the key from an exact Bearer header only", () => {
        expect(bearerKeyFrom("Bearer abc")).toBe("abc");
        for (const header of [undefined, "", "bearer abc", "Bearer", "Basic abc", "Token abc"]) {
            expect(bearerKeyFrom(header), String(header)).toBeNull();
        }
    });
});
