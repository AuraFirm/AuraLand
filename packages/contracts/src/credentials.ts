import { z } from "zod";
import { assert } from "./assert.ts";
import { idSchema } from "./ids.ts";

// Passport vocabulary shared by the control plane, the screens and the simulations (Stage 7, ADR 0033).

// What earns a credential. One per (person, event) (docs/kit/10).
export const CREDENTIAL_KINDS = ["contest_rank", "exam_result"] as const;
export const credentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

// A credential is issued or revoked; whether it has expired is a matter of the clock, never stored.
export const CREDENTIAL_STATES = ["issued", "revoked"] as const;
export const credentialStateSchema = z.enum(CREDENTIAL_STATES);

// What a verifier is told, in the order of how bad it is.
export const VERIFY_OUTCOMES = ["valid", "expired", "revoked", "invalid", "unknown"] as const;
export const verifyOutcomeSchema = z.enum(VERIFY_OUTCOMES);
export type VerifyOutcome = z.infer<typeof verifyOutcomeSchema>;

// The person decides who can see a credential: nobody else (default), whoever has the link, or anyone.
export const VISIBILITIES = ["private", "link", "public"] as const;
export const visibilitySchema = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof visibilitySchema>;

export const KEY_STATES = ["active", "retired", "revoked"] as const;
export const keyStateSchema = z.enum(KEY_STATES);
// ES256 by default (KMS signs P-256); EdDSA can follow once KMS support is checked (kit 15 item 8).
export const KEY_ALGS = ["ES256", "EdDSA"] as const;
export const keyAlgSchema = z.enum(KEY_ALGS);

// Assurance of the event, never more (kit 01): 0 open/unproctored, 1 identity-checked or exam under rules, 2 supervised, 3 proctored.
export const assuranceLevelSchema = z.number().int().min(0).max(3);

// An exam credential shows a quarter of the points, not the points: enough to say what it proves, little enough to
// say nothing about a person's other results.
export const POINTS_BANDS = ["0-24", "25-49", "50-74", "75-100"] as const;
export const pointsBandSchema = z.enum(POINTS_BANDS);
export type PointsBand = z.infer<typeof pointsBandSchema>;

export function pointsBand(points: number, maxPoints: number): PointsBand {
    assert(
        maxPoints > 0 && points >= 0 && points <= maxPoints,
        "points are within the exam's maximum",
    );
    const percent = (points * 100) / maxPoints;
    if (percent < 25) return "0-24";
    if (percent < 50) return "25-49";
    if (percent < 75) return "50-74";
    return "75-100";
}

const TITLE_CHARS_MAX = 160;
const text = z.string().min(1).max(TITLE_CHARS_MAX);

// The claims each kind carries. Strict: nothing else can ride along, and nothing here names an email, a per-test result
// or integrity evidence.
export const contestRankClaimSchema = z
    .object({
        kind: z.literal("contest_rank"),
        event_title: text,
        host_name: text,
        rank: z.number().int().min(1),
        participants: z.number().int().min(1),
        solved: z.number().int().min(0),
        finalized_at: z.iso.datetime(),
    })
    .strict();
export const examResultClaimSchema = z
    .object({
        kind: z.literal("exam_result"),
        event_title: text,
        host_name: text,
        points_band: pointsBandSchema,
        ai_mode: z.enum(["ai_free", "ai_allowed_logged"]),
        released_at: z.iso.datetime(),
    })
    .strict();
export const credentialClaimSchema = z.discriminatedUnion("kind", [
    contestRankClaimSchema,
    examResultClaimSchema,
]);
export type CredentialClaim = z.infer<typeof credentialClaimSchema>;

export const credentialIdSchema = idSchema("crd");
