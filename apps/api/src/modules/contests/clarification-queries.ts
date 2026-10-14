import { CLARIFICATIONS_PER_USER_PER_CONTEST_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for clarifications, run as `aura_app`. The policy on the table decides who reads what; the two
// functions of migration 0039 decide who may ask and answer.

const rowSchema = z.object({
    id: z.string(),
    problem_label: z.string().nullable(),
    question: z.string(),
    answer: z.string().nullable(),
    public: z.boolean(),
    mine: z.boolean(),
    created_at: z.date(),
    answered_at: z.date().nullable(),
});
export type ClarificationRow = z.infer<typeof rowSchema>;

export type AskOutcome =
    | { kind: "asked"; id: string }
    | { kind: "refused"; why: "unknown" | "closed" | "too_many" | "too_long" };

const ASK_REFUSALS: Readonly<Record<string, "unknown" | "closed" | "too_many" | "too_long">> = {
    P0002: "unknown",
    "55000": "closed",
    "54000": "too_many",
    "22001": "too_long",
};

const codeOf = (error: unknown): string | null =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : null;

export async function ask(
    tx: Transaction,
    input: { contestId: string; problem: string | null; question: string; nowMs: number },
): Promise<AskOutcome> {
    try {
        const rows = await tx`select ask_clarification(${input.contestId}, ${input.problem},
            ${input.question}, ${new Date(input.nowMs)}, ${CLARIFICATIONS_PER_USER_PER_CONTEST_MAX}) as id`;
        return { kind: "asked", id: z.object({ id: z.string() }).parse(rows[0]).id };
    } catch (error) {
        const why = ASK_REFUSALS[codeOf(error) ?? ""];
        if (why === undefined) throw error;
        return { kind: "refused", why };
    }
}

export type AnswerOutcome = { kind: "answered" } | { kind: "refused"; why: "unknown" | "closed" };

export async function answer(
    tx: Transaction,
    input: { id: string; answer: string; public: boolean; nowMs: number },
): Promise<AnswerOutcome> {
    try {
        await tx`select answer_clarification(${input.id}, ${input.answer}, ${input.public},
            ${new Date(input.nowMs)})`;
        return { kind: "answered" };
    } catch (error) {
        const code = codeOf(error);
        if (code === "P0002") return { kind: "refused", why: "unknown" };
        if (code === "55000") return { kind: "refused", why: "closed" };
        throw error;
    }
}

const COLUMNS = (
    tx: Transaction,
) => tx`id, problem_label, question, answer, public, coalesce(asker_id = app_user(), false) as mine,
    created_at, answered_at`;

export async function getOne(tx: Transaction, id: string): Promise<ClarificationRow | null> {
    const rows = await tx`select ${COLUMNS(tx)} from contest_clarifications where id = ${id}`;
    return rows[0] === undefined ? null : rowSchema.parse(rows[0]);
}

// Newest first by id; ids sort by creation time, so the id is its own tiebreaker.
export async function list(
    tx: Transaction,
    input: { contestId: string; cursor: string | null; limit: number },
): Promise<{ rows: ClarificationRow[]; hasMore: boolean }> {
    const rows = await tx`select ${COLUMNS(tx)} from contest_clarifications
        where contest_id = ${input.contestId}
          and ${input.cursor === null ? tx`true` : tx`id < ${input.cursor}`}
        order by id desc limit ${input.limit + 1}`;
    const parsed = rows.map((row) => rowSchema.parse(row));
    return { rows: parsed.slice(0, input.limit), hasMore: parsed.length > input.limit };
}
