// Goal: every route under /api/v1 must declare who may call it, and the declaration must be true.
// The test reads the app's real route table, so a new route without a row (or a row for a route
// that no longer exists) fails CI. It then generates the checks from the rows:
//   anonymous callers get 401 on routes that need a person,
//   a valid session without the custom CSRF header gets 403 on every state-changing route,
//   another person's valid session gets 404 on routes that address one of the caller's own objects.
import { randomBytes } from "node:crypto";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

interface Row {
    readonly method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
    readonly path: string;
    // "public": anyone, including anonymous callers. "user": a signed-in person.
    // "key": reachable by an API key (or refused with 403 to anyone else); "admin": platform
    // administrators only (404 for everyone else).
    readonly access: "public" | "user" | "key" | "admin";
    // The path addresses an object owned by one person; another person must get 404, not 403.
    readonly owned?: true;
    // What kind of object `:id` names. Defaults to a session.
    readonly object?:
        | "pky"
        | "org"
        | "usr"
        | "tsk"
        | "tsv"
        | "sub"
        | "nod"
        | "ord"
        | "dlv"
        | "pay"
        | "cst";
    // A valid request body for rows that need one, so the check reaches authorization.
    readonly body?: Record<string, unknown>;
}

const SAMPLE_UUID = "018f0000-0000-7000-8000-0000000000ee";

// Add a row in the same pull request that adds a route. This list is the written access policy.
const MATRIX: readonly Row[] = [
    { method: "GET", path: "/api/v1/me", access: "user" },
    { method: "GET", path: "/api/v1/me/sessions", access: "user" },
    { method: "DELETE", path: "/api/v1/me/sessions/:id", access: "user", owned: true },
    // Idempotent on purpose: with no session it still succeeds and clears a stale cookie.
    { method: "POST", path: "/api/v1/auth/logout", access: "public" },
    { method: "POST", path: "/api/v1/auth/logout-all", access: "user" },
    // Anonymous by nature: these start a login. They are limited per address and per email, and
    // answer the same whether or not an account exists.
    { method: "POST", path: "/api/v1/auth/email/start", access: "public" },
    { method: "POST", path: "/api/v1/auth/email/verify", access: "public" },
    // Registration needs a signed-in person; the sign-in ceremony is anonymous by nature.
    { method: "POST", path: "/api/v1/auth/passkey/register/options", access: "user" },
    { method: "POST", path: "/api/v1/auth/passkey/register/verify", access: "user" },
    { method: "POST", path: "/api/v1/auth/passkey/login/options", access: "public" },
    { method: "POST", path: "/api/v1/auth/passkey/login/verify", access: "public" },
    // Anonymous by nature; "link" needs a signed-in person, which the handler checks itself.
    { method: "POST", path: "/api/v1/auth/oauth/:provider/start", access: "public" },
    { method: "GET", path: "/api/v1/auth/oauth/:provider/callback", access: "public" },
    { method: "GET", path: "/api/v1/me/identities", access: "user" },
    { method: "DELETE", path: "/api/v1/me/identities/:provider", access: "user" },
    { method: "POST", path: "/api/v1/orgs", access: "user" },
    { method: "GET", path: "/api/v1/orgs", access: "user" },
    { method: "GET", path: "/api/v1/orgs/:id", access: "user", owned: true, object: "org" },
    { method: "PATCH", path: "/api/v1/orgs/:id", access: "user", owned: true, object: "org" },
    { method: "GET", path: "/api/v1/orgs/:id/members", access: "user", owned: true, object: "org" },
    {
        method: "PATCH",
        path: "/api/v1/orgs/:id/members/:userId",
        access: "user",
        owned: true,
        object: "org",
        body: { role: "member" },
    },
    {
        method: "DELETE",
        path: "/api/v1/orgs/:id/members/:userId",
        access: "user",
        owned: true,
        object: "org",
    },
    {
        method: "POST",
        path: "/api/v1/orgs/:id/api-keys",
        access: "user",
        owned: true,
        object: "org",
        body: { name: "ci" },
    },
    {
        method: "GET",
        path: "/api/v1/orgs/:id/api-keys",
        access: "user",
        owned: true,
        object: "org",
    },
    {
        method: "DELETE",
        path: "/api/v1/orgs/:id/api-keys/:keyId",
        access: "user",
        owned: true,
        object: "org",
    },
    {
        method: "POST",
        path: "/api/v1/orgs/:id/invitations",
        access: "user",
        owned: true,
        object: "org",
        body: { email: "someone@example.com" },
    },
    {
        method: "GET",
        path: "/api/v1/orgs/:id/invitations",
        access: "user",
        owned: true,
        object: "org",
    },
    {
        method: "DELETE",
        path: "/api/v1/orgs/:id/invitations/:invitationId",
        access: "user",
        owned: true,
        object: "org",
    },
    { method: "POST", path: "/api/v1/invitations/accept", access: "user" },
    { method: "GET", path: "/api/v1/key", access: "key" },
    {
        method: "POST",
        path: "/api/v1/admin/orgs/:id/verify",
        access: "admin",
        owned: true,
        object: "org",
    },
    {
        method: "POST",
        path: "/api/v1/admin/users/:id/revoke-sessions",
        access: "admin",
        object: "usr",
    },
    { method: "POST", path: "/api/v1/auth/passkey/step-up/options", access: "user" },
    { method: "POST", path: "/api/v1/auth/passkey/step-up/verify", access: "user" },
    { method: "GET", path: "/api/v1/auth/methods", access: "public" },
    { method: "GET", path: "/api/v1/me/status", access: "public" },
    { method: "GET", path: "/api/v1/me/export", access: "user" },
    { method: "POST", path: "/api/v1/me/delete-request", access: "user" },
    { method: "DELETE", path: "/api/v1/me/delete-request", access: "user" },
    { method: "POST", path: "/api/v1/me/sessions/revoke-others", access: "user" },
    { method: "GET", path: "/api/v1/me/passkeys", access: "user" },
    {
        method: "PATCH",
        path: "/api/v1/me/passkeys/:id",
        access: "user",
        owned: true,
        object: "pky",
    },
    {
        method: "DELETE",
        path: "/api/v1/me/passkeys/:id",
        access: "user",
        owned: true,
        object: "pky",
    },
    { method: "POST", path: "/api/v1/tasks", access: "user" },
    { method: "GET", path: "/api/v1/tasks", access: "user" },
    { method: "GET", path: "/api/v1/tasks/:id", access: "user", owned: true, object: "tsk" },
    {
        method: "POST",
        path: "/api/v1/tasks/:id/versions",
        access: "user",
        owned: true,
        object: "tsk",
        body: {},
    },
    {
        method: "GET",
        path: "/api/v1/tasks/:id/versions",
        access: "user",
        owned: true,
        object: "tsk",
    },
    {
        method: "GET",
        path: "/api/v1/task-versions/:id",
        access: "user",
        owned: true,
        object: "tsv",
    },
    {
        method: "PATCH",
        path: "/api/v1/task-versions/:id",
        access: "user",
        owned: true,
        object: "tsv",
        body: { statement: "Changed" },
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/uploads",
        access: "user",
        owned: true,
        object: "tsv",
        body: { bytes: 10, sha256: "a".repeat(64) },
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/finalize",
        access: "user",
        owned: true,
        object: "tsv",
        body: { upload_id: `bup_${SAMPLE_UUID}` },
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/submit-review",
        access: "user",
        owned: true,
        object: "tsv",
    },
    {
        method: "GET",
        path: "/api/v1/task-versions/:id/validation",
        access: "user",
        owned: true,
        object: "tsv",
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/validate",
        access: "user",
        owned: true,
        object: "tsv",
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/abandon",
        access: "user",
        owned: true,
        object: "tsv",
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/retire",
        access: "user",
        owned: true,
        object: "tsv",
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/review",
        access: "user",
        owned: true,
        object: "tsv",
        body: { outcome: "approved" },
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/release",
        access: "user",
        owned: true,
        object: "tsv",
        body: {},
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/submissions",
        access: "user",
        owned: true,
        object: "tsv",
        body: { language: "cpp", source: "int main() {}" },
    },
    { method: "GET", path: "/api/v1/submissions", access: "user" },
    { method: "POST", path: "/api/v1/admin/judge-nodes/enrollments", access: "admin" },
    {
        method: "POST",
        path: "/api/v1/admin/judge-nodes/:id/revoke",
        access: "admin",
        owned: true,
        object: "nod",
    },
    { method: "GET", path: "/api/v1/admin/orders", access: "admin" },
    {
        method: "POST",
        path: "/api/v1/admin/orders",
        access: "admin",
        body: { title: "x", licence_terms: "y", delivery_days: 30 },
    },
    {
        method: "GET",
        path: "/api/v1/admin/orders/:id",
        access: "admin",
        owned: true,
        object: "ord",
    },
    {
        method: "POST",
        path: "/api/v1/admin/orders/:id/items",
        access: "admin",
        owned: true,
        object: "ord",
    },
    {
        method: "DELETE",
        path: "/api/v1/admin/orders/:id/items/:versionId",
        access: "admin",
        owned: true,
        object: "ord",
    },
    {
        method: "PUT",
        path: "/api/v1/admin/orders/:id/invoice",
        access: "admin",
        owned: true,
        object: "ord",
    },
    {
        method: "POST",
        path: "/api/v1/admin/orders/:id/place",
        access: "admin",
        owned: true,
        object: "ord",
    },
    {
        method: "POST",
        path: "/api/v1/admin/orders/:id/cancel",
        access: "admin",
        owned: true,
        object: "ord",
    },
    {
        method: "POST",
        path: "/api/v1/admin/deliveries/:id/revoke",
        access: "admin",
        owned: true,
        object: "dlv",
    },
    {
        method: "POST",
        path: "/api/v1/admin/orders/:id/paid",
        access: "admin",
        owned: true,
        object: "ord",
    },
    { method: "GET", path: "/api/v1/admin/payouts", access: "admin" },
    { method: "GET", path: "/api/v1/me/payouts", access: "user" },
    {
        method: "POST",
        path: "/api/v1/admin/payouts",
        access: "admin",
        body: {
            contractor_id: encodeId("usr", SAMPLE_UUID),
            task_version_id: encodeId("tsv", SAMPLE_UUID),
            amount_minor: 100,
            currency: "USD",
        },
    },
    {
        method: "POST",
        path: "/api/v1/admin/payouts/:id/paid",
        access: "admin",
        owned: true,
        object: "pay",
        body: { reference: "wire-1" },
    },
    {
        method: "GET",
        path: "/api/v1/tasks/:id/assignments",
        access: "user",
        owned: true,
        object: "tsk",
    },
    {
        method: "POST",
        path: "/api/v1/tasks/:id/assignments",
        access: "user",
        owned: true,
        object: "tsk",
        body: { user_id: encodeId("usr", SAMPLE_UUID) },
    },
    {
        method: "DELETE",
        path: "/api/v1/tasks/:id/assignments/:userId",
        access: "user",
        owned: true,
        object: "tsk",
    },
    {
        method: "GET",
        path: "/api/v1/task-versions/:id/comments",
        access: "user",
        owned: true,
        object: "tsv",
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/comments",
        access: "user",
        owned: true,
        object: "tsv",
        body: { body: "hello" },
    },
    {
        method: "GET",
        path: "/api/v1/task-versions/:id/attacks",
        access: "user",
        owned: true,
        object: "tsv",
    },
    {
        method: "POST",
        path: "/api/v1/task-versions/:id/attacks",
        access: "user",
        owned: true,
        object: "tsv",
        body: { outcome: "held", method: "tried the samples" },
    },
    { method: "GET", path: "/api/v1/contests", access: "public" },
    { method: "GET", path: "/api/v1/contests/:id", access: "public", object: "cst" },
    {
        method: "POST",
        path: "/api/v1/orgs/:id/contests",
        access: "user",
        owned: true,
        object: "org",
        body: {
            slug: "matrix-contest",
            title: "Matrix",
            rules: { format: "icpc" },
            starts_at: "2030-01-01T10:00:00Z",
            ends_at: "2030-01-01T15:00:00Z",
        },
    },
    {
        method: "PATCH",
        path: "/api/v1/contests/:id",
        access: "user",
        owned: true,
        object: "cst",
        body: { title: "x" },
    },
    {
        method: "POST",
        path: "/api/v1/contests/:id/problems",
        access: "user",
        owned: true,
        object: "cst",
        body: { label: "A", task_version_id: "tsv_018f0000-0000-7000-8000-000000000001" },
    },
    {
        method: "DELETE",
        path: "/api/v1/contests/:id/problems/:label",
        access: "user",
        owned: true,
        object: "cst",
    },
    {
        method: "POST",
        path: "/api/v1/contests/:id/publish",
        access: "user",
        owned: true,
        object: "cst",
    },
    {
        method: "POST",
        path: "/api/v1/contests/:id/finalize",
        access: "user",
        owned: true,
        object: "cst",
    },
    {
        method: "POST",
        path: "/api/v1/contests/:id/registrations",
        access: "user",
        owned: true,
        object: "cst",
    },
    { method: "GET", path: "/api/v1/deliveries", access: "user" },
    { method: "GET", path: "/api/v1/deliveries/:id", access: "user", owned: true, object: "dlv" },
    {
        method: "POST",
        path: "/api/v1/deliveries/:id/downloads",
        access: "user",
        owned: true,
        object: "dlv",
        body: { task_version_id: encodeId("tsv", SAMPLE_UUID) },
    },
    { method: "GET", path: "/api/v1/submissions/:id", access: "user", owned: true, object: "sub" },
    {
        method: "PATCH",
        path: "/api/v1/tasks/:id",
        access: "user",
        owned: true,
        object: "tsk",
        body: { title: "Renamed" },
    },
];

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
});
afterAll(async () => {
    await h.drop();
});

const concrete = (row: Row) =>
    row.path
        .replace(":id", encodeId(row.object ?? "ses", SAMPLE_UUID))
        .replace(":userId", encodeId("usr", SAMPLE_UUID))
        .replace(":keyId", encodeId("key", SAMPLE_UUID))
        .replace(":invitationId", encodeId("inv", SAMPLE_UUID))
        .replace(":versionId", encodeId("tsv", SAMPLE_UUID))
        .replace(":label", "A");
const call = (row: Row, headers: Record<string, string>) =>
    h.app().request(concrete(row), { method: row.method, headers });

// A private task in an organization only the victim belongs to.
let victimTasksOrg = "";
async function victimTask(): Promise<{ task: string; version: string }> {
    if (victimTasksOrg === "") {
        const [created] = await h.db.database.sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('company', ${`tasks-${randomBytes(4).toString("hex")}`}, 'Victim tasks')
            returning id`;
        victimTasksOrg = created?.id ?? "";
        await h.db.database
            .sql`insert into memberships (org_id, user_id, role) values (${victimTasksOrg}, ${ALICE}, 'owner')`;
    }
    const org = { id: victimTasksOrg };
    const [task] = await h.db.database.sql<{ id: string }[]>`
        insert into tasks (org_id, slug, kind, title, created_by)
        values (${org?.id ?? ""}, ${`t-${randomBytes(4).toString("hex")}`}, 'algorithmic', 'Secret', ${ALICE})
        returning id`;
    const [version] = await h.db.database.sql<{ id: string }[]>`
        insert into task_versions (org_id, task_id, seq, created_by)
        values (${org?.id ?? ""}, ${task?.id ?? ""}, 1, ${ALICE}) returning id`;
    return { task: task?.id ?? "", version: version?.id ?? "" };
}

// A submission by the victim. The version is not released (that takes a whole review), so the guard
// trigger that insists on a released version is paused for this one insert.
async function victimSubmission(): Promise<string> {
    const { task, version } = await victimTask();
    const { sql } = h.db.database;
    const [row] = await sql<{ org_id: string }[]>`select org_id from tasks where id = ${task}`;
    await sql`alter table submissions disable trigger submissions_guard`;
    try {
        const [made] = await sql<{ id: string }[]>`
            insert into submissions (org_id, user_id, task_version_id, language, source, source_sha256, source_bytes, created_at, updated_at)
            values (${row?.org_id ?? ""}, ${ALICE}, ${version}, 'cpp', 'x', ${Buffer.alloc(32, 2)}, 1, now(), now()) returning id`;
        return made?.id ?? "";
    } finally {
        await sql`alter table submissions enable trigger submissions_guard`;
    }
}

// An object owned by the victim that the row's path can name.
// A draft contest of an organization only the victim belongs to: nobody else can even see it.
async function victimContest(): Promise<string> {
    const { sql } = h.db.database;
    const [org] = await sql<{ id: string }[]>`
        insert into orgs (kind, slug, name) values ('university', ${`victim-${randomBytes(4).toString("hex")}`}, 'Victim uni')
        returning id`;
    await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${ALICE}, 'owner')`;
    const [contest] = await sql<{ id: string }[]>`
        insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, created_by)
        values (${org?.id ?? ""}, ${`c-${randomBytes(4).toString("hex")}`}, 'Victim contest', 'icpc',
                ${sql.json({ format: "icpc" })}, '2030-01-01T10:00:00Z', '2030-01-01T15:00:00Z', ${ALICE})
        returning id`;
    return contest?.id ?? "";
}

async function victimObject(row: Row, sessionId: string): Promise<string> {
    if (row.object === "org") {
        const [org] = await h.db.database.sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('company', ${`victim-${randomBytes(4).toString("hex")}`}, 'Victim team')
            returning id`;
        await h.db.database
            .sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${ALICE}, 'owner')`;
        return encodeId("org", org?.id ?? "");
    }
    if (row.object === "cst") return encodeId("cst", await victimContest());
    if (row.object === "tsk") return encodeId("tsk", (await victimTask()).task);
    if (row.object === "tsv") return encodeId("tsv", (await victimTask()).version);
    if (row.object === "sub") return encodeId("sub", await victimSubmission());
    if (row.object === "nod") return encodeId("nod", SAMPLE_UUID);
    if (row.object === "ord") return encodeId("ord", SAMPLE_UUID);
    if (row.object === "dlv") return encodeId("dlv", SAMPLE_UUID);
    if (row.object === "pay") return encodeId("pay", SAMPLE_UUID);
    if (row.object !== "pky") return encodeId("ses", sessionId);
    const [created] = await h.db.database.sql<{ id: string }[]>`
        insert into passkeys (user_id, credential_id, public_key, device_type, backed_up, name)
        values (${ALICE}, ${randomBytes(32)}, ${randomBytes(77)}, 'singleDevice', false, 'Victim key')
        returning id`;
    return encodeId("pky", created?.id ?? "");
}

describe("route table", () => {
    it("matches the declared matrix exactly", () => {
        const registered = h
            .app()
            .routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/api/v1"))
            .map((r) => `${r.method} ${r.path}`)
            .sort();
        const declared = MATRIX.map((r) => `${r.method} ${r.path}`).sort();
        expect(registered).toEqual(declared);
    });

    it("answers 404 for paths that are not declared", async () => {
        const { token } = await h.login(ALICE);
        for (const path of ["/api/v1/nothing", "/api/v1/me/secrets", "/api/v1/admin"]) {
            const response = await h.app().request(path, { headers: browser(token) });
            expect(response.status, path).toBe(404);
        }
    });
});

describe("generated checks", () => {
    for (const row of MATRIX) {
        const name = `${row.method} ${row.path}`;

        if (row.access !== "public") {
            it(`${name}: anonymous callers get 401`, async () => {
                const response = await call(row, browser(null));
                expect(response.status).toBe(401);
            });
        }

        if (UNSAFE.has(row.method)) {
            it(`${name}: refuses a valid session without the CSRF header with 403`, async () => {
                const { token } = await h.login(ALICE);
                const headers = browser(token);
                delete headers["x-aura-request"];
                expect((await call(row, headers)).status).toBe(403);
            });
        }

        if (row.owned === true) {
            it(`${name}: another person's valid session gets 404, never the object`, async () => {
                const victim = await h.login(ALICE);
                const intruder = await h.login(BOB);
                const objectId = await victimObject(row, victim.session.id);
                const path = row.path
                    .replace(":id", objectId)
                    .replace(":userId", encodeId("usr", ALICE))
                    .replace(":keyId", encodeId("key", SAMPLE_UUID))
                    .replace(":invitationId", encodeId("inv", SAMPLE_UUID))
                    .replace(":versionId", encodeId("tsv", SAMPLE_UUID))
                    .replace(":label", "A");
                const hasBody =
                    row.method === "PATCH" || row.method === "PUT" || row.body !== undefined;
                const response = await h.app().request(path, {
                    method: row.method,
                    headers: browser(
                        intruder.token,
                        hasBody ? { "content-type": "application/json" } : {},
                    ),
                    ...(hasBody ? { body: JSON.stringify(row.body ?? { name: "intruder" }) } : {}),
                });
                expect(response.status).toBe(404);
                expect((await h.request("/me", { headers: browser(victim.token) })).status).toBe(
                    200,
                );
            });
        }
    }
});
