import { consentTextSchema, examSessionSchema } from "@aura/contracts/api/exams";
import { CONSENT_TEXT_VERSION, CONSENT_TEXTS } from "@aura/contracts/exams";
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
