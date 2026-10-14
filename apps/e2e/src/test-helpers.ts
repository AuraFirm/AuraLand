import { createHash, randomBytes } from "node:crypto";
import { createDatabase } from "@aura/db/client";
import { AxeBuilder } from "@axe-core/playwright";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { z } from "zod";

// Shared helpers for the end-to-end tests: reading email from Mailpit, a virtual passkey device for
// Chromium, a watcher for content-security-policy violations, and the accessibility check.

function mailpitBase(): string {
    const url = process.env["AURA_TEST_MAILPIT_URL"];
    if (url === undefined || url === "") throw new Error("AURA_TEST_MAILPIT_URL must be set");
    return url;
}

const listSchema = z.object({
    messages: z.array(
        z.object({
            ID: z.string(),
            Subject: z.string(),
            To: z.array(z.object({ Address: z.string() })),
        }),
    ),
});
const messageSchema = z.object({ Text: z.string() });

let emailCounter = 0;
export function freshEmail(): string {
    return `e2e-${Date.now()}-${++emailCounter}@example.com`;
}

// Waits for the newest message sent to this address and returns its plain text.
export async function waitForMail(to: string, subject = ""): Promise<string> {
    for (let attempt = 0; attempt < 40; attempt++) {
        const listed = listSchema.parse(
            await (await fetch(`${mailpitBase()}/api/v1/messages`)).json(),
        );
        const found = listed.messages.find(
            (m) => m.Subject.includes(subject) && m.To.some((t) => t.Address === to),
        );
        if (found !== undefined) {
            const full = messageSchema.parse(
                await (await fetch(`${mailpitBase()}/api/v1/message/${found.ID}`)).json(),
            );
            return full.Text;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`no email arrived for ${to}`);
}

export const linkIn = (text: string): string => {
    const match = /(https?:\/\/\S+\/auth\/verify#t=[A-Za-z0-9_-]+)/.exec(text);
    if (match?.[1] === undefined) throw new Error("no sign-in link in the email");
    return match[1];
};

export const invitationLinkIn = (text: string): string => {
    const match = /(https?:\/\/\S+\/invitations\/accept#t=[A-Za-z0-9_-]+)/.exec(text);
    if (match?.[1] === undefined) throw new Error("no invitation link in the email");
    return match[1];
};

export const codeIn = (text: string): string => {
    const match = /(\d{4}) (\d{4})/.exec(text);
    if (match?.[1] === undefined || match[2] === undefined) throw new Error("no code in the email");
    return `${match[1]}${match[2]}`;
};

// A software authenticator inside Chromium, so passkey prompts resolve without a person.
export async function addVirtualAuthenticator(page: Page): Promise<void> {
    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    await client.send("WebAuthn.addVirtualAuthenticator", {
        options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
}

// Records every content-security-policy violation, page error and console error on the page, across
// navigations. Call it before the first `goto`.
export async function watchForCspProblems(page: Page): Promise<() => string[]> {
    const problems: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    await page.exposeFunction("reportCspViolation", (text: string) => problems.push(text));
    await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
            const report = Reflect.get(window, "reportCspViolation");
            const where = `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`;
            report(
                `CSP violation: ${event.violatedDirective} blocked ${event.blockedURI} at ${where} (${event.sample})`,
            );
        });
    });
    return () => problems;
}

export async function expectAccessible(page: Page): Promise<void> {
    const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    const summary = results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
    expect(summary, "accessibility violations").toEqual([]);
}

// On the sign-in page: asks for the emailed code and enters it. Where the person lands is up to the caller.
export async function signInWithEmailCode(page: Page, email: string): Promise<void> {
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Email me a link and code" }).click();
    const code = codeIn(await waitForMail(email, "sign-in"));
    await page.getByLabel("Code").fill(code);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// Signs in by email code and lands on the account page.
export async function signInByEmail(page: Page, email: string): Promise<void> {
    await page.goto("/sign-in");
    await signInWithEmailCode(page, email);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
}

// Starts a session for this email without going through the sign-in screens, so tests that are not
// about signing in do not each spend one of the (deliberately small) sign-in rate-limit allowances.
// It writes the same rows a real sign-in would, directly into the test database, and gives the
// browser the cookie.
// `stepUp` makes the session carry a passkey check from just now, as a passkey sign-in would.
export async function loginAs(
    context: BrowserContext,
    email: string,
    options: { stepUp?: boolean } = {},
): Promise<void> {
    const url = process.env["AURA_E2E_DATABASE_URL"];
    if (url === undefined || url === "") throw new Error("AURA_E2E_DATABASE_URL must be set");
    const token = randomBytes(32).toString("base64url");
    const database = createDatabase(url, 1);
    try {
        const { sql } = database;
        const [user] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${email}, now())
            on conflict (email) do update set email = excluded.email returning id`;
        const id = user?.id ?? "";
        const suffix = createHash("sha256").update(id).digest("hex");
        await sql`insert into profiles (user_id, handle, display_name)
            values (${id}, ${`e2e_${suffix.slice(0, 12)}`}, 'E2E person') on conflict do nothing`;
        const [org] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('personal', ${`p-${suffix.slice(0, 10)}`}, 'Personal space')
            on conflict (slug) do update set name = orgs.name returning id`;
        await sql`insert into memberships (org_id, user_id, role)
            select ${org?.id ?? ""}, ${id}, 'owner'
            where not exists (select 1 from memberships where org_id = ${org?.id ?? ""})`;
        await sql`insert into sessions (user_id, token_hash, auth_method, privileged, created_at, last_seen_at,
                                        idle_expires_at, absolute_expires_at, step_up_at)
            values (${id}, ${createHash("sha256").update(token).digest()}, 'email_code', false, now(), now(),
                    now() + interval '7 days', now() + interval '30 days',
                    ${options.stepUp === true ? new Date() : null})`;
    } finally {
        await database.close(5);
    }
    await context.addCookies([
        {
            name: "aura_session",
            value: token,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
        },
    ]);
}

// A team organization with the given people in the given roles. Returns the organization's public id.
// Anyone who signs in with `loginAs` afterwards is the same person, so they keep these roles.
export async function seedTeam(
    name: string,
    seats: ReadonlyArray<{ email: string; role: string }>,
): Promise<string> {
    const url = process.env["AURA_E2E_DATABASE_URL"];
    if (url === undefined || url === "") throw new Error("AURA_E2E_DATABASE_URL must be set");
    const database = createDatabase(url, 1);
    try {
        const { sql } = database;
        const slug = `team-${randomBytes(4).toString("hex")}`;
        const [org] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('company', ${slug}, ${name}) returning id`;
        const orgId = org?.id ?? "";
        for (const seat of seats) {
            const [user] = await sql<{ id: string }[]>`
                insert into users (email, email_verified_at) values (${seat.email}, now())
                on conflict (email) do update set email = excluded.email returning id`;
            await sql`insert into memberships (org_id, user_id, role) values (${orgId}, ${user?.id ?? ""}, ${seat.role})`;
        }
        return `org_${orgId}`;
    } finally {
        await database.close(5);
    }
}

// Plays the judge for the newest submission of a person: marks it judged with the given verdict and
// one passing test. The end-to-end environment has no judge node, so this stands in for one; it
// exercises the verdict panel, not judging.
export async function settleLatestSubmission(email: string, verdict: string): Promise<void> {
    const url = process.env["AURA_E2E_DATABASE_URL"];
    if (url === undefined || url === "") throw new Error("AURA_E2E_DATABASE_URL must be set");
    const database = createDatabase(url, 1);
    try {
        const { sql } = database;
        const [row] = await sql<{ id: string; org_id: string }[]>`
            select s.id, s.org_id from submissions s join users u on u.id = s.user_id
            where u.email = ${email} order by s.id desc limit 1`;
        if (row === undefined) throw new Error("no submission to settle");
        await sql`update submissions set state = 'judging', updated_at = now() where id = ${row.id}`;
        await sql`update submissions set state = 'judged', verdict = ${verdict}, score = 100, judged_at = now(), updated_at = now() where id = ${row.id}`;
        await sql`insert into verdict_details (submission_id, org_id, test_id, verdict, cpu_ms, wall_ms, memory_kib)
                  values (${row.id}, ${row.org_id}, '001', 'AC', 12, 15, 2048)`;
    } finally {
        await database.close(5);
    }
}

// A delivery to the buyer's organization, built as the worker would build it. The end-to-end
// environment runs no worker, so this plants a released version, an order and a delivery with a
// small manifest through the same tables and functions; it exercises the customer screens, not the
// build. `built: false` leaves the delivery pending. Returns the delivery's public id.
export async function seedDelivery(buyerEmail: string, built = true): Promise<string> {
    const url = process.env["AURA_E2E_DATABASE_URL"];
    if (url === undefined || url === "") throw new Error("AURA_E2E_DATABASE_URL must be set");
    const database = createDatabase(url, 1);
    try {
        const { sql } = database;
        const slug = randomBytes(4).toString("hex");
        const [maker] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${`maker-${slug}@example.com`}, now()) returning id`;
        const [seller] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('company', ${`seller-${slug}`}, 'Seller') returning id`;
        const [customer] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('ai_lab', ${`lab-${slug}`}, 'Customer Lab') returning id`;
        const [buyer] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${buyerEmail}, now())
            on conflict (email) do update set email = excluded.email returning id`;
        await sql`insert into memberships (org_id, user_id, role) values (${customer?.id ?? ""}, ${buyer?.id ?? ""}, 'buyer')`;
        const [task] = await sql<{ id: string }[]>`
            insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${seller?.id ?? ""}, ${`sold-${slug}`}, 'algorithmic', 'private', 'Sum of two numbers', ${maker?.id ?? ""}) returning id`;
        const bundleHash = createHash("sha256").update(slug).digest();
        // A second person releases it (no self-release). The guard is switched off only for this one
        // insert, inside a transaction, so a failure cannot leave it off for the other tests.
        const [reviewer] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${`reviewer-${slug}@example.com`}, now()) returning id`;
        const version = await sql.begin(async (tx) => {
            await tx`alter table task_versions disable trigger task_versions_guard`;
            const [row] = await tx<{ id: string }[]>`
                insert into task_versions (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256,
                                           created_by, released_by, released_at, waived, submitted_at)
                values (${seller?.id ?? ""}, ${task?.id ?? ""}, 1, 'released', '{}'::jsonb, 'Add.', 12, ${bundleHash},
                        ${maker?.id ?? ""}, ${reviewer?.id ?? ""}, now(), true, now()) returning id`;
            await tx`alter table task_versions enable trigger task_versions_guard`;
            return row;
        });
        const [order] = await sql<{ id: string }[]>`
            insert into orders (customer_org_id, title, licence_terms, delivery_days, created_by, created_at, updated_at)
            values (${customer?.id ?? ""}, 'Evaluation pack', 'Internal use.', 30, ${maker?.id ?? ""}, now(), now()) returning id`;
        await sql`insert into order_items (order_id, task_version_id, task_org_id, added_at)
            values (${order?.id ?? ""}, ${version?.id ?? ""}, ${seller?.id ?? ""}, now())`;
        const [created] = await sql<{ id: string }[]>`
            with placed as (update orders set state = 'placed', placed_at = now() where id = ${order?.id ?? ""} returning id, customer_org_id)
            insert into deliveries (order_id, customer_org_id, watermark_id, expires_at, created_at)
            select id, customer_org_id, ${randomBytes(16).toString("hex")}, now() + interval '30 days', now() from placed
            returning id`;
        const deliveryId = created?.id ?? "";
        await plantDeliveredBundle(sql, deliveryId, bundleHash);
        if (built) {
            const manifest = JSON.stringify({
                items: [
                    {
                        task_version_id: `tsv_${version?.id ?? ""}`,
                        title: "Sum of two numbers",
                        bundle: { sha256: bundleHash.toString("hex"), bytes: 12 },
                        validation: "not performed",
                    },
                ],
            });
            await sql`select complete_delivery(${deliveryId}, ${manifest}, now())`;
        }
        return `dlv_${deliveryId}`;
    } finally {
        await database.close(5);
    }
}

// A version waiting in review, made by the setter and assigned to the reviewer, planted through the
// same tables a real flow would fill (uploads and statements are tested elsewhere). Returns the
// version's public id. Moves follow the legal order, so no guard has to be switched off.
export async function seedVersionInReview(
    setterEmail: string,
    reviewerEmail: string,
): Promise<string> {
    const url = process.env["AURA_E2E_DATABASE_URL"];
    if (url === undefined || url === "") throw new Error("AURA_E2E_DATABASE_URL must be set");
    const database = createDatabase(url, 1);
    try {
        const { sql } = database;
        const slug = randomBytes(4).toString("hex");
        const [org] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('company', ${`val-${slug}`}, 'Validation team') returning id`;
        const seats: Record<string, string> = {};
        for (const [email, role] of [
            [setterEmail, "setter"],
            [reviewerEmail, "reviewer"],
        ] as const) {
            const [user] = await sql<{ id: string }[]>`
                insert into users (email, email_verified_at) values (${email}, now())
                on conflict (email) do update set email = excluded.email returning id`;
            seats[role] = user?.id ?? "";
            await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${user?.id ?? ""}, ${role})`;
        }
        const [owner] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${`owner-${slug}@example.com`}, now()) returning id`;
        await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${owner?.id ?? ""}, 'owner')`;
        const [task] = await sql<{ id: string }[]>`
            insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${org?.id ?? ""}, ${`sum-${slug}`}, 'algorithmic', 'private', 'Sum of two numbers', ${seats["setter"] ?? ""}) returning id`;
        await sql`insert into task_assignments (task_id, org_id, user_id, assigned_by, created_at)
            values (${task?.id ?? ""}, ${org?.id ?? ""}, ${seats["reviewer"] ?? ""}, ${owner?.id ?? ""}, now())`;
        const spec = {
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
            license: { owner: "E2E team", terms: "internal use" },
            provenance: { author: "E2E setter", created: "2026-10-10", generated_with_ai: false },
        };
        const [version] = await sql<{ id: string }[]>`
            insert into task_versions (org_id, task_id, seq, created_by)
            values (${org?.id ?? ""}, ${task?.id ?? ""}, 1, ${seats["setter"] ?? ""}) returning id`;
        const id = version?.id ?? "";
        await sql`update task_versions set state = 'uploaded', bundle_bytes = 12,
            bundle_sha256 = ${createHash("sha256").update(slug).digest()} where id = ${id}`;
        await sql`update task_versions set spec = ${sql.json(spec)}, statement = 'Add the numbers.' where id = ${id}`;
        await sql`update task_versions set state = 'in_review' where id = ${id}`;
        return `tsv_${id}`;
    } finally {
        await database.close(5);
    }
}

// Plays a development judge node that finished validating a version: stores a passing report through
// the same function the control plane uses. The end-to-end environment has no node, so this stands in
// for one and exercises the report screens, not validation. Returns once the version is validated.
export async function settleValidationAsDevelopmentNode(versionId: string): Promise<void> {
    const url = process.env["AURA_E2E_DATABASE_URL"];
    if (url === undefined || url === "") throw new Error("AURA_E2E_DATABASE_URL must be set");
    const database = createDatabase(url, 1);
    try {
        const { sql } = database;
        const [node] = await sql<{ id: string }[]>`
            insert into judge_nodes (name, public_key, state, created_at)
            values (${`e2e-${randomBytes(4).toString("hex")}`}, ${randomBytes(32)}, 'active', now()) returning id`;
        const checks = sql.json([
            { name: "bundle_opens", ok: true, detail: "" },
            { name: "reference_passes", ok: true, detail: "" },
            { name: "score_at_least_70", ok: true, detail: "score 93.00" },
        ]);
        const rows = await sql<{ report: string | null }[]>`
            select settle_validation(${versionId.replace("tsv_", "")}, ${node?.id ?? ""}, ${checks}, '{}'::jsonb, 93, 1, now()) as report`;
        if (rows[0]?.report === null) throw new Error("the version was not being validated");
    } finally {
        await database.close(5);
    }
}

// The delivered bundle of the one version: the original, as a watermark job records it when there is
// nothing safe to mark (the end-to-end environment runs no judge node).
async function plantDeliveredBundle(
    sql: ReturnType<typeof createDatabase>["sql"],
    deliveryId: string,
    bundleHash: Buffer,
): Promise<void> {
    const [node] = await sql<{ id: string }[]>`
        insert into judge_nodes (name, public_key, state, created_at)
        values (${`seed-${deliveryId}`}, ${randomBytes(32)}, 'active', now()) returning id`;
    await sql`insert into delivery_bundles
        (delivery_id, customer_org_id, task_version_id, task_org_id, tag, source_sha256, sha256, bytes,
         answers_marked, solutions_marked, verdicts_checked, node_id, attestation, created_at)
        select d.id, d.customer_org_id, i.task_version_id, i.task_org_id,
               delivery_tag(d.watermark_id, i.task_version_id), ${bundleHash}, ${bundleHash}, 12, false,
               false, true, ${node?.id ?? ""}, 'development', now()
        from deliveries d join order_items i on i.order_id = d.order_id where d.id = ${deliveryId}`;
}

// A released version in an organization (a release needs a review stint this test is not about),
// planted the way the other end-to-end seeds plant theirs. Returns the version's public id.
export async function seedReleasedVersion(orgPublicId: string): Promise<string> {
    const url = process.env["AURA_E2E_DATABASE_URL"];
    if (url === undefined || url === "") throw new Error("AURA_E2E_DATABASE_URL must be set");
    const database = createDatabase(url, 1);
    try {
        const { sql } = database;
        const orgId = orgPublicId.replace("org_", "");
        const slug = randomBytes(4).toString("hex");
        const [maker] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${`maker-${slug}@example.com`}, now()) returning id`;
        const [releaser] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${`releaser-${slug}@example.com`}, now()) returning id`;
        const [task] = await sql<{ id: string }[]>`
            insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${orgId}, ${`contest-task-${slug}`}, 'algorithmic', 'private', 'Sum of two numbers', ${maker?.id ?? ""}) returning id`;
        const version = await sql.begin(async (tx) => {
            await tx`alter table task_versions disable trigger task_versions_guard`;
            const [row] = await tx<{ id: string }[]>`
                insert into task_versions (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256,
                                           created_by, released_by, released_at, waived, submitted_at)
                values (${orgId}, ${task?.id ?? ""}, 1, 'released', '{}'::jsonb, 'Add.', 12, ${randomBytes(32)},
                        ${maker?.id ?? ""}, ${releaser?.id ?? ""}, now(), true, now()) returning id`;
            await tx`alter table task_versions enable trigger task_versions_guard`;
            return row;
        });
        return `tsv_${version?.id ?? ""}`;
    } finally {
        await database.close(5);
    }
}

// A person with a public profile and two rated contests behind a rating, for the profile page. Returns the
// handle. The rating job itself is tested elsewhere; this plants its output.
export async function seedRatedProfile(): Promise<string> {
    const url = process.env["AURA_E2E_DATABASE_URL"];
    if (url === undefined || url === "") throw new Error("AURA_E2E_DATABASE_URL must be set");
    const database = createDatabase(url, 1);
    try {
        const { sql } = database;
        const handle = `rated_${randomBytes(4).toString("hex")}`;
        const [user] = await sql<{ id: string }[]>`
            insert into users (email, email_verified_at) values (${`${handle}@example.com`}, now()) returning id`;
        const userId = user?.id ?? "";
        await sql`insert into profiles (user_id, handle, display_name, visibility)
            values (${userId}, ${handle}, 'Rated Person', 'public')`;
        const [org] = await sql<{ id: string }[]>`
            insert into orgs (kind, slug, name) values ('university', ${`uni-${randomBytes(4).toString("hex")}`}, 'U') returning id`;
        const steps: [string, number, number][] = [
            ["Autumn Round", 1500, 1561.4],
            ["Winter Round", 1561.4, 1688],
        ];
        for (const [index, [title, before, after]] of steps.entries()) {
            const start = Date.UTC(2026, 0, 1 + index);
            const [contest] = await sql<{ id: string }[]>`insert into contests
                (org_id, slug, title, format, rules, starts_at, ends_at, created_by, rated)
                values (${org?.id ?? ""}, ${`c-${randomBytes(4).toString("hex")}-${index}`}, ${title}, 'icpc', ${sql.json({ format: "icpc" })},
                        ${new Date(start)}, ${new Date(start + 5 * 3_600_000)}, ${userId}, true) returning id`;
            for (const state of ["scheduled", "running", "ended"]) {
                await sql`update contests set state = ${state} where id = ${contest?.id ?? ""}`;
            }
            await sql`insert into rating_events (user_id, contest_id, dimension, rank, mu_before, mu_after, sigma_after, performance, created_at)
                values (${userId}, ${contest?.id ?? ""}, 'contest', ${index + 1}, ${before}, ${after}, 150, ${after + 30}, now())`;
        }
        await sql`insert into ratings (user_id, dimension, mu, sigma, contests, updated_at)
            values (${userId}, 'contest', 1688, 150, 2, now())`;
        return handle;
    } finally {
        await database.close(5);
    }
}
