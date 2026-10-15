// Goal: finished events become credentials, completely and once. A rated contest gives each person who submitted a
// credential with their rank; a contest that was not rated gives none; a released exam gives each person who sat it
// a points band, except a person whose integrity flag was confirmed and not overturned; repeating changes nothing;
// the exam credential expires after the stated years and the contest one never does.

import { randomBytes } from "node:crypto";
import { credentialClaimSchema } from "@aura/contracts/credentials";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemRng } from "../../platform/rng.ts";
import { createDevelopmentSigner } from "../../platform/signer.ts";
import { createMemoryStorage } from "../../platform/storage-memory.ts";
import { createFakeClock } from "../../sim/world.ts";
import { issuerDid } from "./documents.ts";
import { issueNextEvent } from "./events.ts";
import { runPassportTick } from "./tick.ts";

const U = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const STAFF = U(900);
const MINUTE = 60_000;
const BASE = Date.UTC(2026, 9, 1);
const ORIGIN = "https://passport.example";
const clock = createFakeClock(BASE + 100 * 24 * 60 * MINUTE);
const signer = createDevelopmentSigner({ keyId: "dev-events-1", appEnvironment: "test" });
let db: TestDatabase;
let host = "";
let version = "";

const worker = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
const context = {
    clock,
    rng: systemRng,
    signer,
    issuerDid: issuerDid(ORIGIN),
    issuerName: "AuraLand (development)",
    publicOrigin: ORIGIN,
};
const next = () => worker((tx) => issueNextEvent(tx, context));
const claimsOf = async (event: string) => {
    const rows = await db.database.sql<
        {
            subject_user_id: string;
            claim: unknown;
            expires_at: Date | null;
            assurance_level: number;
        }[]
    >`
        select subject_user_id, claim, expires_at, assurance_level from credentials where event_id = ${event} order by subject_user_id`;
    return rows.map((r) => ({
        user: r.subject_user_id,
        claim: credentialClaimSchema.parse(r.claim),
        expires: r.expires_at,
        assurance: r.assurance_level,
    }));
};

beforeAll(async () => {
    db = await createMigratedTestDatabase(6);
    const { sql } = db.database;
    for (let n = 1; n <= 12; n++)
        await sql`insert into users (id, email, email_verified_at) values (${U(n)}, ${`p${n}@example.com`}, now())`;
    await sql`insert into users (id, email, email_verified_at) values (${STAFF}, 'staff@example.com', now())`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'events-uni', 'Events University') returning id`;
    host = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${host}, ${STAFF}, 'owner')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by) values (${host}, 'ev-task', 'algorithmic', 'private', 'T', ${U(1)}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [v] = await sql<
        { id: string }[]
    >`insert into task_versions (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json({ spec_version: 1 })}, 'x', 10, ${randomBytes(32)}, ${U(1)}, ${U(2)}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    version = v?.id ?? "";
    await worker(
        (tx) =>
            tx`select register_signing_key('dev-events-1', 'ES256', ${tx.json(signer.publicJwk())}, 'development', ${new Date(BASE)})`,
    );
});
afterAll(async () => {
    await db.drop();
});

async function contest(rated: boolean, rateIt: boolean, day: number): Promise<string> {
    const { sql } = db.database;
    const startsAt = BASE + day * 24 * 60 * MINUTE;
    const [c] = await sql<
        { id: string }[]
    >`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, created_by, rated)
        values (${host}, ${`ev-${day}`}, ${`Contest ${day}`}, 'icpc', ${sql.json({ format: "icpc" })}, ${new Date(startsAt)}, ${new Date(startsAt + 300 * MINUTE)}, ${U(1)}, ${rated}) returning id`;
    const id = c?.id ?? "";
    await sql`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id) values (${id}, ${host}, 'A', ${version}, ${host})`;
    for (const n of [1, 2, 3, 4, 5])
        await sql`insert into registrations (contest_id, user_id, created_at) values (${id}, ${U(n)}, ${new Date(startsAt - MINUTE)})`;
    for (const [i, n] of [1, 2, 3, 4].entries()) {
        const [s] = await sql<
            { id: string }[]
        >`insert into submissions (org_id, user_id, task_version_id, context_kind, context_id, language, source, source_sha256, source_bytes, created_at, updated_at)
            values (${host}, ${U(n)}, ${version}, 'contest', ${id}, 'cpp', 'x', ${randomBytes(32)}, 1, ${new Date(startsAt + (i + 1) * MINUTE)}, ${new Date(startsAt + (i + 1) * MINUTE)}) returning id`;
        await sql`update submissions set state = 'judging' where id = ${s?.id ?? ""}`;
        await sql`update submissions set state = 'judged', verdict = ${i < 2 ? "AC" : "WA"}, judged_at = now() where id = ${s?.id ?? ""}`;
    }
    for (const state of ["scheduled", "running", "ended"])
        await sql`update contests set state = ${state} where id = ${id}`;
    await sql`update contests set state = 'finalized', finalized_at = ${new Date(startsAt + 400 * MINUTE)} where id = ${id}`;
    if (rateIt)
        await sql`insert into contest_ratings (contest_id, org_id, dimension, status, participants, parameters_version, created_at) values (${id}, ${host}, 'contest', 'rated', 4, 1, now())`;
    return id;
}

describe("contests", () => {
    it("give a rank to each person who submitted, once, and nothing for a contest that was not rated", async () => {
        const unrated = await contest(true, false, 1); // finalized, rated flag, but no rating run (too small)
        const rated = await contest(true, true, 2);
        const first = await next();
        expect(first).toMatchObject({ kind: "contest", eventId: rated, issued: 4 }); // person 5 only registered
        const credentials = await claimsOf(rated);
        const byUser = new Map(credentials.map((c) => [c.user, c]));
        expect(credentials).toHaveLength(4);
        expect(byUser.get(U(5))).toBeUndefined();
        expect(byUser.get(U(1))?.claim).toMatchObject({
            kind: "contest_rank",
            rank: 1,
            solved: 1,
            participants: 4,
            event_title: "Contest 2",
            host_name: "Events University",
        });
        expect(byUser.get(U(2))?.claim).toMatchObject({ rank: 2 });
        expect(byUser.get(U(3))?.claim).toMatchObject({ rank: 3, solved: 0 });
        expect(byUser.get(U(4))?.claim).toMatchObject({ rank: 3 }); // a tie shares the rank
        expect(credentials.every((c) => c.expires === null && c.assurance === 0)).toBe(true);
        expect(await claimsOf(unrated)).toEqual([]);
        expect(await next()).toBeNull(); // nothing else is waiting; the unrated one never is
        const [done] = await db.database.sql<
            { n: number }[]
        >`select count(*)::int as n from passport_events_done`;
        expect(done?.n).toBe(1);
    });
});

async function exam(): Promise<string> {
    const { sql } = db.database;
    const [e] = await sql<
        { id: string }[]
    >`insert into exams (org_id, title, mode, duration_s, window_start, window_end, created_by)
        values (${host}, 'Lab exam', 'ai_free', 3600, ${new Date(BASE)}, ${new Date(BASE + 4 * 60 * MINUTE)}, ${STAFF}) returning id`;
    const id = e?.id ?? "";
    await sql`insert into exam_problems (exam_id, org_id, label, task_version_id, task_org_id, points, auto_percent, rubric)
        values (${id}, ${host}, 'A', ${version}, ${host}, 100, 70, ${sql.json([{ id: "style", label: "Style", max_points: 30 }])})`;
    for (const state of ["scheduled", "open", "closed"])
        await sql`update exams set state = ${state} where id = ${id}`;
    const sit = async (n: number, verdict: string, score: number, style: number) => {
        const [s] = await sql<
            { id: string }[]
        >`insert into exam_sessions (exam_id, org_id, user_id, created_at) values (${id}, ${host}, ${U(n)}, ${new Date(BASE)}) returning id`;
        const session = s?.id ?? "";
        await sql`update exam_sessions set state = 'consented', consent_at = ${new Date(BASE)}, consent_text_version = 1 where id = ${session}`;
        await sql`update exam_sessions set state = 'started', started_at = ${new Date(BASE)}, deadline_at = ${new Date(BASE + 60 * MINUTE)} where id = ${session}`;
        await sql`update exam_sessions set state = 'submitted', submitted_at = ${new Date(BASE + 30 * MINUTE)} where id = ${session}`;
        const [sub] = await sql<
            { id: string }[]
        >`insert into submissions (org_id, user_id, task_version_id, context_kind, context_id, language, source, source_sha256, source_bytes, created_at, updated_at)
            values (${host}, ${U(n)}, ${version}, 'exam', ${id}, 'cpp', 'x', ${randomBytes(32)}, 1, now(), now()) returning id`;
        await sql`update submissions set state = 'judging' where id = ${sub?.id ?? ""}`;
        await sql`update submissions set state = 'judged', verdict = ${verdict}, score = ${score}, judged_at = now() where id = ${sub?.id ?? ""}`;
        await sql`insert into exam_answers (session_id, problem_label, org_id, submission_id, created_at) values (${session}, 'A', ${host}, ${sub?.id ?? ""}, now())`;
        await sql`insert into exam_grades (session_id, problem_label, org_id, rubric_scores, graded_by, graded_at) values (${session}, 'A', ${host}, ${sql.json({ style })}, ${STAFF}, now())`;
        return session;
    };
    await sit(6, "AC", 100, 20); // 70 + 20 = 90
    await sit(7, "WA", 0, 0); // 0
    const blocked = await sit(8, "AC", 100, 30); // 100, but flagged
    await sql`insert into exam_sessions (exam_id, org_id, user_id, created_at) values (${id}, ${host}, ${U(9)}, ${new Date(BASE)})`; // joined, never started
    await inRole(
        db.database,
        "aura_app",
        { actorKind: "user", userId: STAFF, orgIds: [] },
        async (tx) => {
            await tx`select raise_integrity_flag(${id}, ${blocked}, 'A', 'large_paste', '{}'::jsonb, 'A large paste was recorded.', 1, ${new Date(BASE)})`;
            const [flag] = await tx<
                { id: string }[]
            >`select id from integrity_flags where session_id = ${blocked}`;
            await tx`select decide_integrity_flag(${flag?.id ?? ""}, 'confirmed', 'read both', ${new Date(BASE)})`;
        },
    );
    await sql`update exams set state = 'released', grades_released_at = ${new Date(BASE + 10 * 24 * 60 * MINUTE)} where id = ${id}`;
    return id;
}

describe("exams", () => {
    it("give each person who sat a points band, none to a confirmed flag, and an expiry five years out", async () => {
        const id = await exam();
        expect(await next()).toMatchObject({ kind: "exam", eventId: id, issued: 2 });
        const credentials = await claimsOf(id);
        const byUser = new Map(credentials.map((c) => [c.user, c]));
        expect(byUser.get(U(6))?.claim).toMatchObject({
            kind: "exam_result",
            points_band: "75-100",
            ai_mode: "ai_free",
            event_title: "Lab exam",
        });
        expect(byUser.get(U(7))?.claim).toMatchObject({ points_band: "0-24" });
        expect(byUser.get(U(8))).toBeUndefined(); // confirmed integrity flag
        expect(byUser.get(U(9))).toBeUndefined(); // never started
        const expires = byUser.get(U(6))?.expires;
        expect(
            new Date(expires ?? 0).getUTCFullYear() -
                new Date(BASE + 10 * 24 * 60 * MINUTE).getUTCFullYear(),
        ).toBe(5);
        expect(byUser.get(U(6))?.assurance).toBe(1);
        expect(await next()).toBeNull();
    });
});

describe("the worker tick", () => {
    it("registers a new development key, retires the old one, publishes, and then has nothing to do", async () => {
        const fresh = createDevelopmentSigner({ keyId: "dev-events-2", appEnvironment: "test" });
        const storage = createMemoryStorage(clock);
        const tick = () =>
            runPassportTick({
                clock,
                rng: systemRng,
                signer: fresh,
                storage,
                publicOrigin: ORIGIN,
                inTransaction: worker,
            });
        const first = await tick();
        expect(first.written).toBeGreaterThanOrEqual(3); // did.json, the key set, the revocation list
        const keys = await db.database.sql<
            { kid: string; status: string }[]
        >`select kid, status from signing_keys order by not_before, kid`;
        expect(keys).toEqual([
            { kid: "dev-events-1", status: "retired" },
            { kid: "dev-events-2", status: "active" },
        ]);
        const did = await storage.getSmall("public/passport/did.json", 100_000);
        const text = did.kind === "found" ? new TextDecoder().decode(did.bytes) : "";
        expect(text).toContain("dev-events-1");
        expect(text).toContain("dev-events-2");
        expect(await tick()).toEqual({ event: null, written: 0 });
    });
});
