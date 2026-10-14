// Goal: integrity flags through the real HTTP app and PostgreSQL. A scan raises flags from the rules (once, however
// often it is repeated); only staff decide and only once; the candidate reads the plain explanation of a confirmed
// flag and nothing of the evidence or of other people; an appeal is reviewed by staff other than the decider.

import { randomBytes } from "node:crypto";
import { examSchema, integrityListSchema, myIntegrityFlagsSchema } from "@aura/contracts/api/exams";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC } from "./http-task-support.ts";
import { advanceExams } from "./modules/exams/tick.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // plain member of the host
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // a stranger
const EVE = "018f0000-0000-7000-8000-0000000000e5"; // sits the exam
const ERIN = "018f0000-0000-7000-8000-0000000000a7"; // a second admin of the host
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
        [ERIN, "erin"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'http-uni', 'Uni') returning id`;
    host = org?.id ?? "";
    hostPublic = encodeId("org", host);
    await sql`insert into memberships (org_id, user_id, role) values
        (${host}, ${ALICE}, 'owner'), (${host}, ${BOB}, 'setter'), (${host}, ${CAROL}, 'member'), (${host}, ${ERIN}, 'admin')`;
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

// EVE pastes a lot; FRANK leaves the page ten times; the rules should notice both.
async function watch(user: string, exam: string, index: number) {
    const now = h.clock.nowUnixMs();
    let events: unknown[] = [];
    if (index === 1) events = [{ kind: "paste", t: now, data: { chars: 600 } }];
    if (index === 2)
        events = Array.from({ length: 10 }, () => ({ kind: "focus_lost", t: now, data: {} }));
    if (events.length > 0) await call(user, "POST", `/exams/${exam}/telemetry`, { events });
}
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
        await watch(user, exam, index);
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

const flagsOf = async (user: string, exam: string) =>
    integrityListSchema.parse(
        await (await call(user, "GET", `/exams/${exam}/integrity/flags`)).json(),
    ).flags;
const mine = async (user: string, exam: string) =>
    myIntegrityFlagsSchema.parse(
        await (await call(user, "GET", `/exams/${exam}/integrity/mine`)).json(),
    ).flags;

describe("raising flags", () => {
    it("raises each from the rules once, with evidence for staff and an explanation for the person", async () => {
        const exam = await sitAll();
        const first = await call(ALICE, "POST", `/exams/${exam}/integrity/scan`);
        expect(await first.json()).toEqual({ raised: 4 }); // two similarity, one paste, one focus
        expect(await (await call(ALICE, "POST", `/exams/${exam}/integrity/scan`)).json()).toEqual({
            raised: 0,
        });
        const flags = await flagsOf(ALICE, exam);
        expect(flags.map((f) => f.kind).sort()).toEqual([
            "large_paste",
            "many_focus_losses",
            "similarity",
            "similarity",
        ]);
        expect(flags.every((f) => f.state === "unreviewed" && f.rule_version === 1)).toBe(true);
        const paste = flags.find((f) => f.kind === "large_paste");
        expect(paste?.evidence).toMatchObject({ chars: 600 });
        const similar = flags.find(
            (f) => f.kind === "similarity" && f.email === "carol@example.com",
        );
        expect(similar?.evidence).toHaveProperty("other_session_id");
        expect(similar?.explanation).not.toMatch(/eve|frank/i);
        for (const user of [CAROL, DAVE, BOB])
            expect((await call(user, "GET", `/exams/${exam}/integrity/flags`)).status, user).toBe(
                404,
            );
        expect((await call(CAROL, "POST", `/exams/${exam}/integrity/scan`)).status).toBe(404);
    });
});

describe("deciding, appealing and reviewing", () => {
    it("lets staff decide once, shows the person only a confirmed flag, and keeps appeals with someone else", async () => {
        const exam = await sitAll();
        await call(ALICE, "POST", `/exams/${exam}/integrity/scan`);
        const flags = await flagsOf(ALICE, exam);
        const carol = flags.find((f) => f.kind === "similarity" && f.email === "carol@example.com");
        const eve = flags.find((f) => f.kind === "similarity" && f.email === "eve@example.com");
        const decide = (user: string, id: string, state: string) =>
            call(user, "PUT", `/exams/${exam}/integrity/flags/${id}`, {
                state,
                note: "read both answers",
            });
        expect(await mine(CAROL, exam)).toEqual([]); // nothing is shown before a person confirms
        expect((await decide(CAROL, carol?.flag_id ?? "", "confirmed")).status).toBe(404); // not staff
        expect((await decide(ALICE, carol?.flag_id ?? "", "unreviewed")).status).toBe(400);
        expect((await decide(ALICE, carol?.flag_id ?? "", "confirmed")).status).toBe(204);
        expect((await decide(ALICE, carol?.flag_id ?? "", "dismissed")).status).toBe(409); // decided once
        expect((await decide(ALICE, eve?.flag_id ?? "", "needs_review")).status).toBe(204);
        expect((await decide(ALICE, eve?.flag_id ?? "", "clear")).status).toBe(204); // needs_review then settles

        const shown = await mine(CAROL, exam);
        expect(shown).toHaveLength(1);
        expect(JSON.stringify(shown)).not.toMatch(/evidence|other_session|eve|frank/i);
        expect(await mine(EVE, exam)).toEqual([]); // cleared, and not hers to read about Carol's
        expect((await call(DAVE, "GET", `/exams/${exam}/integrity/mine`)).status).toBe(404);

        const appeal = (user: string, id: string) =>
            call(user, "POST", `/exams/${exam}/integrity/flags/${id}/appeal`, {
                note: "I wrote this alone.",
            });
        expect((await appeal(EVE, carol?.flag_id ?? "")).status).toBe(404); // someone else's flag
        expect((await appeal(CAROL, eve?.flag_id ?? "")).status).toBe(404); // not hers
        expect((await appeal(CAROL, carol?.flag_id ?? "")).status).toBe(204);
        expect((await appeal(CAROL, carol?.flag_id ?? "")).status).toBe(409); // once
        const withAppeal = (await flagsOf(ALICE, exam)).find((f) => f.flag_id === carol?.flag_id);
        expect(withAppeal?.appeal).toMatchObject({ state: "open", note: "I wrote this alone." });

        const review = (user: string, outcome: string) =>
            call(user, "PUT", `/exams/${exam}/integrity/appeals/${withAppeal?.appeal?.appeal_id}`, {
                outcome,
                note: "",
            });
        expect((await review(CAROL, "overturned")).status).toBe(404); // not staff
        expect((await review(ALICE, "overturned")).status).toBe(403); // the decider cannot review
        expect((await review(ERIN, "maybe")).status).toBe(400);
        expect((await review(ERIN, "overturned")).status).toBe(204);
        expect((await review(ERIN, "upheld")).status).toBe(409); // reviewed once
        const after = (await flagsOf(ERIN, exam)).find((f) => f.flag_id === carol?.flag_id);
        expect(after).toMatchObject({ state: "dismissed" });
        expect(after?.appeal?.state).toBe("overturned");
        expect(await mine(CAROL, exam)).toEqual([]);
    });
});
