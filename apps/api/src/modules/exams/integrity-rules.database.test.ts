// Goal: the TypeScript rules for flag decisions and appeal reviews (integrity-rules.ts) and the SQL functions of
// migration 0051 never disagree, and separation of duties holds on every path. Method: 400 flags, each driven
// through eight random operations by random people (two staff, the candidate, a stranger), every answer checked
// against a model built from the pure rules.

import { randomBytes } from "node:crypto";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    appealReviewAllowed,
    type Decision,
    decisionAllowed,
    type FlagState,
} from "./integrity-rules.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000090${n}`;
const OWNER = U(1);
const CANDIDATE = U(2);
const SECOND = U(3);
const STRANGER = U(4);
const START = Date.UTC(2026, 10, 1, 9, 0, 0);
const DEADLINE = START + 30 * 60_000;
let db: TestDatabase;
let exam = "";
let sessionId = "";

beforeAll(async () => {
    db = await createMigratedTestDatabase(6);
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at) values (${OWNER}, 'o@example.com', now()), (${CANDIDATE}, 'c@example.com', now()), (${SECOND}, 's@example.com', now()), (${STRANGER}, 'x@example.com', now())`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'integrity-uni', 'U') returning id`;
    const host = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${host}, ${OWNER}, 'owner'), (${host}, ${SECOND}, 'admin')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by) values (${host}, 'integrity-task', 'algorithmic', 'org', 'T', ${OWNER}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [v] = await sql<
        { id: string }[]
    >`insert into task_versions (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json({ spec_version: 1 })}, 'x', 10, ${randomBytes(32)}, ${OWNER}, ${CANDIDATE}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    const [e] = await sql<
        { id: string }[]
    >`insert into exams (org_id, title, mode, duration_s, window_start, window_end, created_by)
        values (${host}, 'E', 'ai_free', 3600, ${new Date(START)}, ${new Date(START + 3 * 3600_000)}, ${OWNER}) returning id`;
    exam = e?.id ?? "";
    await sql`insert into exam_problems (exam_id, org_id, label, task_version_id, task_org_id, points, auto_percent, rubric) values (${exam}, ${host}, 'A', ${v?.id ?? ""}, ${host}, 100, 100, '[]'::jsonb)`;
    const [s] = await sql<
        { id: string }[]
    >`insert into exam_sessions (exam_id, org_id, user_id, created_at) values (${exam}, ${host}, ${CANDIDATE}, ${new Date(START)}) returning id`;
    sessionId = s?.id ?? "";
    await sql`update exam_sessions set state = 'consented', consent_at = ${new Date(START)}, consent_text_version = 1 where id = ${sessionId}`;
    await sql`update exam_sessions set state = 'started', started_at = ${new Date(START)}, deadline_at = ${new Date(DEADLINE)} where id = ${sessionId}`;
});
afterAll(async () => {
    await db.drop();
});

function rng(seed: number): (n: number) => number {
    let state = seed >>> 0;
    return (n) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % n;
    };
}

const codeOf = (error: unknown): string =>
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
const asUser = <T>(
    userId: string,
    work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>,
) => inRole(db.database, "aura_app", { actorKind: "user", userId, orgIds: [] }, work);

// "ok" or the SQLSTATE the function raised.
async function attempt(
    userId: string,
    run: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<unknown>,
) {
    try {
        await asUser(userId, run);
        return "ok";
    } catch (error) {
        return codeOf(error);
    }
}

interface Model {
    state: FlagState;
    decidedBy: string | null;
    appealed: boolean;
    appealOpen: boolean;
}

const STAFF = [OWNER, SECOND];
const NOW = new Date(START + 60_000);

async function flagFor(round: number): Promise<string> {
    await asUser(
        OWNER,
        (tx) =>
            tx`select raise_integrity_flag(${exam}, ${sessionId}, '', 'large_paste', '{}'::jsonb, 'x', ${round + 1}, ${NOW})`,
    );
    const [row] = await db.database.sql<
        { id: string }[]
    >`select id from integrity_flags where rule_version = ${round + 1}`;
    return row?.id ?? "";
}

async function stepDecide(flag: string, model: Model, person: string, to: Decision) {
    const expected = !STAFF.includes(person)
        ? "P0002"
        : decisionAllowed(model.state, to)
          ? "ok"
          : "55000";
    const got = await attempt(
        person,
        (tx) => tx`select decide_integrity_flag(${flag}, ${to}, '', ${NOW})`,
    );
    expect(got, `decide ${to} from ${model.state} by ${person}`).toBe(expected);
    if (expected === "ok") {
        model.state = to;
        model.decidedBy = person;
    }
}

async function stepAppeal(flag: string, model: Model, person: string) {
    const expected =
        person !== CANDIDATE || model.state !== "confirmed"
            ? "P0002"
            : model.appealed
              ? "55000"
              : "ok";
    const got = await attempt(
        person,
        (tx) => tx`select appeal_integrity_flag(${flag}, 'mine', ${NOW})`,
    );
    expect(got, `appeal in ${model.state} by ${person}`).toBe(expected);
    if (expected === "ok") {
        model.appealed = true;
        model.appealOpen = true;
    }
}

async function stepReview(
    flag: string,
    model: Model,
    person: string,
    outcome: "upheld" | "overturned",
) {
    const [row] = await db.database.sql<
        { id: string }[]
    >`select id from integrity_appeals where flag_id = ${flag}`;
    const appeal = row?.id ?? "018f0000-0000-7000-8000-0000000009ff";
    const verdict =
        !model.appealed || !STAFF.includes(person)
            ? "gone"
            : appealReviewAllowed({
                  appealOpen: model.appealOpen,
                  flagDecidedBy: model.decidedBy,
                  reviewer: person,
              });
    const expected = { gone: "P0002", not_open: "55000", same_person: "42501", ok: "ok" }[verdict];
    const got = await attempt(
        person,
        (tx) => tx`select review_integrity_appeal(${appeal}, ${outcome}, '', ${NOW})`,
    );
    expect(got, `review ${outcome} by ${person}`).toBe(expected);
    if (verdict === "ok") {
        model.appealOpen = false;
        if (outcome === "overturned") model.state = "dismissed";
    }
}

describe("flags and appeals against the pure rules", () => {
    it("agree on 400 random flags, and no appeal is reviewed by its decider", {
        timeout: 120_000,
    }, async () => {
        const next = rng(20261016);
        const people = [OWNER, SECOND, CANDIDATE, STRANGER];
        const decisions: Decision[] = ["clear", "needs_review", "confirmed", "dismissed"];
        for (let round = 0; round < 400; round++) {
            const flag = await flagFor(round);
            const model: Model = {
                state: "unreviewed",
                decidedBy: null,
                appealed: false,
                appealOpen: false,
            };
            for (let step = 0; step < 8; step++) {
                const person = people[next(people.length)] ?? OWNER;
                const kind = next(3);
                if (kind === 0)
                    await stepDecide(flag, model, person, decisions[next(4)] ?? "clear");
                else if (kind === 1) await stepAppeal(flag, model, person);
                else await stepReview(flag, model, person, next(2) === 0 ? "upheld" : "overturned");
            }
            const [stored] = await db.database.sql<
                { state: string; decided_by: string | null }[]
            >`select state, decided_by from integrity_flags where id = ${flag}`;
            expect(stored).toEqual({ state: model.state, decided_by: model.decidedBy });
        }
        const [bad] = await db.database.sql<
            { n: number }[]
        >`select count(*)::int as n from integrity_appeals a join integrity_flags f on f.id = a.flag_id where a.reviewed_by = f.decided_by`;
        expect(bad?.n).toBe(0);
    });
});
