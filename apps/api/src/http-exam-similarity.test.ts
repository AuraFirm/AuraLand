// Goal: similarity through the real HTTP app and PostgreSQL. Staff see pairs of handed-in answers that match after
// renaming and re-commenting, with the matching spans; unrelated answers are not paired; nobody else can ask.

import { randomBytes } from "node:crypto";
import { examSchema, similarityResponseSchema } from "@aura/contracts/api/exams";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC } from "./http-task-support.ts";
import { advanceExams } from "./modules/exams/tick.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // plain member of the host
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // a stranger
const EVE = "018f0000-0000-7000-8000-0000000000e5"; // sits the exam
const FRANK = "018f0000-0000-7000-8000-0000000000f6"; // sits the exam
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
        [EVE, "eve"],
        [FRANK, "frank"],
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

const ORIGINAL =
    "int main() {\n  int total = 0;\n  for (int i = 0; i < 10; i++) { if (i % 2 == 0) total += i * 3; else total -= 1; }\n  return total;\n}";
const COPY = `${ORIGINAL.replaceAll("total", "sum").replace(/\bi\b/g, "k").replace("10", "99")}\n// mine`;
const OTHER =
    "#include <iostream>\nint main() { long long x; std::cin >> x; while (x > 1) { x = x % 2 ? 3 * x + 1 : x / 2; } std::cout << x; }";

async function sitAll(): Promise<string> {
    const created = await call(ALICE, "POST", `/orgs/${hostPublic}/exams`, {
        title: "Compared lab",
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
        csv: "email,name\ncarol@example.com,Carol\neve@example.com,Eve\nfrank@example.com,Frank\n",
    });
    await call(ALICE, "POST", `/exams/${exam}/publish`);
    const people = [CAROL, EVE, FRANK];
    for (const user of people) {
        await call(user, "POST", `/exams/${exam}/join`);
        await call(user, "POST", `/exams/${exam}/consent`, { text_version: 1 });
    }
    h.clock.advance(2 * HOUR + 60_000);
    await tick();
    const texts = [ORIGINAL, COPY, OTHER];
    for (const [index, user] of people.entries()) {
        await call(user, "POST", `/exams/${exam}/start`);
        await call(user, "PUT", `/exams/${exam}/problems/A/draft`, {
            seq: 1,
            language: "cpp",
            content: texts[index],
        });
        await call(user, "POST", `/exams/${exam}/submit`);
    }
    await tick();
    return exam;
}

describe("similarity", () => {
    it("pairs the copy with its original, with spans, and leaves the unrelated answer out", async () => {
        const exam = await sitAll();
        const response = await call(ALICE, "GET", `/exams/${exam}/similarity?label=A`);
        expect(response.status).toBe(200);
        const result = similarityResponseSchema.parse(await response.json());
        expect(result.answers).toBe(3);
        expect(result.pairs).toHaveLength(1);
        const pair = result.pairs[0];
        expect([pair?.a.email, pair?.b.email].sort()).toEqual([
            "carol@example.com",
            "eve@example.com",
        ]);
        expect(pair?.score).toBeGreaterThan(0.9);
        expect(pair?.spans_a.length).toBeGreaterThan(0);
        for (const span of pair?.spans_a ?? [])
            expect(span.end).toBeLessThanOrEqual(ORIGINAL.length + COPY.length);
    });

    it("is staff only and refuses a bad question", async () => {
        const exam = await sitAll();
        for (const user of [CAROL, DAVE, BOB])
            expect(
                (await call(user, "GET", `/exams/${exam}/similarity?label=A`)).status,
                user,
            ).toBe(404);
        expect((await call(null, "GET", `/exams/${exam}/similarity?label=A`)).status).toBe(401);
        for (const bad of ["", "?label=a", "?label=A&score_min=0.1", "?label=A&extra=1"])
            expect((await call(ALICE, "GET", `/exams/${exam}/similarity${bad}`)).status, bad).toBe(
                400,
            );
        const none = similarityResponseSchema.parse(
            await (await call(ALICE, "GET", `/exams/${exam}/similarity?label=B`)).json(),
        );
        expect(none).toMatchObject({ answers: 0, pairs: [] });
    });
});
