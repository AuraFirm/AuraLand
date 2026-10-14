import {
    integrityAppealRequestSchema,
    integrityDecideRequestSchema,
    integrityListSchema,
    integrityReviewRequestSchema,
    integrityScanResponseSchema,
    myIntegrityFlagsSchema,
} from "@aura/contracts/api/exams";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import * as q from "./integrity-queries.ts";
import {
    focusFlag,
    pasteFlag,
    type RaisedFlag,
    RULE_VERSION,
    SIMILARITY_SCORE_MIN,
    similarityFlags,
} from "./integrity-rules.ts";
import * as replay from "./replay-queries.ts";
import { similarPairs } from "./similarity.ts";

export interface IntegrityRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const OBJECT_NOT_IN_STATE = "55000";
const INSUFFICIENT_PRIVILEGE = "42501";
const PAIRS_PER_PROBLEM_MAX = 500;

// Integrity flags (Stage 6, slice 9). Staff scan, review and decide; a candidate reads the plain explanation of a
// flag a person confirmed and may appeal it; someone other than the decider reviews the appeal. The database
// functions decide who may; these routes translate, and write the audit trail.
export function integrityRoutes(deps: IntegrityRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/exams/:id/integrity/scan", (c) => handleScan(c, deps));
    routes.get("/exams/:id/integrity/flags", handleList);
    routes.put("/exams/:id/integrity/flags/:flag_id", (c) => handleDecide(c, deps));
    routes.get("/exams/:id/integrity/mine", handleMine);
    routes.post("/exams/:id/integrity/flags/:flag_id/appeal", (c) => handleAppeal(c, deps));
    routes.put("/exams/:id/integrity/appeals/:appeal_id", (c) => handleReview(c, deps));
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");

function who(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    const exam = idSchema("exm").safeParse(c.req.param("id"));
    if (!exam.success) return { problem: invalid(c) };
    return { actor, examId: decodeId("exm", exam.data) };
}

// Maps what the functions raise to what the caller is told; anything else is a bug.
function translated(c: Context<AppEnv>, error: unknown) {
    const code = postgresErrorCode(error);
    if (code === NO_DATA_FOUND) return notFound(c);
    if (code === CHECK_VIOLATION) return invalid(c);
    if (code === OBJECT_NOT_IN_STATE)
        return problemResponse(c, "conflict", "Conflict", "already decided");
    if (code === INSUFFICIENT_PRIVILEGE) {
        return problemResponse(
            c,
            "forbidden",
            "Forbidden",
            "someone other than the person who decided must review",
        );
    }
    throw error;
}

// What the rules see, for one exam, as flags to raise. Reads only counts, sizes and the pairs of similarity.
async function candidateFlags(tx: Transaction, examId: string): Promise<RaisedFlag[]> {
    const flags: RaisedFlag[] = [];
    for (const row of await replay.monitorRows(tx, examId)) {
        const found = focusFlag(row.session_id, row.focus_lost);
        if (found !== null) flags.push(found);
    }
    for (const paste of await q.largestPastes(tx, examId)) {
        const found = pasteFlag(paste.session_id, paste.n);
        if (found !== null) flags.push(found);
    }
    for (const label of await q.answerLabels(tx, examId)) {
        const answers = await replay.answerSources(tx, { examId, label });
        const pairs = similarPairs(
            answers.map((a) => a.source),
            {
                scoreMin: SIMILARITY_SCORE_MIN,
                pairsMax: PAIRS_PER_PROBLEM_MAX,
            },
        );
        for (const pair of pairs) {
            const a = answers[pair.a]?.session_id;
            const b = answers[pair.b]?.session_id;
            if (a === undefined || b === undefined) continue;
            flags.push(
                ...(similarityFlags({
                    label,
                    score: pair.comparison.score,
                    shared: pair.comparison.shared,
                    sessionA: a,
                    sessionB: b,
                }) ?? []),
            );
        }
    }
    return flags;
}

async function handleScan(c: Context<AppEnv>, deps: IntegrityRouteDeps) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const tx = c.get("tx");
    try {
        const flags = await candidateFlags(tx, parsed.examId);
        let raised = 0;
        for (const flag of flags) {
            if (await q.raise(tx, parsed.examId, flag, deps.clock.nowUnixMs(), RULE_VERSION))
                raised++;
        }
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: parsed.actor.userId,
            orgId: null,
            action: "exam.integrity_scanned",
            target: encodeId("exm", parsed.examId),
            detail: { raised },
        });
        return c.json(integrityScanResponseSchema.parse({ raised }));
    } catch (error) {
        return translated(c, error);
    }
}

async function handleList(c: Context<AppEnv>) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const tx = c.get("tx");
    try {
        const people = await replay.monitorRows(tx, parsed.examId);
        const flags = await q.flagsOf(tx, parsed.examId);
        const iso = (d: Date | null) => d?.toISOString() ?? null;
        return c.json(
            integrityListSchema.parse({
                flags: flags.map((f) => {
                    const person = people.find((p) => p.session_id === f.session_id);
                    return {
                        flag_id: encodeId("ifl", f.flag_id),
                        session_id: encodeId("exs", f.session_id),
                        name: person?.name ?? "",
                        email: person?.email ?? "",
                        label: f.label,
                        kind: f.kind,
                        rule_version: f.rule_version,
                        evidence: f.evidence,
                        explanation: f.explanation,
                        state: f.state,
                        decided_at: iso(f.decided_at),
                        decision_note: f.decision_note,
                        appeal:
                            f.appeal_id === null
                                ? null
                                : {
                                      appeal_id: encodeId("apl", f.appeal_id),
                                      note: f.appeal_note ?? "",
                                      state: f.appeal_state ?? "open",
                                      review_note: f.review_note ?? "",
                                  },
                    };
                }),
            }),
        );
    } catch (error) {
        return translated(c, error);
    }
}

async function handleDecide(c: Context<AppEnv>, deps: IntegrityRouteDeps) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const flag = idSchema("ifl").safeParse(c.req.param("flag_id"));
    const body = integrityDecideRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!flag.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.decide(tx, {
            flag: decodeId("ifl", flag.data),
            state: body.data.state,
            note: body.data.note,
            nowMs: deps.clock.nowUnixMs(),
        });
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: parsed.actor.userId,
        orgId: null,
        action: "exam.integrity_decided",
        target: flag.data,
        detail: { state: body.data.state },
    });
    return c.body(null, 204);
}

async function handleMine(c: Context<AppEnv>) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    // Only people who sat this exam may ask; for anyone else it does not exist.
    const tx = c.get("tx");
    if (!(await q.sat(tx, parsed.examId))) return notFound(c);
    const rows = await q.ownFlags(tx, parsed.examId);
    return c.json(
        myIntegrityFlagsSchema.parse({
            flags: rows.map((r) => ({
                flag_id: encodeId("ifl", r.flag_id),
                label: r.problem_label,
                kind: r.kind,
                explanation: r.explanation,
                rule_version: r.rule_version,
                decided_at: r.decided_at?.toISOString() ?? null,
                appeal_state: r.appeal_state,
            })),
        }),
    );
}

async function handleAppeal(c: Context<AppEnv>, deps: IntegrityRouteDeps) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const flag = idSchema("ifl").safeParse(c.req.param("flag_id"));
    const body = integrityAppealRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!flag.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.appeal(tx, {
            flag: decodeId("ifl", flag.data),
            note: body.data.note,
            nowMs: deps.clock.nowUnixMs(),
        });
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: parsed.actor.userId,
        orgId: null,
        action: "exam.integrity_appealed",
        target: flag.data,
        detail: {},
    });
    return c.body(null, 204);
}

async function handleReview(c: Context<AppEnv>, deps: IntegrityRouteDeps) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const appeal = idSchema("apl").safeParse(c.req.param("appeal_id"));
    const body = integrityReviewRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!appeal.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.review(tx, {
            appeal: decodeId("apl", appeal.data),
            outcome: body.data.outcome,
            note: body.data.note,
            nowMs: deps.clock.nowUnixMs(),
        });
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: parsed.actor.userId,
        orgId: null,
        action: "exam.integrity_appeal_reviewed",
        target: appeal.data,
        detail: { outcome: body.data.outcome },
    });
    return c.body(null, 204);
}
