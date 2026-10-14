// Goal: the practice bank through the real HTTP app and PostgreSQL. A platform administrator curates it (with
// a fresh step-up); anyone reads the list, the daily pick and a problem's statement; a signed-in stranger
// submits; the daily pick is the same for everyone on a day and moves across days; the staff routes for tasks
// stay closed to strangers; and a problem in a live contest is closed to practice.

import { randomBytes } from "node:crypto";
import {
    practiceDailySchema,
    practiceListSchema,
    practiceProblemSchema,
} from "@aura/contracts/api/practice";
import { submissionSchema } from "@aura/contracts/api/submissions";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC } from "./http-task-support.ts";

const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // a stranger to every organization
let h: Harness;
let platformOrg = "";
let privateOrg = "";
const versions: string[] = [];

async function releasedVersion(org: string, slug: string, visibility: string): Promise<string> {
    const { sql } = h.db.database;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${org}, ${slug}, 'algorithmic', ${visibility}, ${slug}, ${ALICE}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [v] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${org}, ${task?.id ?? ""}, 1, 'released', ${sql.json({ ...SPEC, title: `Problem ${slug}` })},
                ${`Add **${slug}** <script>alert(1)</script>`}, 10, ${randomBytes(32)}, ${ALICE}, ${BOB}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    return v?.id ?? "";
}

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`insert into users (id, email, email_verified_at) values (${DAVE}, 'dave@example.com', now())`;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    const [a] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('platform', 'bank-org', 'Bank') returning id`;
    const [b] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'closed-org', 'Closed') returning id`;
    platformOrg = a?.id ?? "";
    privateOrg = b?.id ?? "";
    for (let i = 0; i < 6; i++)
        versions.push(await releasedVersion(platformOrg, `bank-${i}`, "public"));
});
afterAll(async () => {
    await h.drop();
});

const call = async (
    user: string | null,
    method: string,
    path: string,
    body?: unknown,
    privileged = false,
) =>
    h.request(path, {
        method,
        headers: browser(
            user === null ? null : (await h.login(user, privileged)).token,
            body === undefined ? {} : { "content-type": "application/json" },
        ),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const curate = (version: string, user: string | null = ALICE, privileged = true) =>
    call(
        user,
        "POST",
        "/admin/practice",
        { task_version_id: encodeId("tsv", version) },
        privileged,
    );

describe("curating the bank", () => {
    it("is for platform administrators with a fresh step-up, and only public platform tasks", async () => {
        expect((await curate(versions[0] ?? "", null)).status).toBe(401);
        expect((await curate(versions[0] ?? "", DAVE)).status).toBe(404); // not an administrator
        const stale = await h.login(ALICE, true);
        h.clock.advance(16 * 60_000); // a step-up is fresh for 15 minutes
        const tooLate = await h.request("/admin/practice", {
            method: "POST",
            headers: browser(stale.token, { "content-type": "application/json" }),
            body: JSON.stringify({ task_version_id: encodeId("tsv", versions[0] ?? "") }),
        });
        expect(tooLate.status).toBe(403);
        const closed = await releasedVersion(privateOrg, "closed-1", "public"); // public, but not a platform org
        const hidden = await releasedVersion(platformOrg, "hidden-1", "private"); // platform, but not public
        expect((await curate(closed)).status).toBe(404);
        expect((await curate(hidden)).status).toBe(404);
        expect(
            (await call(ALICE, "POST", "/admin/practice", { task_version_id: "junk" }, true))
                .status,
        ).toBe(400);
        for (const v of versions) expect((await curate(v)).status).toBe(204);
        const list = practiceListSchema.parse(
            await (await call(null, "GET", "/practice?limit=4")).json(),
        );
        expect(list.items).toHaveLength(4);
        const rest = practiceListSchema.parse(
            await (await call(null, "GET", `/practice?limit=4&cursor=${list.next_cursor}`)).json(),
        );
        expect(new Set([...list.items, ...rest.items].map((i) => i.id)).size).toBe(6); // exact paging
        expect(rest.next_cursor).toBeNull();
    });
});

describe("reading", () => {
    it("serves a problem as an allowlist with safe HTML to anyone, and not the staff routes", async () => {
        const id = encodeId("tsv", versions[1] ?? "");
        const response = await call(null, "GET", `/practice/${id}`);
        expect(response.status).toBe(200);
        const problem = practiceProblemSchema.parse(await response.json());
        expect(problem).toMatchObject({
            title: "Problem bank-1",
            time_limit_ms: 1000,
            languages: ["cpp"],
        });
        expect(problem.statement_html).toContain("<strong>bank-1</strong>");
        expect(problem.statement_html).not.toContain("<script");
        expect(
            Object.keys(
                z
                    .record(z.string(), z.unknown())
                    .parse(await (await call(null, "GET", `/practice/${id}`)).json()),
            ).sort(),
        ).toEqual([
            "id",
            "languages",
            "memory_limit_kib",
            "statement_html",
            "time_limit_ms",
            "title",
        ]);
        const missing = encodeId("tsv", "018f0000-0000-7000-8000-0000000000ff");
        expect((await call(null, "GET", `/practice/${missing}`)).status).toBe(404);
        // The staff routes did not open: a stranger still cannot read the version or its task.
        expect((await call(DAVE, "GET", `/task-versions/${id}`)).status).toBe(404);
    });

    it("picks one problem a day for everyone, different on different days", async () => {
        const read = async () =>
            practiceDailySchema.parse(await (await call(null, "GET", "/practice/daily")).json());
        const first = await read();
        expect(first.problem).not.toBeNull();
        expect(await read()).toEqual(first); // stable within a day
        expect(first.day).toBe(new Date(h.clock.nowUnixMs()).toISOString().slice(0, 10));
        const picks = new Set<string>();
        for (let day = 0; day < 20; day++) {
            h.clock.advance(24 * 3_600_000);
            picks.add((await read()).problem?.id ?? "none");
        }
        expect(picks.size).toBeGreaterThan(2); // it moves, and over weeks it covers the bank
        expect(picks.has("none")).toBe(false);
    });
});

describe("submitting", () => {
    it("is for a signed-in stranger, in a language the task accepts, and is judged like any submission", async () => {
        const id = encodeId("tsv", versions[2] ?? "");
        const body = { language: "cpp", source: "int main(){}" };
        expect((await call(null, "POST", `/practice/${id}/submissions`, body)).status).toBe(401);
        expect(
            (
                await call(DAVE, "POST", `/practice/${id}/submissions`, {
                    ...body,
                    language: "python3",
                })
            ).status,
        ).toBe(400); // task says cpp only
        expect(
            (await call(DAVE, "POST", `/practice/${id}/submissions`, { ...body, extra: 1 })).status,
        ).toBe(400);
        const made = await call(DAVE, "POST", `/practice/${id}/submissions`, body);
        expect(made.status).toBe(201);
        const sub = submissionSchema.parse(await made.json());
        expect(sub.state).toBe("queued");
        const [job] = await h.db.database.sql<
            { priority: number; queue: string }[]
        >`select priority, queue from jobs order by id desc limit 1`;
        expect(job).toEqual({ priority: 5, queue: "judge" }); // practice, behind contests
        expect((await call(DAVE, "GET", `/submissions/${sub.id}`)).status).toBe(200); // their own
        expect((await call(BOB, "GET", `/submissions/${sub.id}`)).status).toBe(404); // not somebody else's
    });

    it("is closed for a problem of a contest that has not ended, here and on the organization route", async () => {
        const { sql } = h.db.database;
        const version = versions[3] ?? "";
        const [c] = await sql<
            { id: string }[]
        >`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, created_by)
            values (${platformOrg}, 'bank-cup', 'Cup', 'icpc', ${sql.json({ format: "icpc" })}, now() + interval '1 hour', now() + interval '6 hours', ${ALICE}) returning id`;
        await sql`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id) values (${c?.id ?? ""}, ${platformOrg}, 'A', ${version}, ${platformOrg})`;
        const orgVersion = await releasedVersion(platformOrg, "org-visible", "org");
        await sql`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id) values (${c?.id ?? ""}, ${platformOrg}, 'B', ${orgVersion}, ${platformOrg})`;
        await sql`update contests set state = 'scheduled' where id = ${c?.id ?? ""}`;
        const id = encodeId("tsv", version);
        const refused = await call(DAVE, "POST", `/practice/${id}/submissions`, {
            language: "cpp",
            source: "int main(){}",
        });
        expect(refused.status).toBe(409);
        // The same closure on the route for an organization's own people, with a task they can read.
        await sql`insert into memberships (org_id, user_id, role) values (${platformOrg}, ${DAVE}, 'member') on conflict do nothing`;
        const viaOrg = await call(
            DAVE,
            "POST",
            `/task-versions/${encodeId("tsv", orgVersion)}/submissions`,
            { language: "cpp", source: "int main(){}" },
        );
        expect(viaOrg.status).toBe(409);
    });
});

describe("unlisting", () => {
    it("takes a problem out of the bank, and a second time it is not there", async () => {
        const id = encodeId("tsv", versions[4] ?? "");
        expect((await call(DAVE, "DELETE", `/admin/practice/${id}`)).status).toBe(404);
        expect((await call(ALICE, "DELETE", `/admin/practice/${id}`, undefined, true)).status).toBe(
            204,
        );
        expect((await call(null, "GET", `/practice/${id}`)).status).toBe(404);
        expect((await call(ALICE, "DELETE", `/admin/practice/${id}`, undefined, true)).status).toBe(
            404,
        );
    });
});
