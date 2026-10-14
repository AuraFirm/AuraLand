// Goal: the live monitor and the replay through the real HTTP app and PostgreSQL. Staff of the host see who is
// where and counts of signals; the replay is a base text plus small changes, and applying them rebuilds every saved
// text, the last one byte for byte what was judged. Candidates, members and strangers get nothing. Paging resumes
// exactly where the previous page ended.

import { randomBytes } from "node:crypto";
import { examSchema, monitorResponseSchema, replaySchema } from "@aura/contracts/api/exams";
import { decodeId, encodeId } from "@aura/contracts/ids";
import { applyDelta } from "@aura/contracts/text-delta";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC } from "./http-task-support.ts";
import { advanceExams } from "./modules/exams/tick.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // plain member of the host
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // a stranger
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const HOUR = 3_600_000;

let h: Harness;
let host = "";
let hostPublic = "";
let version = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'http-uni', 'Uni') returning id`;
    host = org?.id ?? "";
    hostPublic = encodeId("org", host);
    await sql`insert into memberships (org_id, user_id, role) values
        (${host}, ${ALICE}, 'owner'), (${host}, ${BOB}, 'setter'), (${host}, ${CAROL}, 'member')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${host}, 'http-task', 'algorithmic', 'private', 'T', ${ALICE}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [v] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json(SPEC)}, 'Read **two** numbers.', 10, ${randomBytes(32)}, ${ALICE}, ${BOB}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    version = encodeId("tsv", v?.id ?? "");
});
afterAll(async () => {
    await h.drop();
});

const call = async (user: string | null, method: string, path: string, body?: unknown) => {
    const headers =
        user === null
            ? browser(null, body === undefined ? {} : { "content-type": "application/json" })
            : browser(
                  (await h.login(user)).token,
                  body === undefined ? {} : { "content-type": "application/json" },
              );
    return h.request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};
const iso = (offsetMs: number) => new Date(h.clock.nowUnixMs() + offsetMs).toISOString();

const context = () => ({
    clock: h.clock,
    inTransaction: <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
        withRequestContext(h.db.database.sql, WORKER, work),
});
const tick = () => advanceExams(context());

const TEXTS = [
    "int main(){}",
    "int main(){ return 0; }",
    "int main(){ return 0; } // \u{1F600}\r\n\tdone",
    "#include <stdio.h>\nint main(){ return 0; }",
];

async function finishedSitting(): Promise<{ exam: string; session: string; submission: string }> {
    const created = await call(ALICE, "POST", `/orgs/${hostPublic}/exams`, {
        title: "Replayed lab",
        mode: "ai_free",
        duration_s: 3600,
        window_start: iso(2 * HOUR),
        window_end: iso(6 * HOUR),
        problems: [
            { label: "A", task_version_id: version, points: 100, auto_percent: 100, rubric: [] },
        ],
    });
    const exam = examSchema.parse(await created.json()).id;
    await call(ALICE, "PUT", `/exams/${exam}/roster`, {
        csv: "email,name\ncarol@example.com,Carol\n",
    });
    await call(ALICE, "POST", `/exams/${exam}/publish`);
    await call(CAROL, "POST", `/exams/${exam}/join`);
    await call(CAROL, "POST", `/exams/${exam}/consent`, { text_version: 1 });
    h.clock.advance(2 * HOUR + 60_000);
    await tick();
    await call(CAROL, "POST", `/exams/${exam}/start`);
    await call(CAROL, "POST", `/exams/${exam}/telemetry`, {
        events: [{ kind: "focus_lost", t: h.clock.nowUnixMs(), data: {} }],
    });
    for (const [index, content] of TEXTS.entries()) {
        h.clock.advance(1_000);
        const saved = await call(CAROL, "PUT", `/exams/${exam}/problems/A/draft`, {
            seq: index + 1,
            language: "cpp",
            content,
        });
        expect(saved.status).toBe(200);
    }
    await call(CAROL, "POST", `/exams/${exam}/submit`);
    await tick();
    const { sql } = h.db.database;
    const [sub] = await sql<
        { id: string }[]
    >`select id from submissions where context_id = ${decodeId("exm", exam)}`;
    const [row] = await sql<
        { id: string }[]
    >`select id from exam_sessions where exam_id = ${decodeId("exm", exam)}`;
    return { exam, session: encodeId("exs", row?.id ?? ""), submission: sub?.id ?? "" };
}

describe("the monitor", () => {
    it("shows staff each person's state, saves and signals, and nobody else", async () => {
        const { exam } = await finishedSitting();
        const response = await call(ALICE, "GET", `/exams/${exam}/monitor`);
        expect(response.status).toBe(200);
        const { rows } = monitorResponseSchema.parse(await response.json());
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            email: "carol@example.com",
            name: "Carol",
            state: "submitted",
            consented: true,
            saves: 4,
            problems_started: 1,
            focus_lost: 1,
            paste: 0,
        });
        for (const user of [CAROL, DAVE, BOB])
            expect((await call(user, "GET", `/exams/${exam}/monitor`)).status, user).toBe(404);
        expect((await call(null, "GET", `/exams/${exam}/monitor`)).status).toBe(401);
    });
});

describe("the replay", () => {
    it("rebuilds every saved text and ends with exactly what was judged", async () => {
        const { exam, session, submission } = await finishedSitting();
        const response = await call(ALICE, "GET", `/exams/${exam}/replay/${session}/A`);
        expect(response.status).toBe(200);
        const replay = replaySchema.parse(await response.json());
        expect(replay.base_seq).toBe(1);
        expect(replay.base).toBe(TEXTS[0]);
        expect(replay.next_from_seq).toBeNull();
        let text = replay.base;
        for (const [index, step] of replay.steps.entries()) {
            text = applyDelta(text, step);
            expect(text).toBe(TEXTS[index + 1]);
            expect(step.bytes).toBe(Buffer.byteLength(text, "utf8"));
        }
        const [judged] = await h.db.database.sql<
            { source: string }[]
        >`select source from submissions where id = ${submission}`;
        expect(Buffer.from(text, "utf8").equals(Buffer.from(judged?.source ?? "", "utf8"))).toBe(
            true,
        );
        expect(replay.events.map((e) => e.kind)).toContain("focus_lost");
    });

    it("is staff only, and refuses what is not an answer", async () => {
        const { exam, session } = await finishedSitting();
        for (const user of [CAROL, DAVE, BOB])
            expect(
                (await call(user, "GET", `/exams/${exam}/replay/${session}/A`)).status,
                user,
            ).toBe(404);
        expect((await call(null, "GET", `/exams/${exam}/replay/${session}/A`)).status).toBe(401);
        expect((await call(ALICE, "GET", `/exams/${exam}/replay/${session}/B`)).status).toBe(404);
        expect((await call(ALICE, "GET", `/exams/${exam}/replay/${session}/a`)).status).toBe(400);
        expect(
            (await call(ALICE, "GET", `/exams/${exam}/replay/${session}/A?from_seq=0`)).status,
        ).toBe(400);
        expect(
            (await call(ALICE, "GET", `/exams/${exam}/replay/${session}/A?from_seq=99`)).status,
        ).toBe(404);
    });

    it("starts a later page from the snapshot where it begins", async () => {
        const { exam, session } = await finishedSitting();
        const replay = replaySchema.parse(
            await (
                await call(ALICE, "GET", `/exams/${exam}/replay/${session}/A?from_seq=3`)
            ).json(),
        );
        expect(replay.base_seq).toBe(3);
        expect(replay.base).toBe(TEXTS[2]);
        expect(
            applyDelta(replay.base, replay.steps[0] ?? { start: 0, remove: 0, insert: "" }),
        ).toBe(TEXTS[3]);
    });
});
