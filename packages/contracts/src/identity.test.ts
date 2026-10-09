// Goal: identity input schemas must normalize what is safe to normalize and reject the rest at
// the exact boundaries of their limits (limit minus one, limit, limit plus one).
import { describe, expect, it } from "vitest";
import {
    displayNameSchema,
    emailSchema,
    handleSchema,
    orgNameSchema,
    orgRoleSchema,
    orgSlugSchema,
} from "./identity.ts";
import {
    DISPLAY_NAME_LENGTH_MAX,
    EMAIL_LENGTH_MAX,
    HANDLE_LENGTH_MAX,
    HANDLE_LENGTH_MIN,
    ORG_NAME_LENGTH_MAX,
    ORG_SLUG_LENGTH_MAX,
    ORG_SLUG_LENGTH_MIN,
} from "./limits.ts";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
    schema.safeParse(v).success;

// A valid address of exactly `total` characters: a 64-character local part and domain labels of at
// most 63 characters, which is the longest shape the standards allow.
function addressOfLength(total: number): string {
    const local = "a".repeat(64);
    let domainRemaining = total - local.length - 1 - "com".length;
    const labels: string[] = [];
    while (domainRemaining > 0) {
        const take = Math.min(63, domainRemaining - 1);
        labels.push("b".repeat(take));
        domainRemaining -= take + 1;
    }
    return `${local}@${[...labels, "com"].join(".")}`;
}

describe("emailSchema", () => {
    it("trims and lowercases so one mailbox has one spelling", () => {
        expect(emailSchema.parse("  Ada.Lovelace@Example.COM ")).toBe("ada.lovelace@example.com");
    });

    it("accepts an address of exactly the maximum length and rejects one character more", () => {
        expect(addressOfLength(EMAIL_LENGTH_MAX).length).toBe(EMAIL_LENGTH_MAX);
        expect(ok(emailSchema, addressOfLength(EMAIL_LENGTH_MAX))).toBe(true);
        expect(addressOfLength(EMAIL_LENGTH_MAX + 1).length).toBe(EMAIL_LENGTH_MAX + 1);
        expect(ok(emailSchema, addressOfLength(EMAIL_LENGTH_MAX + 1))).toBe(false);
    });

    it("rejects malformed addresses, control characters and non-strings", () => {
        const malformed = [
            "",
            "a",
            "a@",
            "@b.com",
            "a b@c.com",
            "a@b",
            "a@b..com",
            "a\u0000@b.com",
        ];
        for (const bad of [...malformed, "a@b.com\r\nBcc: x@y.zz"]) {
            expect(ok(emailSchema, bad)).toBe(false);
        }
        for (const bad of [null, undefined, 1, {}, ["a@b.com"]]) {
            expect(ok(emailSchema, bad)).toBe(false);
        }
    });
});

describe("handleSchema", () => {
    it("accepts the length boundaries and rejects one outside each", () => {
        expect(ok(handleSchema, "a".repeat(HANDLE_LENGTH_MIN))).toBe(true);
        expect(ok(handleSchema, "a".repeat(HANDLE_LENGTH_MIN - 1))).toBe(false);
        expect(ok(handleSchema, "a".repeat(HANDLE_LENGTH_MAX))).toBe(true);
        expect(ok(handleSchema, "a".repeat(HANDLE_LENGTH_MAX + 1))).toBe(false);
    });

    it("lowercases, rejects other characters and reserved names", () => {
        expect(handleSchema.parse("Ada_99")).toBe("ada_99");
        for (const bad of [
            "a-b-c",
            "a b c",
            "ada!",
            "ada.l",
            "ädä_1",
            "admin",
            "ROOT",
            "support",
        ]) {
            expect(ok(handleSchema, bad)).toBe(false);
        }
    });
});

describe("orgSlugSchema", () => {
    it("accepts the length boundaries and rejects one outside each", () => {
        const slug = (n: number) => `a${"b".repeat(n - 2)}c`;
        expect(ok(orgSlugSchema, slug(ORG_SLUG_LENGTH_MIN))).toBe(true);
        expect(ok(orgSlugSchema, slug(ORG_SLUG_LENGTH_MIN - 1))).toBe(false);
        expect(ok(orgSlugSchema, slug(ORG_SLUG_LENGTH_MAX))).toBe(true);
        expect(ok(orgSlugSchema, slug(ORG_SLUG_LENGTH_MAX + 1))).toBe(false);
    });

    it("rejects leading and trailing dashes, uppercase kept lowercase, and reserved names", () => {
        expect(orgSlugSchema.parse("Tiger-Lab")).toBe("tiger-lab");
        for (const bad of ["-lab", "lab-", "la_b", "la b", "api", "admin", "www"]) {
            expect(ok(orgSlugSchema, bad)).toBe(false);
        }
    });
});

describe("names", () => {
    it("trims, enforces non-empty and the maximum length", () => {
        expect(displayNameSchema.parse("  Ada  ")).toBe("Ada");
        expect(ok(displayNameSchema, "")).toBe(false);
        expect(ok(displayNameSchema, "   ")).toBe(false);
        expect(ok(displayNameSchema, "x".repeat(DISPLAY_NAME_LENGTH_MAX))).toBe(true);
        expect(ok(displayNameSchema, "x".repeat(DISPLAY_NAME_LENGTH_MAX + 1))).toBe(false);
        expect(ok(orgNameSchema, "x".repeat(ORG_NAME_LENGTH_MAX))).toBe(true);
        expect(ok(orgNameSchema, "x".repeat(ORG_NAME_LENGTH_MAX + 1))).toBe(false);
    });

    it("normalizes to NFC, rejects direction overrides, and keeps joiners that Bangla needs", () => {
        expect(displayNameSchema.parse("Cafe\u0301")).toBe("Caf\u00e9");
        expect(ok(displayNameSchema, "Ada\u202eevil")).toBe(false);
        expect(ok(displayNameSchema, "Ada\u200e")).toBe(false);
        // A leading byte-order mark is whitespace to JavaScript and is trimmed away; inside a name it is rejected.
        expect(displayNameSchema.parse("\ufeffAda")).toBe("Ada");
        expect(ok(displayNameSchema, "Ad\ufeffa")).toBe(false);
        // Zero-width non-joiner and joiner are part of correct spelling in Bangla and Persian.
        expect(ok(displayNameSchema, "\u09b0\u200d\u09af")).toBe(true);
        expect(ok(displayNameSchema, "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe(
            true,
        );
    });

    it("rejects control characters in names", () => {
        expect(ok(displayNameSchema, "Ada\u0007")).toBe(false);
        expect(ok(orgNameSchema, "Lab\nTwo")).toBe(false);
    });
});

describe("orgRoleSchema", () => {
    it("accepts exactly the three roles of this stage", () => {
        for (const role of ["owner", "admin", "member"]) expect(ok(orgRoleSchema, role)).toBe(true);
        for (const bad of ["Owner", "root", "instructor", ""])
            expect(ok(orgRoleSchema, bad)).toBe(false);
    });
});
