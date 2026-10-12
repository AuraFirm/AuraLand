import { z } from "zod";
import { idSchema } from "../ids.ts";

// Who works on a task. Owners and admins assign setters and reviewers of the organization; the
// assigned person reads their own assignment, owners and admins read all of a task's.

export const assignmentCreateRequestSchema = z.object({ user_id: idSchema("usr") }).strict();

export const assignmentSchema = z
    .object({ user_id: idSchema("usr"), created_at: z.iso.datetime() })
    .strict();
export const assignmentsResponseSchema = z
    .object({ assignments: z.array(assignmentSchema) })
    .strict();
