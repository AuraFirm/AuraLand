import { z } from "zod";
import { idSchema } from "../ids.ts";
import { COMMENT_CHARS_MAX } from "../limits.ts";

// Comments on a task version. The body is Markdown; the API also returns it rendered to safe HTML,
// and that is the only form the page puts into the document.

export const commentCreateRequestSchema = z
    .object({
        body: z
            .string()
            .trim()
            .min(1)
            .max(COMMENT_CHARS_MAX)
            .refine((text) => !text.includes("\0"), "contains a NUL byte"),
        parent_id: idSchema("cmt").optional(),
    })
    .strict();

export const commentSchema = z
    .object({
        id: idSchema("cmt"),
        author_id: idSchema("usr"),
        parent_id: idSchema("cmt").nullable(),
        body: z.string(),
        body_html: z.string(),
        created_at: z.iso.datetime(),
    })
    .strict();
export const commentsResponseSchema = z.object({ comments: z.array(commentSchema) }).strict();
