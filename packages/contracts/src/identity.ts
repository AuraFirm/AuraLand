import { z } from "zod";
import {
    DISPLAY_NAME_LENGTH_MAX,
    EMAIL_LENGTH_MAX,
    HANDLE_LENGTH_MAX,
    HANDLE_LENGTH_MIN,
    ORG_NAME_LENGTH_MAX,
    ORG_SLUG_LENGTH_MAX,
    ORG_SLUG_LENGTH_MIN,
} from "./limits.ts";

// Input schemas for identity. They normalize what is safe to normalize (case, whitespace, Unicode
// form) so one real-world thing has one stored spelling, and reject everything else.

// Names that would be confusing or abusable as a person handle or an organization address.
const RESERVED_NAMES: ReadonlySet<string> = new Set([
    "admin",
    "root",
    "support",
    "api",
    "www",
    "mail",
    "help",
    "security",
    "staff",
    "system",
    "null",
    "undefined",
    "aura",
    "auraland",
    "official",
    "moderator",
    "app",
    "static",
    "assets",
    "docs",
    "status",
    "blog",
    "login",
    "logout",
    "signin",
    "signup",
    "settings",
    "verify",
    "developers",
    "forge",
    "arena",
    "exam",
    "passport",
    "bench",
]);

// Characters that must not appear in names: control characters, plus invisible direction marks and
// the byte-order mark, which can disguise text. Zero-width joiners (0x200C, 0x200D) stay allowed:
// Bangla and Persian spelling needs them. Written as code point ranges, not as a regular
// expression with escapes, because a formatter once rewrote those escapes into the invisible
// characters themselves.
const FORBIDDEN_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x0000, 0x001f], // C0 controls
    [0x007f, 0x009f], // delete and C1 controls
    [0x200e, 0x200f], // left-to-right and right-to-left marks
    [0x202a, 0x202e], // embedding and override controls
    [0x2066, 0x2069], // isolate controls
    [0xfeff, 0xfeff], // byte-order mark
];

// Callers have already capped the length, so this loop is bounded.
function hasForbiddenCharacter(text: string): boolean {
    for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        for (const [low, high] of FORBIDDEN_CODE_POINT_RANGES) {
            if (codePoint >= low && codePoint <= high) return true;
        }
    }
    return false;
}

export const emailSchema = z
    .string()
    .trim()
    .max(EMAIL_LENGTH_MAX)
    .pipe(z.email())
    .transform((email) => email.toLowerCase());

export const handleSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(HANDLE_LENGTH_MIN)
    .max(HANDLE_LENGTH_MAX)
    .regex(/^[a-z0-9_]+$/, "letters, digits and underscore only")
    .refine((handle) => !RESERVED_NAMES.has(handle), "this name is reserved");

export const orgSlugSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(ORG_SLUG_LENGTH_MIN)
    .max(ORG_SLUG_LENGTH_MAX)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "letters, digits and inner dashes only")
    .refine((slug) => !RESERVED_NAMES.has(slug), "this name is reserved");

function nameSchema(maxLength: number) {
    return z
        .string()
        .normalize("NFC")
        .trim()
        .min(1)
        .max(maxLength)
        .refine((name) => !hasForbiddenCharacter(name), "contains forbidden characters");
}

export const displayNameSchema = nameSchema(DISPLAY_NAME_LENGTH_MAX);
export const orgNameSchema = nameSchema(ORG_NAME_LENGTH_MAX);

// The roles that exist in Stage 1. Later stages add instructor, setter and others by migration.
export const ORG_ROLES = ["owner", "admin", "member"] as const;
export const orgRoleSchema = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof orgRoleSchema>;
