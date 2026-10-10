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
