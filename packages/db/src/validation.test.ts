// Goal: a task version becomes validated only through a passing report that the database itself
// checks, nobody but the two functions can start or finish validation, reports never change, and a
// node's attestation comes from its own row. Setup runs as the database owner; behaviour under test
// runs as the application and worker roles with real request contexts.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000010${n}`;
const OWNER = U(1);
const SETTER = U(2);
const REVIEWER = U(3);
const MEMBER = U(4);
const OUTSIDER = U(5);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const WORKER: RequestContext = { actorKind: "worker", userId: null, orgIds: [] };
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);
type Check = { name: string; ok: boolean; detail: string };
const PASS: Check[] = [{ name: "reference_passes", ok: true, detail: "" }];
const FAIL: Check[] = [
    ...PASS,
    { name: "wrong_fails:wrong_a", ok: false, detail: "passed every test" },
];

let db: TestDatabase;
let team = "";
let developmentNode = "";
let productionNode = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 4, 5])
        await sql`insert into users (id, email) values (${U(n)}, ${`v${n}@example.com`})`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'val-team', 'x') returning id`;
    team = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values
        (${team}, ${OWNER}, 'owner'), (${team}, ${SETTER}, 'setter'), (${team}, ${REVIEWER}, 'reviewer'),
        (${team}, ${MEMBER}, 'member')`;
    const node = async (name: string, attestation: string) => {
        const [row] = await sql<{ id: string }[]>`
            insert into judge_nodes (name, public_key, state, attestation, created_at)
            values (${name}, ${randomBytes(32)}, 'active', ${attestation}, now()) returning id`;
        return row?.id ?? "";
    };
    developmentNode = await node("dev-node", "development");
    productionNode = await node("prod-node", "production");
});
afterAll(async () => {
    await db.drop();
});

let counter = 0;
const app = <T>(userId: string, work: Parameters<typeof inRole<T>>[3]) =>
    inRole(db.database, "aura_app", as(userId), work);
const worker = <T>(work: Parameters<typeof inRole<T>>[3]) =>
    inRole(db.database, "aura_worker", WORKER, work);

// A version in review, made by SETTER and ready for validation.
async function inReview(): Promise<string> {
    const [task] = await app(
        SETTER,
        (tx) =>
            tx<
                { id: string }[]
            >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${team}, ${`vt-${++counter}`}, 'algorithmic', 'private', 'T', ${SETTER}) returning id`,
    );
    await db.database
        .sql`insert into task_assignments (task_id, org_id, user_id, assigned_by, created_at)
        values (${task?.id ?? ""}, ${team}, ${REVIEWER}, ${OWNER}, now())`;
    const [version] = await app(
        SETTER,
        (tx) =>
            tx<{ id: string }[]>`insert into task_versions (org_id, task_id, seq, created_by)
            values (${team}, ${task?.id ?? ""}, 1, ${SETTER}) returning id`,
    );
    const id = version?.id ?? "";
    const step = (changes: Record<string, unknown>) =>
        app(
            SETTER,
            (tx) => tx`update task_versions set ${tx(changes)} where id = ${id} returning id`,
        );
    await step({ state: "uploaded", bundle_bytes: 1000, bundle_sha256: randomBytes(32) });
    await step({ spec: { spec_version: 1 }, statement: "Add." });
    await step({ state: "in_review" });
    return id;
}

const request = (userId: string, versionId: string, readyMax = 100) =>
    app(userId, (tx) => tx`select request_validation(${versionId}, now(), ${readyMax})`);
const settle = (
    versionId: string,
    node: string,
    checks: Check[],
    observations: Record<string, number> = {},
) =>
    worker(
        (tx) =>
            tx<
                { settle_validation: string | null }[]
            >`select settle_validation(${versionId}, ${node},
                ${tx.json(checks)}, ${tx.json(observations)}, 88.5, 1, now())`,
    ).then((rows) => rows[0]?.settle_validation ?? null);
const stateOf = async (versionId: string) =>
    (
        await db.database.sql<
            { state: string }[]
        >`select state from task_versions where id = ${versionId}`
    )[0]?.state;

describe("starting validation", () => {
    it("is possible only through request_validation, by an owner, admin or reviewer", async () => {
        const id = await inReview();
        await fails(
            app(
                REVIEWER,
                (tx) =>
                    tx`update task_versions set state = 'validating' where id = ${id} returning id`,
            ),
            /row-level security/,
        );
        for (const outsider of [SETTER, MEMBER, OUTSIDER])
            await fails(request(outsider, id), /no such version/);
        expect(await stateOf(id)).toBe("in_review");
        await request(REVIEWER, id);
        expect(await stateOf(id)).toBe("validating");
        const [job] = await db.database
            .sql`select kind, queue, payload from jobs where queue = 'validate'
            and payload->>'task_version_id' = ${id}`;
        expect(job).toMatchObject({ kind: "task.validate", queue: "validate" });
        await fails(request(OWNER, id), /no such version/);
    });

    it("sheds load when the queue is full and then leaves the version untouched", async () => {
        const id = await inReview();
        await fails(request(REVIEWER, id, 0), /queue is full/);
        expect(await stateOf(id)).toBe("in_review");
    });
});

describe("finishing validation", () => {
    it("marks a version validated with a passing report that carries the node's own attestation", async () => {
        const id = await inReview();
        await request(REVIEWER, id);
        const report = await settle(id, productionNode, PASS, { runs: 3 });
        expect(report).not.toBeNull();
        expect(await stateOf(id)).toBe("validated");
        const [row] = await db.database
            .sql`select attestation, passed, node_id from validation_reports where id = ${report}`;
        expect(row).toMatchObject({
            attestation: "production",
            passed: true,
            node_id: productionNode,
        });
    });

    it("sends a version back to uploaded when a check fails, and keeps the report", async () => {
        const id = await inReview();
        await request(REVIEWER, id);
        await settle(id, developmentNode, FAIL);
        expect(await stateOf(id)).toBe("uploaded");
        const [row] = await db.database
            .sql`select attestation, passed from validation_reports where task_version_id = ${id}`;
        expect(row).toMatchObject({ attestation: "development", passed: false });
    });

    it("ignores a late or duplicate result and refuses an unknown or revoked node", async () => {
        const id = await inReview();
        expect(await settle(id, developmentNode, PASS)).toBeNull(); // not validating yet
        await request(REVIEWER, id);
        await fails(
            settle(id, "018f0000-0000-7000-8000-0000000fffff", PASS),
            /enrolled, live node|violates foreign key/,
        );
        await settle(id, developmentNode, PASS);
        expect(await settle(id, developmentNode, PASS)).toBeNull(); // already settled
        const revoked = await db.database.sql<
            { id: string }[]
        >`insert into judge_nodes (name, public_key, state, created_at)
            values ('revoked-one', ${randomBytes(32)}, 'revoked', now()) returning id`;
        const again = await inReview();
        await request(REVIEWER, again);
        await fails(settle(again, revoked[0]?.id ?? "", PASS), /enrolled, live node/);
    });

    it("cannot be forged by moving the state without a report", async () => {
        const id = await inReview();
        await request(REVIEWER, id);
        await fails(
            db.database.sql`update task_versions set state = 'validated' where id = ${id}`,
            /passing report/,
        );
        await settle(id, developmentNode, FAIL); // back to uploaded; a failing report is not enough
        const second = await inReview();
        await request(REVIEWER, second);
        await db.database
            .sql`insert into validation_reports (org_id, task_version_id, node_id, attestation, checks, observations, passed, created_at)
            values (${team}, ${second}, ${developmentNode}, 'development', ${db.database.sql.json(FAIL)}, '{}', false, now())`;
        await fails(
            db.database.sql`update task_versions set state = 'validated' where id = ${second}`,
            /passing report/,
        );
    });
});

describe("reports", () => {
    it("never change, are consistent with their checks, and are read by staff only", async () => {
        const id = await inReview();
        await request(REVIEWER, id);
        const report = await settle(id, developmentNode, PASS);
        await fails(
            db.database.sql`update validation_reports set passed = false where id = ${report}`,
            /never changed or deleted/,
        );
        await fails(
            db.database.sql`delete from validation_reports where id = ${report}`,
            /never changed or deleted/,
        );
        await fails(
            db.database
                .sql`insert into validation_reports (org_id, task_version_id, node_id, attestation, checks, observations, passed, created_at)
                values (${team}, ${id}, ${developmentNode}, 'development', ${db.database.sql.json(FAIL)}, '{}', true, now())`,
            /validation_reports_passed/,
        );
        for (const reader of [OWNER, REVIEWER]) {
            const rows = await app(
                reader,
                (tx) => tx`select id from validation_reports where id = ${report}`,
            );
            expect(rows.length).toBe(1);
        }
        for (const blocked of [MEMBER, OUTSIDER]) {
            const rows = await app(
                blocked,
                (tx) => tx`select id from validation_reports where id = ${report}`,
            );
            expect(rows.length).toBe(0);
        }
        await fails(
            app(
                OWNER,
                (
                    tx,
                ) => tx`insert into validation_reports (org_id, task_version_id, node_id, attestation, checks, observations, passed, created_at)
                values (${team}, ${id}, ${developmentNode}, 'production', '[{"ok":true}]', '{}', true, now())`,
            ),
            /permission denied/,
        );
    });

    it("keeps a node's attestation fixed", async () => {
        await fails(
            db.database
                .sql`update judge_nodes set attestation = 'production' where id = ${developmentNode}`,
            /keeps its name, key and attestation/,
        );
    });
});
