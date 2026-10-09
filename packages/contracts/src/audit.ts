import { z } from "zod";

// What may be written to the audit log. The log is append-only, so every field is validated before
// it can reach the database (which repeats the same rules as constraints, so neither side is the
// only guard). The shape mirrors the audit_log table.

export const AUDIT_ACTOR_KINDS = ["user", "api_key", "anonymous", "system", "worker"] as const;
export const AUDIT_ACTION_LENGTH_MAX = 100;
export const AUDIT_TARGET_LENGTH_MAX = 200;
// Serialized JSON size; the database caps the stored jsonb at the same figure.
export const AUDIT_DETAIL_BYTES_MAX = 4096;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hasControlCharacter = (text: string) =>
    [...text].some((c) => (c.codePointAt(0) ?? 0) < 0x20 || c === "\u007f");

export const auditEntrySchema = z
    .object({
        actorKind: z.enum(AUDIT_ACTOR_KINDS),
        actorUserId: uuid.nullable(),
        orgId: uuid.nullable(),
        // dotted lowercase names such as "auth.login_succeeded"
        action: z
            .string()
            .max(AUDIT_ACTION_LENGTH_MAX)
            .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
        target: z
            .string()
            .max(AUDIT_TARGET_LENGTH_MAX)
            .refine((text) => !hasControlCharacter(text), "must not contain control characters")
            .nullable()
            .default(null),
        ip: z.union([z.ipv4(), z.ipv6()]).nullable().default(null),
        detail: z
            .record(z.string(), z.json())
            .refine(
                (value) => JSON.stringify(value).length <= AUDIT_DETAIL_BYTES_MAX,
                "detail is too large",
            )
            .default({}),
    })
    .strict();

export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type AuditEntryInput = z.input<typeof auditEntrySchema>;
