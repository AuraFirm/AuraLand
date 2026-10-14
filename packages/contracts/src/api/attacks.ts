import { z } from "zod";
import { idSchema } from "../ids.ts";
import { ATTACK_METHOD_CHARS_MAX } from "../limits.ts";

// Findings of people who tried to pass a task without solving it. The method is plain text, shown as
// text, never rendered as Markdown or HTML: it describes an attack and may contain anything.

export const attackOutcomeSchema = z.enum(["held", "gamed"]);

export const attackCreateRequestSchema = z
    .object({
        outcome: attackOutcomeSchema,
        method: z
            .string()
            .trim()
            .min(1)
            .max(ATTACK_METHOD_CHARS_MAX)
            .refine((text) => !text.includes("\0"), "contains a NUL byte"),
    })
    .strict();

export const attackSchema = z
    .object({
        id: idSchema("atk"),
        author_id: idSchema("usr"),
        outcome: attackOutcomeSchema,
        method: z.string(),
        created_at: z.iso.datetime(),
    })
    .strict();
export const attacksResponseSchema = z.object({ attacks: z.array(attackSchema) }).strict();
