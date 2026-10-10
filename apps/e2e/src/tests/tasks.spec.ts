import { randomBytes } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
    expectAccessible,
    freshEmail,
    loginAs,
    seedTeam,
    watchForCspProblems,
} from "../test-helpers.ts";

// Goal: the task screens work in a real browser against the real API, database and object storage:
// a setter writes a task and uploads a bundle straight to storage under the page's CSP, a reviewer
// approves and releases it with a passkey-confirmed waiver, a hostile statement runs no script, and
// the pages are accessible.

const HOSTILE_STATEMENT = [
    "# Sum of two numbers",
    "",
    "Read $a$ and $b$, print $a+b$.",
    "",
    "<script>window.__xss = 1</script>",
    '<img src=x onerror="window.__xss = 2">',
    "[click me](javascript:window.__xss=3)",
    "[safe link](https://example.com/docs)",
    "",
    "$$",
    "\\frac{a}{b}",
    "$$",
].join("\n");

const SPEC = {
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

async function pageFor(browser: Browser, email: string, stepUp = false): Promise<Page> {
    const context = await browser.newContext();
    await loginAs(context, email, { stepUp });
    return context.newPage();
}

async function buildVersion(page: Page, orgId: string): Promise<string> {
    await page.goto(`/orgs/${orgId}`);
    await page.getByLabel("Title", { exact: true }).fill("Sum of two numbers");
    await page.getByLabel("Address (letters, digits and dashes)").fill(`sum-${Date.now()}`);
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByText("Task created.")).toBeVisible();
    await page.getByRole("link", { name: "Sum of two numbers" }).first().click();
    await page.getByRole("button", { name: "Start a new version" }).click();
    await expect(page.getByRole("heading", { name: /version 1/ })).toBeVisible();
    return page.url();
}

test("a setter builds a version, a reviewer releases it, and a hostile statement runs nothing", async ({
    browser,
}) => {
    const setterEmail = freshEmail();
    const reviewerEmail = freshEmail();
    const orgId = await seedTeam("E2E team", [
        { email: setterEmail, role: "setter" },
        { email: reviewerEmail, role: "reviewer" },
    ]);

    const setter = await pageFor(browser, setterEmail);
    const problems = await watchForCspProblems(setter);
    const dialogs: string[] = [];
    setter.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
    });
    const versionUrl = await buildVersion(setter, orgId);

    await setter.getByLabel(/^Statement \(Markdown/).fill(HOSTILE_STATEMENT);
    await setter.getByRole("button", { name: "Save statement" }).click();
    await expect(setter.getByText("Statement saved.")).toBeVisible();
    await setter.getByLabel("Spec (JSON)").fill(JSON.stringify(SPEC));
    await setter.getByRole("button", { name: "Save spec" }).click();
    await expect(setter.getByText("Spec saved.")).toBeVisible();

    // The statement is rendered, and nothing in it ran.
    const statement = setter.getByRole("region", { name: "Rendered statement" });
    await expect(statement.getByRole("heading", { name: "Sum of two numbers" })).toBeVisible();
    await expect(statement.locator("math")).toHaveCount(4);
    await expect(statement.locator("script, img")).toHaveCount(0);
    await expect(statement.getByRole("link", { name: "click me" })).toHaveCount(0);
    await expect(statement.getByRole("link", { name: "safe link" })).toHaveAttribute(
        "href",
        "https://example.com/docs",
    );
    expect(await setter.evaluate(() => Reflect.get(window, "__xss"))).toBeUndefined();

    // The bundle goes straight to storage; the page's CSP allows exactly that origin.
    await setter.getByLabel(/^Bundle file/).setInputFiles({
        name: "bundle.tar.zst",
        mimeType: "application/octet-stream",
        buffer: randomBytes(3000),
    });
    await setter.getByRole("button", { name: "Upload bundle" }).click();
    // The upload section gives way to the verified bundle in the overview.
    await expect(setter.getByText(/3000 bytes, SHA-256 [0-9a-f]{64}/)).toBeVisible();
    await expectAccessible(setter);

    await setter.getByRole("button", { name: "Submit for review" }).click();
    await expect(setter.getByText("Submitted for review.")).toBeVisible();
    await expect(setter.getByText("someone else has to review")).toBeVisible();
    expect(dialogs).toEqual([]);
    expect(problems()).toEqual([]);

    const reviewer = await pageFor(browser, reviewerEmail, true);
    await reviewer.goto(versionUrl);
    await reviewer.getByRole("button", { name: "Approve" }).click();
    await expect(reviewer.getByText("Approved.")).toBeVisible();
    await reviewer
        .getByLabel(/^Why is it safe to release/)
        .fill("Checked by hand; no sandbox exists yet.");
    await reviewer.getByRole("button", { name: "Release this version" }).click();
    await expect(reviewer.getByText("Released.")).toBeVisible();
    await expect(reviewer.getByText(/released without sandbox validation/i)).toBeVisible();
    await expectAccessible(reviewer);
});

test("the task pages are accessible and a plain member sees no write controls", async ({
    browser,
}) => {
    const memberEmail = freshEmail();
    const ownerEmail = freshEmail();
    const orgId = await seedTeam("Read team", [
        { email: ownerEmail, role: "owner" },
        { email: memberEmail, role: "member" },
    ]);
    const owner = await pageFor(browser, ownerEmail);
    await buildVersion(owner, orgId);
    await expectAccessible(owner);

    const member = await pageFor(browser, memberEmail);
    await member.goto(`/orgs/${orgId}`);
    await expect(member.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await expect(member.getByRole("button", { name: "Create task" })).toHaveCount(0);
    await expectAccessible(member);
});
