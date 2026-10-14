import {
    consentTextSchema,
    draftSaveRequestSchema,
    draftSaveResponseSchema,
    draftsResponseSchema,
    examSessionSchema,
} from "@aura/contracts/api/exams";
import { CONSENT_TEXT_VERSION, CONSENT_TEXTS, telemetryBatchSchema } from "@aura/contracts/exams";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import * as q from "./session-queries.ts";

export interface SessionRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const OBJECT_NOT_IN_STATE = "55000";

// The candidate's own sitting (Stage 6, slice 3): join, consent, start, and read it. Every rule (the roster,
// the staff exclusion, the window, the deadline) is the database's, with the clock from here; these routes
// translate its answers and keep the audit trail. Saving answers is slice 4.
export function sessionRoutes(deps: SessionRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/exams/:id/join", (c) => handleJoin(c, deps));
    routes.get("/exams/:id/session", handleGet);
    routes.get("/exam-consent-text", (c) =>
        c.json(
            consentTextSchema.parse({
                version: CONSENT_TEXT_VERSION,
                text: CONSENT_TEXTS[CONSENT_TEXT_VERSION] ?? "",
            }),
        ),
    );
    routes.post("/exams/:id/consent", (c) => handleConsent(c, deps));
    routes.post("/exams/:id/start", (c) => handleStart(c, deps));
    routes.post("/exams/:id/submit", (c) => handleSubmit(c, deps));
    routes.post("/exams/:id/telemetry", (c) => handleTelemetry(c, deps));
    routes.put("/exams/:id/problems/:label/draft", (c) => handleSave(c, deps));
    routes.get("/exams/:id/drafts", handleDrafts);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

function parse(c: Context<AppEnv>) {
    const actor = c.get("actor");
    const id = idSchema("exm").safeParse(c.req.param("id"));
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    if (!id.success) return { problem: problemResponse(c, "invalid_request", "Invalid request") };
    return { actor, examId: decodeId("exm", id.data) };
}

async function respond(c: Context<AppEnv>, examId: string, status: 200 | 201 = 200) {
    const row = await q.getSession(c.get("tx"), examId);
    if (row === null) return notFound(c);
    return c.json(
        examSessionSchema.parse({
            exam_id: encodeId("exm", row.exam_id),
            state: row.state,
            extra_minutes: row.extra_minutes,
            consented: row.consent_at !== null,
            consent_text_version: row.consent_text_version,
            current_consent_text_version: CONSENT_TEXT_VERSION,
            started_at: row.started_at?.toISOString() ?? null,
            deadline_at: row.deadline_at?.toISOString() ?? null,
            submitted_at: row.submitted_at?.toISOString() ?? null,
        }),
        status,
    );
}

async function handleJoin(c: Context<AppEnv>, deps: SessionRouteDeps) {
    const parsed = parse(c);
    if ("problem" in parsed) return parsed.problem;
    const { actor, examId } = parsed;
    const tx = c.get("tx");
    try {
        await q.join(tx, examId, deps.clock.nowUnixMs());
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === CHECK_VIOLATION)
            return problemResponse(
                c,
                "forbidden",
                "Forbidden",
                "staff do not sit the exam they set",
            );
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "exam.joined",
        target: encodeId("exm", examId),
    });
    return respond(c, examId, 201);
}

async function handleGet(c: Context<AppEnv>) {
    const parsed = parse(c);
    if ("problem" in parsed) return parsed.problem;
    return respond(c, parsed.examId);
}

const consentBody = z.object({ text_version: z.number().int() }).strict();

async function handleConsent(c: Context<AppEnv>, deps: SessionRouteDeps) {
    const parsed = parse(c);
    if ("problem" in parsed) return parsed.problem;
    const body = consentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    // Consent is to the wording in force; an older page cannot consent to words it did not show.
    if (body.data.text_version !== CONSENT_TEXT_VERSION) {
        return problemResponse(c, "conflict", "The consent text has changed; reload the page");
    }
    const tx = c.get("tx");
    try {
        await q.consent(tx, parsed.examId, body.data.text_version, deps.clock.nowUnixMs());
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === OBJECT_NOT_IN_STATE)
            return problemResponse(c, "conflict", "Consent can no longer be given");
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: parsed.actor.userId,
        orgId: null,
        action: "exam.consented",
        target: encodeId("exm", parsed.examId),
        detail: { text_version: body.data.text_version },
    });
    return respond(c, parsed.examId);
}

async function handleStart(c: Context<AppEnv>, deps: SessionRouteDeps) {
    const parsed = parse(c);
    if ("problem" in parsed) return parsed.problem;
    const tx = c.get("tx");
    const before = await q.getSession(tx, parsed.examId);
    try {
        await q.start(tx, parsed.examId, deps.clock.nowUnixMs());
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === OBJECT_NOT_IN_STATE)
            return problemResponse(c, "conflict", "The exam cannot be started now");
        throw error;
    }
    if (before?.state !== "started") {
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: parsed.actor.userId,
            orgId: null,
            action: "exam.started",
            target: encodeId("exm", parsed.examId),
        });
    }
    return respond(c, parsed.examId);
}

// Saves one snapshot. Everything is decided by save_exam_draft with this clock; the page learns from the detail:
// "over" when the time is up, "last:N" when the server already holds a save at or above its number.
async function handleSave(c: Context<AppEnv>, deps: SessionRouteDeps) {
    const parsed = parse(c);
    if ("problem" in parsed) return parsed.problem;
    const label = c.req.param("label") ?? "";
    const body = draftSaveRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success || !/^[A-Z][A-Z0-9]{0,2}$/.test(label)) {
        return problemResponse(c, "invalid_request", "Invalid request");
    }
    const result = await q.saveDraft(c.get("tx"), {
        examId: parsed.examId,
        label,
        seq: body.data.seq,
        language: body.data.language,
        content: body.data.content,
        nowMs: deps.clock.nowUnixMs(),
    });
    if (result.kind === "saved") {
        return c.json(
            draftSaveResponseSchema.parse({
                acked_seq: result.ackedSeq,
                deadline_at: result.deadlineAt.toISOString(),
            }),
        );
    }
    if (result.why === "unknown") return notFound(c);
    if (result.why === "over") return problemResponse(c, "conflict", "The time is over", "over");
    if (result.why === "conflict") {
        return problemResponse(c, "conflict", "A newer save exists", `last:${result.lastSeq ?? 0}`);
    }
    if (result.why === "too_large")
        return problemResponse(c, "payload_too_large", "The draft is too large");
    return problemResponse(c, "rate_limited", "Too many saves; wait a moment");
}

async function handleDrafts(c: Context<AppEnv>) {
    const parsed = parse(c);
    if ("problem" in parsed) return parsed.problem;
    const tx = c.get("tx");
    // Only a person with a sitting in this exam has drafts to read back; anyone else gets the same 404.
    if ((await q.getSession(tx, parsed.examId)) === null) return notFound(c);
    const drafts = await q.latestDrafts(tx, parsed.examId);
    return c.json(
        draftsResponseSchema.parse({
            drafts: drafts.map((d) => ({
                label: d.problem_label,
                seq: d.seq,
                language: d.language,
                content: d.content,
            })),
        }),
    );
}

// Handing in early. The last acknowledged save of each problem is the answer; after this no save is accepted.
async function handleSubmit(c: Context<AppEnv>, deps: SessionRouteDeps) {
    const parsed = parse(c);
    if ("problem" in parsed) return parsed.problem;
    const tx = c.get("tx");
    const before = await q.getSession(tx, parsed.examId);
    try {
        await q.submit(tx, parsed.examId, deps.clock.nowUnixMs());
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === OBJECT_NOT_IN_STATE)
            return problemResponse(c, "conflict", "This sitting can no longer be handed in");
        throw error;
    }
    if (before?.state !== "submitted") {
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: parsed.actor.userId,
            orgId: null,
            action: "exam.submitted",
            target: encodeId("exm", parsed.examId),
        });
    }
    return respond(c, parsed.examId);
}

// A batch of events from the page. Accepted only from a sitting under way whose person consented; the database
// decides, the closed list and the per-kind shapes are checked here first. Answers carry a reason the page acts on.
async function handleTelemetry(c: Context<AppEnv>, deps: SessionRouteDeps) {
    const parsed = parse(c);
    if ("problem" in parsed) return parsed.problem;
    const body = telemetryBatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const result = await q.ingestTelemetry(c.get("tx"), {
        examId: parsed.examId,
        events: body.data.events,
        nowMs: deps.clock.nowUnixMs(),
    });
    if (result.kind === "accepted") return c.json({ accepted: result.events }, 202);
    if (result.why === "unknown") return notFound(c);
    if (result.why === "no_consent") return problemResponse(c, "forbidden", "Forbidden", "consent");
    if (result.why === "not_under_way")
        return problemResponse(c, "conflict", "The sitting is not under way", "over");
    if (result.why === "too_many")
        return problemResponse(c, "rate_limited", "Too many events; slow down");
    return problemResponse(c, "invalid_request", "Invalid request");
}
