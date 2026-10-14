// Goal: the TypeScript rule of a save (decideSave) and the database function save_exam_draft never disagree. The
// function is what runs; the rule is its specification and what the simulation uses, so this test runs both on a
// few thousand random requests around every edge (the deadline instant, equal and old sequence numbers, repeats,
// gaps, bursts) and compares the answers.

import { createHash, randomBytes } from "node:crypto";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideSave, type SaveOutcome } from "./save-rules.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000080${n}`;
const OWNER = U(1);
const CANDIDATE = U(2);
const START = Date.UTC(2026, 10, 1, 9, 0, 0);
const MINUTE = 60_000;
let db: TestDatabase;
let exam = "";
let sessionId = "";
const DEADLINE = START + 30 * MINUTE;

beforeAll(async () => {
    db = await createMigratedTestDatabase(6);
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at) values (${OWNER}, 'o@example.com', now()), (${CANDIDATE}, 'c@example.com', now())`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'save-uni', 'U') returning id`;
    const host = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${host}, ${OWNER}, 'owner')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by) values (${host}, 'save-task', 'algorithmic', 'org', 'T', ${OWNER}) returning id`;
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
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Stored {
    seq: number;
    hash: string;
    at: number;
}

async function viaDatabase(seq: number, content: string, nowMs: number): Promise<SaveOutcome> {
    try {
        const before = (
            await db.database
                .sql`select count(*)::int as n from exam_drafts where session_id = ${sessionId}`
        )[0]?.["n"];
        const rows = await inRole(
            db.database,
            "aura_app",
            { actorKind: "user", userId: CANDIDATE, orgIds: [] },
            (tx) =>
                tx<
                    { acked_seq: number }[]
                >`select acked_seq from save_exam_draft(${exam}, 'A', ${seq}, 'cpp', ${content}, ${new Date(nowMs)})`,
        );
        const after = (
            await db.database
                .sql`select count(*)::int as n from exam_drafts where session_id = ${sessionId}`
        )[0]?.["n"];
        const acked = rows[0]?.acked_seq ?? -1;
        return after === before
            ? { kind: "repeat", ackedSeq: acked }
            : { kind: "stored", ackedSeq: acked };
    } catch (error) {
        const code =
            typeof error === "object" && error !== null && "code" in error
                ? String(error.code)
                : "";
        if (code === "55000") return { kind: "over" };
        if (code === "54000") return { kind: "too_many" };
        if (code === "40001") {
            const hint =
                typeof error === "object" && error !== null && "hint" in error
                    ? Number(error.hint)
                    : -1;
            return { kind: "conflict", lastSeq: hint };
        }
        throw error;
    }
}

describe("save_exam_draft against decideSave", () => {
    // About 1,500 round trips to the database: four seconds alone, so the default five is too tight under load.
    it("agree on 1,500 random requests around every edge", { timeout: 60_000 }, async () => {
        const next = rng(20261015);
        const stored: Stored[] = [];
        const seen = new Set<string>();
        let now = START + MINUTE;
        for (let i = 0; i < 1500; i++) {
            // The first requests are a burst (ten milliseconds apart) so the per-minute cap is reached.
            now += i < 80 ? 10 : next(5) === 0 ? next(100) : next(1500);
            if (i === 1400) now = DEADLINE - 1; // the last millisecond
            if (i === 1450) now = DEADLINE; // the deadline instant
            const last = stored[stored.length - 1];
            const lastSeq = last?.seq ?? 0;
            const choices =
                i < 80
                    ? [lastSeq + 1]
                    : [lastSeq + 1, lastSeq, lastSeq - 1, lastSeq + 1 + next(5), 1];
            const seq = Math.max(1, choices[next(choices.length)] ?? 1);
            const content =
                next(3) === 0 && last !== undefined ? "same-as-last" : `text ${next(1000)}`;
            const hash = sha(content);
            const expected = decideSave(
                {
                    lastSeq,
                    lastHash: last?.hash ?? null,
                    deadlineMs: DEADLINE,
                    sessionStarted: true,
                    savesLastMinute: stored.filter((s) => s.at > now - MINUTE).length,
                    savesForProblem: stored.length,
                },
                { seq, hash, nowMs: now },
            );
            const got = await viaDatabase(seq, content, now);
            expect(got, `request ${i}: seq ${seq}, now ${now - START} ms into the exam`).toEqual(
                expected,
            );
            seen.add(expected.kind);
            if (expected.kind === "stored") stored.push({ seq, hash, at: now });
            // The next "same as last" repeat must really repeat the last content.
            if (expected.kind === "stored" && content !== "same-as-last") continue;
        }
        expect(stored.length).toBeGreaterThan(100);
        // The run really reached every kind of answer, or agreeing on them would mean little.
        expect([...seen].sort()).toEqual(["conflict", "over", "repeat", "stored", "too_many"]);
    });
});
