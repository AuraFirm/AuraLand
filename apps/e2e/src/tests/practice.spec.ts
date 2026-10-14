import { expect, test } from "@playwright/test";
import { seedPracticeProblem, setPlatformStatus } from "../arena-seeds.ts";
import { expectAccessible, freshEmail, loginAs, settleLatestSubmission } from "../test-helpers.ts";

// Goal: the practice bank in a real browser. A stranger finds a problem in the list, reads its statement
// without signing in, signs in and submits, and sees the verdict; today's pick is shown. The platform notice
// appears on every page while one is set and disappears when cleared. The pages are accessible.

test("a stranger reads a practice problem and a signed-in person submits to it", async ({
    browser,
}) => {
    const problem = await seedPracticeProblem();
    const anonymous = await (await browser.newContext()).newPage();
    await anonymous.goto("/practice");
    const bank = anonymous.getByRole("region", { name: "Problems" });
    await expect(bank.getByRole("link", { name: problem.title })).toBeVisible();
    await expect(anonymous.getByRole("region", { name: /^Today's problem/ })).toBeVisible();
    await expectAccessible(anonymous);
    await bank.getByRole("link", { name: problem.title }).click();
    await expect(anonymous.getByRole("heading", { name: problem.title })).toBeVisible();
    await expect(anonymous.getByLabel("Problem statement").locator("strong")).toHaveText("two");

    const email = freshEmail();
    const context = await browser.newContext();
    await loginAs(context, email);
    const page = await context.newPage();
    await page.goto(`/practice/${problem.id}`);
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText("Submitted.")).toBeVisible();
    await settleLatestSubmission(email, "AC");
    await expect(page.getByText("Accepted")).toBeVisible({ timeout: 10_000 });
    await expectAccessible(page);
});

test("the platform notice shows on every page while it is set", async ({ page }) => {
    try {
        await setPlatformStatus("degraded", "Judging is slow; contests are unaffected.");
        await page.goto("/practice");
        await expect(page.getByRole("status").filter({ hasText: "Service notice:" })).toContainText(
            "Judging is slow; contests are unaffected.",
        );
        await expectAccessible(page);
        await setPlatformStatus("ok", "");
        await page.reload();
        await expect(page.getByText("Service notice:")).toHaveCount(0);
    } finally {
        await setPlatformStatus("ok", "");
    }
});
