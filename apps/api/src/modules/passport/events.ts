import { pointsBand } from "@aura/contracts/credentials";
import { EXAM_CREDENTIAL_VALID_YEARS } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import { finalRanks } from "../contests/service.ts";
import { scoreAnswer } from "../exams/service.ts";
import { type IssuingContext, issueOnce } from "./issuing.ts";

// Turns finished events into credentials (ADR 0033 decision 6). One event per call, all of its people in one
// transaction, so an event is credentialed completely or not at all; issuing is idempotent, so a repeat is harmless.
// A contest earns a credential only if it was rated; an exam only for people with no confirmed, un-overturned
// integrity flag.

const contestRow = z.object({
    contest_id: z.string(),
    org_id: z.string(),
    title: z.string(),
    host_name: z.string(),
    finalized_at: z.date(),
});
const examRow = z.object({
    exam_id: z.string(),
    org_id: z.string(),
    title: z.string(),
    mode: z.enum(["ai_free", "ai_allowed_logged"]),
    host_name: z.string(),
    assurance_level: z.number().int(),
    released_at: z.date(),
});
const examAnswerRow = z.object({
    user_id: z.string(),
    label: z.string(),
    points: z.number().int(),
    auto_percent: z.number().int(),
    rubric: z.array(z.object({ id: z.string(), label: z.string(), max_points: z.number() })),
    judge_score: z.coerce.number().nullable(),
    rubric_scores: z.record(z.string(), z.number()),
    blocked: z.boolean(),
});

export interface Issued {
    readonly kind: "contest" | "exam";
    readonly eventId: string;
    readonly issued: number;
}

export async function issueNextEvent(
    tx: Transaction,
    context: IssuingContext,
): Promise<Issued | null> {
    return (await issueContest(tx, context)) ?? (await issueExam(tx, context));
}

const done = (
    tx: Transaction,
    kind: string,
    eventId: string,
    issued: number,
    context: IssuingContext,
) =>
    tx`select mark_passport_event_done(${kind}, ${eventId}, ${issued}, ${new Date(context.clock.nowUnixMs())})`;

async function issueContest(tx: Transaction, context: IssuingContext): Promise<Issued | null> {
    const [raw] = await tx`select * from next_passport_contest()`;
    if (raw === undefined) return null;
    const event = contestRow.parse(raw);
    const ranks = await finalRanks(tx, event.contest_id);
    let issued = 0;
    for (const rank of ranks) {
        const result = await issueOnce(tx, context, {
            subjectUserId: rank.userId,
            issuerOrgId: event.org_id,
            eventId: event.contest_id,
            assurance: 0,
            expiresAtMs: null,
            claim: {
                kind: "contest_rank",
                event_title: event.title,
                host_name: event.host_name,
                rank: rank.rank,
                participants: ranks.length,
                solved: rank.solved,
                finalized_at: event.finalized_at.toISOString(),
            },
        });
        if (result === "issued") issued++;
    }
    await done(tx, "contest", event.contest_id, issued, context);
    return { kind: "contest", eventId: event.contest_id, issued };
}

interface Person {
    readonly totalMilli: number;
    readonly maxMilli: number;
    readonly blocked: boolean;
}

async function issueExam(tx: Transaction, context: IssuingContext): Promise<Issued | null> {
    const [raw] = await tx`select * from next_passport_exam()`;
    if (raw === undefined) return null;
    const event = examRow.parse(raw);
    const people = new Map<string, Person>();
    for (const row of (await tx`select * from passport_exam_rows(${event.exam_id})`).map((r) =>
        examAnswerRow.parse(r),
    )) {
        const score = scoreAnswer({
            points: row.points,
            autoPercent: row.auto_percent,
            rubric: row.rubric,
            judgeScore: row.judge_score,
            rubricScores: row.rubric_scores,
        });
        const before = people.get(row.user_id);
        people.set(row.user_id, {
            totalMilli: (before?.totalMilli ?? 0) + score.totalMilli,
            maxMilli: (before?.maxMilli ?? 0) + row.points * 1000,
            blocked: (before?.blocked ?? false) || row.blocked,
        });
    }
    const expires = new Date(event.released_at);
    expires.setUTCFullYear(expires.getUTCFullYear() + EXAM_CREDENTIAL_VALID_YEARS);
    let issued = 0;
    for (const [userId, person] of people) {
        if (person.blocked) continue;
        const result = await issueOnce(tx, context, {
            subjectUserId: userId,
            issuerOrgId: event.org_id,
            eventId: event.exam_id,
            assurance: event.assurance_level,
            expiresAtMs: expires.getTime(),
            claim: {
                kind: "exam_result",
                event_title: event.title,
                host_name: event.host_name,
                points_band: pointsBand(person.totalMilli / 1000, person.maxMilli / 1000),
                ai_mode: event.mode,
                released_at: event.released_at.toISOString(),
            },
        });
        if (result === "issued") issued++;
    }
    await done(tx, "exam", event.exam_id, issued, context);
    return { kind: "exam", eventId: event.exam_id, issued };
}
