import { createHash } from "node:crypto";
import {
    monitorResponseSchema,
    replaySchema,
    similarityResponseSchema,
} from "@aura/contracts/api/exams";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { diffText } from "@aura/contracts/text-delta";
import type { Transaction } from "@aura/db/context";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import * as q from "./replay-queries.ts";
import { similarPairs } from "./similarity.ts";

// The live monitor and the replay (Stage 6, slice 7) for the host's staff. A replay is the first snapshot of a page
// and a chain of small changes (one replacement each), with the sitting's events beside them; applying the chain
// rebuilds every saved text exactly, the last one being what was judged.
const STEPS_PER_PAGE = 2_000;
const NO_DATA_FOUND = "P0002";
// "No upper bound" that PostgreSQL can also read: JavaScript's own latest Date is past its range.
const LATEST_INSTANT_MS = Date.UTC(9999, 11, 31);

export function replayRoutes(): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/exams/:id/monitor", handleMonitor);
    routes.get("/exams/:id/replay/:session_id/:label", handleReplay);
    routes.get("/exams/:id/similarity", handleSimilarity);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const query = z.object({ from_seq: z.coerce.number().int().min(1).default(1) }).strict();

async function handleMonitor(c: Context<AppEnv>) {
    if (c.get("actor").kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const id = idSchema("exm").safeParse(c.req.param("id"));
    if (!id.success) return problemResponse(c, "invalid_request", "Invalid request");
    try {
        const rows = await q.monitorRows(c.get("tx"), decodeId("exm", id.data));
        const iso = (d: Date | null) => d?.toISOString() ?? null;
        return c.json(
            monitorResponseSchema.parse({
                rows: rows.map((r) => ({
                    ...r,
                    session_id: encodeId("exs", r.session_id),
                    started_at: iso(r.started_at),
                    deadline_at: iso(r.deadline_at),
                    last_save_at: iso(r.last_save_at),
                    last_event_at: iso(r.last_event_at),
                })),
            }),
        );
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === NO_DATA_FOUND
        )
            return notFound(c);
        throw error;
    }
}

async function handleReplay(c: Context<AppEnv>) {
    if (c.get("actor").kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const exam = idSchema("exm").safeParse(c.req.param("id"));
    const session = idSchema("exs").safeParse(c.req.param("session_id"));
    const label = c.req.param("label") ?? "";
    const page = query.safeParse(c.req.query());
    if (!exam.success || !session.success || !page.success || !/^[A-Z][A-Z0-9]{0,2}$/.test(label)) {
        return problemResponse(c, "invalid_request", "Invalid request");
    }
    const tx = c.get("tx");
    const input = {
        examId: decodeId("exm", exam.data),
        sessionId: decodeId("exs", session.data),
        label,
    };
    // Staff only: the monitor's function says so; for anyone else the answer is the same 404.
    try {
        await q.monitorRows(tx, input.examId);
    } catch {
        return notFound(c);
    }
    const found = await q.snapshots(tx, {
        ...input,
        fromSeq: page.data.from_seq,
        limit: STEPS_PER_PAGE,
    });
    const first = found[0];
    if (first === undefined) return notFound(c);
    const pageSnapshots = found.slice(0, STEPS_PER_PAGE + 1);
    const more = found.length > STEPS_PER_PAGE + 1;
    const steps = [];
    for (let i = 1; i < pageSnapshots.length; i++) {
        const before = pageSnapshots[i - 1];
        const after = pageSnapshots[i];
        if (before === undefined || after === undefined) continue;
        steps.push({
            seq: after.seq,
            at: after.saved_at.toISOString(),
            ...diffText(before.content, after.content),
            bytes: Buffer.byteLength(after.content, "utf8"),
            sha256: createHash("sha256").update(after.content).digest("hex"),
        });
    }
    const last = pageSnapshots[pageSnapshots.length - 1] ?? first;
    // The first page also carries what happened before the first save, the last page what came after the last.
    const events = await q.eventsBetween(tx, {
        sessionId: input.sessionId,
        from: page.data.from_seq === 1 ? new Date(0) : first.saved_at,
        to: more ? last.saved_at : new Date(LATEST_INSTANT_MS),
    });
    return c.json(
        replaySchema.parse({
            language: last.language,
            base_seq: first.seq,
            base: first.content,
            steps,
            next_from_seq: more ? last.seq : null,
            events: events.map((e) => ({ at: e.ts.toISOString(), kind: e.kind, data: e.data })),
        }),
    );
}

// Pairs listed at most this many, best first; the rest are below what a person would read.
const SIMILARITY_PAIRS_MAX = 200;
const similarityQuery = z
    .object({
        label: z.string().regex(/^[A-Z][A-Z0-9]{0,2}$/),
        score_min: z.coerce.number().min(0.3).max(1).default(0.6),
    })
    .strict();

async function handleSimilarity(c: Context<AppEnv>) {
    if (c.get("actor").kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const exam = idSchema("exm").safeParse(c.req.param("id"));
    if (!exam.success) return problemResponse(c, "invalid_request", "Invalid request");
    const tx = c.get("tx");
    const examId = decodeId("exm", exam.data);
    // Who may ask is decided before anything about the question, so a stranger learns nothing from a 400.
    const people = await staffPeople(tx, examId);
    if (people === null) return notFound(c);
    const query = similarityQuery.safeParse(c.req.query());
    if (!query.success) return problemResponse(c, "invalid_request", "Invalid request");
    const answers = await q.answerSources(tx, { examId, label: query.data.label });
    const pairs = similarPairs(
        answers.map((answer) => answer.source),
        { scoreMin: query.data.score_min, pairsMax: SIMILARITY_PAIRS_MAX },
    );
    const who = (index: number) => {
        const sessionId = answers[index]?.session_id ?? "";
        const person = people.find((row) => row.session_id === sessionId);
        return {
            session_id: encodeId("exs", sessionId),
            name: person?.name ?? "",
            email: person?.email ?? "",
        };
    };
    return c.json(
        similarityResponseSchema.parse({
            label: query.data.label,
            answers: answers.length,
            pairs: pairs.map((pair) => ({
                a: who(pair.a),
                b: who(pair.b),
                score: Math.round(pair.comparison.score * 1000) / 1000,
                shared: pair.comparison.shared,
                spans_a: pair.comparison.spansA,
                spans_b: pair.comparison.spansB,
            })),
        }),
    );
}

// The host's people, or null when the caller is not its staff.
async function staffPeople(tx: Transaction, examId: string): Promise<q.MonitorRow[] | null> {
    try {
        return await q.monitorRows(tx, examId);
    } catch (error) {
        if (postgresErrorCode(error) === NO_DATA_FOUND) return null;
        throw error;
    }
}
