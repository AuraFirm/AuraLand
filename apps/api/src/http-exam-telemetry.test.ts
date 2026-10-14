// Goal: telemetry through the real HTTP app and PostgreSQL. Events are accepted only from a started sitting whose
// person consented, only the closed list of kinds with counts and durations (nothing typed or pasted), in bounded
// batches at a bounded rate; times are kept inside the sitting; they land in partitions; the institution's retention
// deletes them (and nothing else can); candidates cannot read them, other people's staff cannot either.

import { randomBytes } from "node:crypto";
import { examSchema } from "@aura/contracts/api/exams";
import { decodeId, encodeId } from "@aura/contracts/ids";
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

const sendEvents = (user: string | null, exam: string, events: unknown) =>
    call(user, "POST", `/exams/${exam}/telemetry`, { events });
const focusLost = (t: number) => ({ kind: "focus_lost", t, data: {} });

async function sitting(consent = true): Promise<{ exam: string }> {
    const created = await call(ALICE, "POST", `/orgs/${hostPublic}/exams`, {
        title: "Watched lab",
        mode: "ai_free",
        duration_s: 3600,
        window_start: iso(2 * HOUR),
        window_end: iso(6 * HOUR),
        telemetry_retention_days: 30,
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
    if (consent) await call(CAROL, "POST", `/exams/${exam}/consent`, { text_version: 1 });
    h.clock.advance(2 * HOUR + 60_000);
    await tick();
    if (consent) await call(CAROL, "POST", `/exams/${exam}/start`);
    return { exam };
}
const rows = (exam: string) =>
    h.db.database.sql<{ kind: string; ts: Date; seq: number }[]>`
        select t.kind, t.ts, t.seq from telemetry_events t join exam_sessions s on s.id = t.session_id
         where s.exam_id = ${decodeId("exm", exam)} order by t.ts, t.seq`;

describe("ingesting", () => {
    it("takes a batch from a started, consenting sitting and keeps its times inside the sitting", async () => {
        const { exam } = await sitting();
        const now = h.clock.nowUnixMs();
        const response = await sendEvents(CAROL, exam, [
            focusLost(now - 5_000),
            { kind: "paste", t: now - 4_000, data: { chars: 120 } },
            focusLost(now + 3_600_000),
            focusLost(1000),
        ]);
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ accepted: 4 });
        const stored = await rows(exam);
        expect(stored.map((r) => r.kind).sort()).toEqual([
            "focus_lost",
            "focus_lost",
            "focus_lost",
            "paste",
        ]);
        const started =
            (
                await h.db.database.sql<
                    { started_at: Date }[]
                >`select started_at from exam_sessions where exam_id = ${decodeId("exm", exam)}`
            )[0]?.started_at.getTime() ?? 0;
        for (const row of stored) {
            expect(row.ts.getTime()).toBeGreaterThanOrEqual(started); // never before the sitting began
            expect(row.ts.getTime()).toBeLessThanOrEqual(now); // never ahead of the server's clock
        }
        expect(new Set(stored.map((r) => r.seq)).size).toBe(4); // in order, none lost
    });

    it("refuses without consent, outside a sitting, and from strangers", async () => {
        const { exam } = await sitting(false);
        const refused = await sendEvents(CAROL, exam, [focusLost(1)]);
        expect(refused.status).toBe(403);
        expect(await refused.text()).toContain("consent");
        expect(await rows(exam)).toHaveLength(0);
        expect((await sendEvents(DAVE, exam, [focusLost(1)])).status).toBe(404);
        expect((await sendEvents(null, exam, [focusLost(1)])).status).toBe(401);
        const { exam: other } = await sitting();
        h.clock.advance(HOUR + 60_000); // past the deadline
        const late = await sendEvents(CAROL, other, [focusLost(1)]);
        expect(late.status).toBe(409);
        expect(await rows(other)).toHaveLength(0);
    });
});

describe("what is refused", () => {
    it("refuses anything outside the closed list and the per-kind shapes, and oversized or empty batches", async () => {
        const { exam } = await sitting();
        const bad = [
            [{ kind: "screenshot", t: 1, data: {} }],
            [{ kind: "keystroke", t: 1, data: { text: "secret" } }],
            [{ kind: "paste", t: 1, data: { chars: 5, text: "what was pasted" } }],
            [{ kind: "paste", t: 1, data: {} }],
            [{ kind: "edit", t: 1, data: { added: -1, removed: 0 } }],
            [],
            Array.from({ length: 201 }, (_, i) => focusLost(i)),
        ];
        for (const events of bad)
            expect(
                (await sendEvents(CAROL, exam, events)).status,
                JSON.stringify(events).slice(0, 60),
            ).toBe(400);
        expect(await rows(exam)).toHaveLength(0);
        expect(
            (
                await sendEvents(
                    CAROL,
                    exam,
                    Array.from({ length: 200 }, (_, i) => focusLost(i)),
                )
            ).status,
        ).toBe(202); // the edge
    });

    it("limits events to 400 in ten seconds and lets them through again after", async () => {
        const { exam } = await sitting();
        const batch = Array.from({ length: 200 }, (_, i) => focusLost(i));
        expect((await sendEvents(CAROL, exam, batch)).status).toBe(202);
        expect((await sendEvents(CAROL, exam, batch)).status).toBe(202);
        expect((await sendEvents(CAROL, exam, [focusLost(1)])).status).toBe(429);
        h.clock.advance(11_000);
        expect((await sendEvents(CAROL, exam, [focusLost(1)])).status).toBe(202);
    });
});

describe("who reads telemetry, and how long it lives", () => {
    it("is read by the host's staff only, and only the retention job deletes it", async () => {
        const { exam } = await sitting();
        await sendEvents(CAROL, exam, [focusLost(h.clock.nowUnixMs())]);
        const { sql } = h.db.database;
        const asApp = (user: string) =>
            withRequestContext(
                sql,
                { role: "aura_app", actorKind: "user", userId: user, orgIds: [] },
                (tx) => tx`select count(*)::int as n from telemetry_events`,
            );
        expect((await asApp(ALICE))[0]?.["n"]).toBeGreaterThan(0);
        expect((await asApp(CAROL))[0]?.["n"]).toBe(0); // the candidate does not read the record through the table
        expect((await asApp(DAVE))[0]?.["n"]).toBe(0);
        await expect(sql`update telemetry_events set kind = 'copy'`).rejects.toThrow(
            /never changed/,
        );
        await expect(sql`delete from telemetry_events`).rejects.toThrow(/retention job/);
    });

    it("deletes events older than the exam's retention, keeps newer ones, and prepares the partitions", async () => {
        const { exam } = await sitting();
        await sendEvents(CAROL, exam, [
            focusLost(h.clock.nowUnixMs()),
            focusLost(h.clock.nowUnixMs() - 1000),
        ]);
        const { sql } = h.db.database;
        const now = new Date(h.clock.nowUnixMs());
        // The tick prepared the months ahead already: three monthly partitions besides the default, and nothing new to make.
        const [children] = await sql<
            { n: number }[]
        >`select count(*)::int as n from pg_inherits where inhparent = 'telemetry_events'::regclass`;
        expect(children?.n).toBeGreaterThanOrEqual(4);
        expect(
            (await sql<{ n: number }[]>`select ensure_telemetry_partitions(${now}) as n`)[0]?.n,
        ).toBe(0); // idempotent
        expect(await rows(exam)).toHaveLength(2);
        const later = new Date(h.clock.nowUnixMs() + 31 * 24 * HOUR); // retention was 30 days
        // Other sittings of this database expire too; work through batches until nothing is left to delete.
        let deleted = 0;
        for (let round = 0; round < 50; round++) {
            const [batch] = await sql<
                { n: number }[]
            >`select purge_exam_telemetry(${later}, 100) as n`;
            deleted += batch?.n ?? 0;
            if ((batch?.n ?? 0) === 0) break;
        }
        expect(deleted).toBeGreaterThanOrEqual(2);
        expect(await rows(exam)).toHaveLength(0);
    });
});
