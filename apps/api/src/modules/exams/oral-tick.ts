import { encodeId } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import type { LlmProvider } from "../../platform/llm.ts";
import { buildPrompt, ORAL_OUTPUT_TOKENS_MAX, parseQuestions } from "./oral-prompt.ts";

export interface OralContext {
    readonly clock: Clock;
    readonly llm: LlmProvider;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}

// Requests taken per tick: each is one model call, made outside any transaction (a slow model must not hold
// a database connection), so the batch stays small.
export const ORAL_BATCH = 5;

const claimed = z.object({ id: z.string(), language: z.string(), source: z.string() });

// Writes the questions for pending oral defences. A model that is unavailable, refuses, or answers outside the
// schema leaves the request failed (with a reason that holds no code), for a person to retry. Returns how many
// were finished, good or failed.
export async function generateOralQuestions(context: OralContext): Promise<number> {
    const now = new Date(context.clock.nowUnixMs());
    const taken = await context.inTransaction(async (tx) =>
        (await tx`select id, language, source from claim_oral_defences(${ORAL_BATCH}, ${now})`).map(
            (row) => claimed.parse(row),
        ),
    );
    for (const request of taken) {
        const prompt = buildPrompt({ language: request.language, source: request.source });
        const reply = await context.llm.complete({
            ...prompt,
            outputTokensMax: ORAL_OUTPUT_TOKENS_MAX,
        });
        const questions = reply.ok ? parseQuestions(reply.value) : null;
        await context.inTransaction(async (tx) => {
            if (questions === null) {
                const reason = reply.ok
                    ? "the model's reply did not fit the schema"
                    : `the model was ${reply.error}`;
                await tx`select fail_oral_defence(${request.id}, ${reason})`;
            } else {
                await tx`select store_oral_questions(${request.id}, ${tx.json(questions)}, ${now})`;
            }
            // Counts only: neither the code nor the reply is logged.
            await appendAudit(tx, {
                actorKind: "worker",
                actorUserId: null,
                orgId: null,
                action: questions === null ? "exam.oral_failed" : "exam.oral_generated",
                target: encodeId("ora", request.id),
                detail: { questions: questions?.length ?? 0 },
            });
        });
    }
    return taken.length;
}
