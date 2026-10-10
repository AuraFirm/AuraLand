import { z } from "zod";
import { idSchema } from "../ids.ts";
import { TASK_PAGE_SIZE_DEFAULT, TASK_PAGE_SIZE_MAX } from "../limits.ts";
import {
    supportedTaskKindSchema,
    taskKindSchema,
    taskSlugSchema,
    taskTitleSchema,
    taskVisibilitySchema,
} from "../tasks.ts";

// Request and response shapes for tasks. Responses are explicit allowlists: nothing about bundles'
// contents or storage appears here, and the version objects come with the version routes.

// "public" and "licensed" are stored but not offered until the marketplace stage.
const settableVisibilitySchema = z.enum(["private", "org"]);

export const taskCreateRequestSchema = z
    .object({
        org_id: idSchema("org"),
        slug: taskSlugSchema,
        title: taskTitleSchema,
        kind: supportedTaskKindSchema,
        visibility: settableVisibilitySchema.default("private"),
    })
    .strict();

export const taskUpdateRequestSchema = z
    .object({ title: taskTitleSchema.optional(), visibility: settableVisibilitySchema.optional() })
    .strict()
    .refine(
        (body) => body.title !== undefined || body.visibility !== undefined,
        "nothing to change",
    );

export const taskSchema = z
    .object({
        id: idSchema("tsk"),
        org_id: idSchema("org"),
        slug: z.string(),
        kind: taskKindSchema,
        visibility: taskVisibilitySchema,
        title: z.string(),
        created_at: z.iso.datetime(),
        updated_at: z.iso.datetime(),
        // The one released version, if any; its number is what people see ("v3").
        released_version: z
            .object({ id: idSchema("tsv"), seq: z.number().int().min(1) })
            .strict()
            .nullable(),
    })
    .strict();
export type TaskItem = z.infer<typeof taskSchema>;

export const taskListQuerySchema = z
    .object({
        org_id: idSchema("org"),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(TASK_PAGE_SIZE_MAX)
            .default(TASK_PAGE_SIZE_DEFAULT),
        cursor: idSchema("tsk").optional(),
    })
    .strict();

export const tasksResponseSchema = z
    .object({ items: z.array(taskSchema), next_cursor: idSchema("tsk").nullable() })
    .strict();
