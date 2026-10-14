import { z } from "zod";

// The platform status banner. `ok` says nothing; the other two carry a short plain-text message.
export const PLATFORM_STATUS_LEVELS = ["ok", "degraded", "outage"] as const;
export const platformStatusLevelSchema = z.enum(PLATFORM_STATUS_LEVELS);
const MESSAGE_CHARS_MAX = 280;

export const platformStatusSchema = z
    .object({
        level: platformStatusLevelSchema,
        message: z.string().max(MESSAGE_CHARS_MAX),
        updated_at: z.iso.datetime(),
    })
    .strict();

export const platformStatusRequestSchema = z
    .object({
        level: platformStatusLevelSchema,
        message: z
            .string()
            .trim()
            .max(MESSAGE_CHARS_MAX)
            .refine(
                (text) =>
                    [...text].every((ch) => (ch.codePointAt(0) ?? 0) >= 32 && ch !== "\u007f"),
                "no control characters",
            ),
    })
    .strict()
    .refine(
        (body) => (body.level === "ok") === (body.message === ""),
        "an ok status has no message and any other has one",
    );
