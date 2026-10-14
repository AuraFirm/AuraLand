import type { ContestCreateRequest } from "@aura/contracts/contests";
import { contestRulesSchema, contestStateSchema } from "@aura/contracts/contests";
import { CONTEST_PROBLEMS_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for contests, run as `aura_app`. Row-level security decides which contests and problem lists a
// caller sees; the functions of migrations 0033 and 0034 decide who may change them.

const rowSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    slug: z.string(),
    title: z.string(),
    format: z.enum(["icpc", "ioi"]),
    rules: contestRulesSchema,
    visibility: z.enum(["public", "unlisted", "private"]),
    ai_policy: z.enum(["none", "allowed_logged", "agents_only"]),
    rated: z.boolean(),
    state: contestStateSchema,
    starts_at: z.date(),
    ends_at: z.date(),
    freeze_at: z.date().nullable(),
    finalized_at: z.date().nullable(),
});
export type ContestRow = z.infer<typeof rowSchema>;

const COLUMNS = (
    tx: Transaction,
) => tx`id, org_id, slug, title, format, rules, visibility, ai_policy, rated,
    state, starts_at, ends_at, freeze_at, finalized_at`;

export async function insertContest(
    tx: Transaction,
    input: { orgId: string; userId: string; contest: ContestCreateRequest },
): Promise<ContestRow> {
    const { contest } = input;
    const rows =
        await tx`insert into contests (org_id, slug, title, format, rules, visibility, ai_policy, rated,
            starts_at, ends_at, freeze_at, created_by)
        values (${input.orgId}, ${contest.slug}, ${contest.title}, ${contest.rules.format}, ${tx.json(contest.rules)},
                ${contest.visibility}, ${contest.ai_policy}, ${contest.rated}, ${new Date(contest.starts_at)},
                ${new Date(contest.ends_at)}, ${contest.freeze_at === null ? null : new Date(contest.freeze_at)},
                ${input.userId})
        returning ${COLUMNS(tx)}`;
    return rowSchema.parse(rows[0]);
}

export async function getContest(tx: Transaction, id: string): Promise<ContestRow | null> {
    const rows = await tx`select ${COLUMNS(tx)} from contests where id = ${id}`;
    return rows[0] === undefined ? null : rowSchema.parse(rows[0]);
}

// Newest first by id (ids sort by creation time); `orgId` null is the public listing.
export async function listContests(
    tx: Transaction,
    input: { orgId: string | null; cursor: string | null; limit: number },
): Promise<{ rows: ContestRow[]; hasMore: boolean }> {
    const rows = await tx`select ${COLUMNS(tx)} from contests
        where ${input.orgId === null ? tx`visibility = 'public' and state <> 'draft'` : tx`org_id = ${input.orgId}`}
          and ${input.cursor === null ? tx`true` : tx`id < ${input.cursor}`}
        order by id desc limit ${input.limit + 1}`;
    const parsed = rows.map((row) => rowSchema.parse(row));
    return { rows: parsed.slice(0, input.limit), hasMore: parsed.length > input.limit };
}

export interface ProblemRow {
    readonly label: string;
    readonly points: number;
}

export async function problemsOf(tx: Transaction, contestId: string): Promise<ProblemRow[]> {
    const rows = await tx`select label, points from contest_problems where contest_id = ${contestId}
        order by label limit ${CONTEST_PROBLEMS_MAX}`;
    return rows.map((row) => z.object({ label: z.string(), points: z.number() }).parse(row));
}

export async function isRegistered(
    tx: Transaction,
    contestId: string,
    userId: string,
): Promise<boolean> {
    const rows =
        await tx`select 1 from registrations where contest_id = ${contestId} and user_id = ${userId}`;
    return rows.length === 1;
}

export interface ContestPatch {
    readonly title?: string;
    readonly rules?: ContestCreateRequest["rules"];
    readonly visibility?: string;
    readonly ai_policy?: string;
    readonly rated?: boolean;
    readonly starts_at?: Date;
    readonly ends_at?: Date;
    readonly freeze_at?: Date | null;
}

// Only draft contests are updatable (policy); a row the caller may not update simply is not touched.
export async function updateContest(
    tx: Transaction,
    id: string,
    patch: ContestPatch,
): Promise<ContestRow | null> {
    const changes: Record<
        string,
        string | boolean | Date | null | ReturnType<Transaction["json"]>
    > = {};
    if (patch.title !== undefined) changes["title"] = patch.title;
    if (patch.rules !== undefined) changes["rules"] = tx.json(patch.rules);
    if (patch.visibility !== undefined) changes["visibility"] = patch.visibility;
    if (patch.ai_policy !== undefined) changes["ai_policy"] = patch.ai_policy;
    if (patch.rated !== undefined) changes["rated"] = patch.rated;
    if (patch.starts_at !== undefined) changes["starts_at"] = patch.starts_at;
    if (patch.ends_at !== undefined) changes["ends_at"] = patch.ends_at;
    if (patch.freeze_at !== undefined) changes["freeze_at"] = patch.freeze_at;
    const rows =
        await tx`update contests set ${tx(changes)} where id = ${id} returning ${COLUMNS(tx)}`;
    return rows[0] === undefined ? null : rowSchema.parse(rows[0]);
}

export const addProblem = (
    tx: Transaction,
    contestId: string,
    label: string,
    version: string,
    points: number,
) => tx`select add_contest_problem(${contestId}, ${label}, ${version}, ${points})`;
export const removeProblem = (tx: Transaction, contestId: string, label: string) =>
    tx`select remove_contest_problem(${contestId}, ${label})`;
export const publish = (tx: Transaction, contestId: string, nowMs: number) =>
    tx`select publish_contest(${contestId}, ${new Date(nowMs)})`;
export const finalize = (tx: Transaction, contestId: string, nowMs: number) =>
    tx`select finalize_contest(${contestId}, ${new Date(nowMs)})`;

export async function register(
    tx: Transaction,
    contestId: string,
    nowMs: number,
): Promise<"registered" | "already"> {
    const rows = await tx`select register_for_contest(${contestId}, ${new Date(nowMs)}) as status`;
    return z.object({ status: z.enum(["registered", "already"]) }).parse(rows[0]).status;
}
