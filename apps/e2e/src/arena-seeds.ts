import { createHash, randomBytes } from "node:crypto";
import { createDatabase } from "@aura/db/client";
import { e2eDatabaseUrl } from "./test-helpers.ts";

// Seeds for the Arena browser tests: a running contest with a real statement, a stored scoreboard and an
// answered question. They write through the same tables and functions the worker and the API use, because
// the end-to-end environment runs no worker or judge.

const SEED_SPEC = {
    spec_version: 1,
    kind: "algorithmic",
    title: "Sum of two numbers",
    time_limit_ms: 1000,
    memory_limit_kib: 262144,
    output_limit_kib: 1024,
    languages: ["cpp"],
    scoring: { type: "binary", subtasks: [] },
    tests: [{ id: "001", group: "all", points: 100, is_sample: true }],
    checker: { type: "exact" },
    license: { owner: "Acme", terms: "internal use" },
    provenance: { author: "Alice", created: "2026-10-10", generated_with_ai: false },
};

type Sql = ReturnType<typeof createDatabase>["sql"];

// A released version of a task of `orgId`, with a real spec and statement.
async function seedArenaVersion(
    sql: Sql,
    orgId: string,
    slug: string,
    visibility = "private",
): Promise<string> {
    const [maker] = await sql<{ id: string }[]>`
        insert into users (email, email_verified_at) values (${`maker-${slug}@example.com`}, now()) returning id`;
    const [releaser] = await sql<{ id: string }[]>`
        insert into users (email, email_verified_at) values (${`releaser-${slug}@example.com`}, now()) returning id`;
    const [task] = await sql<{ id: string }[]>`
        insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${orgId}, ${`arena-task-${slug}`}, 'algorithmic', ${visibility}, 'Sum of two numbers', ${maker?.id ?? ""}) returning id`;
    const version = await sql.begin(async (tx) => {
        await tx`alter table task_versions disable trigger task_versions_guard`;
        const [row] = await tx<{ id: string }[]>`
            insert into task_versions (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256,
                                       created_by, released_by, released_at, waived, submitted_at)
            values (${orgId}, ${task?.id ?? ""}, 1, 'released', ${tx.json(SEED_SPEC)},
                    'Read **two** integers and print their sum.', 12, ${randomBytes(32)},
                    ${maker?.id ?? ""}, ${releaser?.id ?? ""}, now(), true, now()) returning id`;
        await tx`alter table task_versions enable trigger task_versions_guard`;
        return row;
    });
    return version?.id ?? "";
}

// A stored public scoreboard of `count` participants, planted through the function the worker would call.
async function seedArenaBoard(sql: Sql, contestId: string, count: number): Promise<void> {
    const rows = Array.from({ length: count }, (_, i) => ({
        rank: i + 1,
        participant: i + 1,
        handle: null,
        display_name: null,
        solved: i % 2 === 0 ? 1 : 0,
        penalty_minutes: i % 2 === 0 ? 10 + i : 0,
        points: 0,
        last_change_s: i % 2 === 0 ? 600 + i : null,
        cells: [
            {
                label: "A",
                solved: i % 2 === 0,
                attempts: 0,
                minutes: i % 2 === 0 ? 10 + i : null,
                points: 0,
                hidden: 0,
            },
        ],
    }));
    const body = {
        view: "public",
        format: "icpc",
        frozen: false,
        problems: [{ label: "A", points: 100 }],
        rows,
    };
    const etag = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await sql`select store_contest_scoreboard(${contestId}, 'seed', now(), ${etag}, ${sql.json(body)}, ${etag}, ${sql.json({ ...body, view: "final" })})`;
}

// A running public ICPC contest with one problem (a real statement), `email` registered for it and a stored
// scoreboard of `boardRows` participants. The end-to-end environment runs no worker. Returns the public id.
export async function seedRunningContest(email: string, boardRows = 3): Promise<string> {
    const database = createDatabase(e2eDatabaseUrl(), 1);
    try {
        const { sql } = database;
        const slug = randomBytes(4).toString("hex");
        const [person] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${email}, now())
            on conflict (email) do update set email = excluded.email returning id`;
        const [host] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('university', ${`arena-${slug}`}, 'Arena University') returning id`;
        const hostId = host?.id ?? "";
        const version = await seedArenaVersion(sql, hostId, slug);
        const now = Date.now();
        const [contest] = await sql<{ id: string }[]>`insert into contests
            (org_id, slug, title, format, rules, starts_at, ends_at, created_by)
            values (${hostId}, ${`arena-${slug}`}, ${`Arena Cup ${slug}`}, 'icpc', ${sql.json({ format: "icpc" })},
                    ${new Date(now - 600_000)}, ${new Date(now + 5 * 3_600_000)}, ${person?.id ?? ""}) returning id`;
        const id = contest?.id ?? "";
        await sql`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id)
            values (${id}, ${hostId}, 'A', ${version}, ${hostId})`;
        for (const state of ["scheduled", "running"]) {
            await sql`update contests set state = ${state} where id = ${id}`;
        }
        await sql`insert into registrations (contest_id, user_id, created_at) values (${id}, ${person?.id ?? ""}, now())`;
        await seedArenaBoard(sql, id, boardRows);
        return `cst_${id}`;
    } finally {
        await database.close(5);
    }
}

// The organizers' answer to a person's newest question in a contest, planted directly (answering is tested
// through the API; this lets a browser test see the answer).
export async function answerLatestClarification(
    contestPublicId: string,
    answer: string,
): Promise<void> {
    const database = createDatabase(e2eDatabaseUrl(), 1);
    try {
        const { sql } = database;
        const id = contestPublicId.replace("cst_", "");
        const [row] = await sql<{ id: string; org_id: string }[]>`
            select id, org_id from contest_clarifications where contest_id = ${id} order by id desc limit 1`;
        if (row === undefined) throw new Error("no question to answer");
        const [staff] = await sql<
            { id: string }[]
        >`select created_by as id from contests where id = ${id}`;
        await sql`update contest_clarifications set answer = ${answer}, public = true, answered_by = ${staff?.id ?? ""}, answered_at = now() where id = ${row.id}`;
    } finally {
        await database.close(5);
    }
}

// A problem in the practice bank: a released version of a public task of a platform organization, listed.
// Returns its public id and title.
export async function seedPracticeProblem(): Promise<{ id: string; title: string }> {
    const database = createDatabase(e2eDatabaseUrl(), 1);
    try {
        const { sql } = database;
        const slug = randomBytes(4).toString("hex");
        const [org] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('platform', ${`bank-${slug}`}, 'Problem bank') returning id`;
        const version = await seedArenaVersion(sql, org?.id ?? "", slug, "public");
        const [maker] = await sql<
            { id: string }[]
        >`select created_by as id from task_versions where id = ${version}`;
        await sql`insert into practice_bank (version_id, task_id, org_id, title, listed_by, listed_at)
            select v.id, v.task_id, v.org_id, ${`Sum of two numbers ${slug}`}, ${maker?.id ?? ""}, now()
            from task_versions v where v.id = ${version}`;
        return { id: `tsv_${version}`, title: `Sum of two numbers ${slug}` };
    } finally {
        await database.close(5);
    }
}

// Sets (or clears, with level "ok") the platform notice, as an administrator would.
export async function setPlatformStatus(level: string, message: string): Promise<void> {
    const database = createDatabase(e2eDatabaseUrl(), 1);
    try {
        await database.sql`update platform_status set level = ${level}, message = ${message}, updated_at = now()`;
    } finally {
        await database.close(5);
    }
}

// An exam that is open now (people may start), with a real statement, and `email` on its roster with
// `extraMinutes` of accommodation. Returns the exam's public id.
export async function seedOpenExam(email: string, extraMinutes = 0): Promise<string> {
    const database = createDatabase(e2eDatabaseUrl(), 1);
    try {
        const { sql } = database;
        const slug = randomBytes(4).toString("hex");
        const [host] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('university', ${`exam-${slug}`}, 'Exam University') returning id`;
        const hostId = host?.id ?? "";
        const version = await seedArenaVersion(sql, hostId, slug);
        const [maker] = await sql<
            { id: string }[]
        >`select created_by as id from task_versions where id = ${version}`;
        const now = Date.now();
        const [exam] = await sql<{ id: string }[]>`insert into exams
            (org_id, title, mode, duration_s, window_start, window_end, created_by)
            values (${hostId}, ${`Sitting ${slug}`}, 'ai_free', 5400, ${new Date(now - 300_000)}, ${new Date(now + 5 * 3_600_000)}, ${maker?.id ?? ""})
            returning id`;
        const id = exam?.id ?? "";
        await sql`insert into exam_problems (exam_id, org_id, label, task_version_id, task_org_id, points, auto_percent, rubric)
            values (${id}, ${hostId}, 'A', ${version}, ${hostId}, 100, 100, '[]'::jsonb)`;
        await sql`insert into exam_roster (exam_id, org_id, email, name, extra_minutes) values (${id}, ${hostId}, ${email}, 'Candidate', ${extraMinutes})`;
        await sql`insert into users (email, email_verified_at) values (${email}, now()) on conflict (email) do nothing`;
        for (const state of ["scheduled", "open"])
            await sql`update exams set state = ${state} where id = ${id}`;
        return `exm_${id}`;
    } finally {
        await database.close(5);
    }
}

// A closed exam with one candidate who handed in an answer the judge accepted (score 100), a problem worth 100
// points of which 70 are the judge's and 30 a rubric item, and `staffEmail` as the host's owner. Returns the
// exam's public id.
export async function seedClosedExam(staffEmail: string, candidateEmail: string): Promise<string> {
    const database = createDatabase(e2eDatabaseUrl(), 1);
    try {
        const { sql } = database;
        const slug = randomBytes(4).toString("hex");
        const [host] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('university', ${`closed-${slug}`}, 'Closed University') returning id`;
        const hostId = host?.id ?? "";
        const version = await seedArenaVersion(sql, hostId, slug);
        const [owner] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${staffEmail}, now())
            on conflict (email) do update set email = excluded.email returning id`;
        await sql`insert into memberships (org_id, user_id, role) values (${hostId}, ${owner?.id ?? ""}, 'owner')`;
        const [candidate] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${candidateEmail}, now())
            on conflict (email) do update set email = excluded.email returning id`;
        const now = Date.now();
        const [exam] = await sql<
            { id: string }[]
        >`insert into exams (org_id, title, mode, duration_s, window_start, window_end, created_by)
            values (${hostId}, ${`Graded ${slug}`}, 'ai_free', 3600, ${new Date(now - 3 * 3_600_000)}, ${new Date(now - 3_600_000)}, ${owner?.id ?? ""}) returning id`;
        const examId = exam?.id ?? "";
        await sql`insert into exam_problems (exam_id, org_id, label, task_version_id, task_org_id, points, auto_percent, rubric)
            values (${examId}, ${hostId}, 'A', ${version}, ${hostId}, 100, 70, ${sql.json([{ id: "style", label: "Readable code", max_points: 30 }])})`;
        await sql`insert into exam_roster (exam_id, org_id, email, name) values (${examId}, ${hostId}, ${candidateEmail}, 'Cora Candidate')`;
        for (const state of ["scheduled", "open"])
            await sql`update exams set state = ${state} where id = ${examId}`;
        const [session] = await sql<
            { id: string }[]
        >`insert into exam_sessions (exam_id, org_id, user_id, created_at)
            values (${examId}, ${hostId}, ${candidate?.id ?? ""}, ${new Date(now - 3 * 3_600_000)}) returning id`;
        const sessionId = session?.id ?? "";
        const started = new Date(now - 2.5 * 3_600_000);
        await sql`update exam_sessions set state = 'consented', consent_at = ${started}, consent_text_version = 1 where id = ${sessionId}`;
        await sql`update exam_sessions set state = 'started', started_at = ${started}, deadline_at = ${new Date(now - 1.5 * 3_600_000)} where id = ${sessionId}`;
        await sql`insert into exam_drafts (session_id, org_id, problem_label, seq, language, content, content_sha256, saved_at)
            values (${sessionId}, ${hostId}, 'A', 1, 'cpp', 'int main() { return 0; }', ${createHash("sha256").update("int main() { return 0; }").digest()}, ${started})`;
        await sql`update exam_sessions set state = 'submitted', submitted_at = ${new Date(now - 2 * 3_600_000)} where id = ${sessionId}`;
        const [submission] = await sql<{ id: string }[]>`insert into submissions
            (org_id, user_id, task_version_id, context_kind, context_id, language, source, source_sha256, source_bytes, created_at, updated_at)
            values (${hostId}, ${candidate?.id ?? ""}, ${version}, 'exam', ${examId}, 'cpp', 'int main() { return 0; }', ${randomBytes(32)}, 24, ${started}, ${started}) returning id`;
        const submissionId = submission?.id ?? "";
        await sql`update submissions set state = 'judging' where id = ${submissionId}`;
        await sql`update submissions set state = 'judged', verdict = 'AC', score = 100, judged_at = now() where id = ${submissionId}`;
        await sql`insert into exam_answers (session_id, problem_label, org_id, submission_id, created_at) values (${sessionId}, 'A', ${hostId}, ${submissionId}, ${started})`;
        await sql`update exams set state = 'closed' where id = ${examId}`;
        return `exm_${examId}`;
    } finally {
        await database.close(5);
    }
}

// How many telemetry events a sitting of an exam has recorded (the browser tests read the record, as staff would).
export async function countTelemetry(examPublicId: string): Promise<number> {
    const database = createDatabase(e2eDatabaseUrl(), 1);
    try {
        const rows = await database.sql<{ n: number }[]>`
            select count(*)::int as n from telemetry_events t join exam_sessions s on s.id = t.session_id
             where s.exam_id = ${examPublicId.replace("exm_", "")}`;
        return rows[0]?.n ?? 0;
    } finally {
        await database.close(5);
    }
}
