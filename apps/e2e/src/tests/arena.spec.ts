import { expect, test } from "@playwright/test";
import { answerLatestClarification, seedRunningContest } from "../arena-seeds.ts";
import { expectAccessible, freshEmail, loginAs, settleLatestSubmission } from "../test-helpers.ts";

// Goal: a contestant's whole path in a real browser: the contest page counts down by the server's clock and
// links the problem; the problem page shows the statement and takes a submission; the verdict appears but
// per-test results do not; a question gets its answer; the scoreboard lists the standings and, with hundreds
// of rows, renders only a window of them. The pages are accessible.

test("a contestant reads the statement, submits, asks a question and watches the scoreboard", async ({
    browser,
}) => {
    const email = freshEmail();
    const contest = await seedRunningContest(email, 3);
    const context = await browser.newContext();
    await loginAs(context, email);
    const page = await context.newPage();

    await page.goto(`/arena/contests/${contest}`);
    await expect(page.getByText(/^Ends in \d{2}:\d{2}:\d{2}$/)).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("link", { name: /Problem A/ }).click();

    await expect(page.getByRole("heading", { name: "A. Sum of two numbers" })).toBeVisible();
    await expect(page.getByLabel("Problem statement").locator("strong")).toHaveText("two");
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText("Submitted.")).toBeVisible();
    await settleLatestSubmission(email, "AC");
    await expect(page.getByText("Accepted")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("table", { name: "Results by test" })).toHaveCount(0); // hidden while it runs

    await page.getByLabel("Ask the organizers").fill("Can the numbers be negative?");
    await page.getByRole("button", { name: "Send question" }).click();
    await expect(page.getByText("Question sent to the organizers.")).toBeVisible();
    await expect(page.getByText("Not answered yet.")).toBeVisible();
    await answerLatestClarification(contest, "Yes, they can.");
    await page.reload();
    await expect(page.getByText("Answer: Yes, they can.")).toBeVisible();
    await expectAccessible(page);

    await page.goto(`/arena/contests/${contest}/scoreboard`);
    await expect(page.getByRole("heading", { name: "Scoreboard" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Participant 1/ })).toContainText("✓");
    await expectAccessible(page);
});

test("a long scoreboard renders a window of rows and scrolls to the rest", async ({ page }) => {
    const contest = await seedRunningContest(freshEmail(), 600);
    await page.goto(`/arena/contests/${contest}/scoreboard`);
    await expect(page.getByRole("heading", { name: "Scoreboard" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Participant 1\b/ })).toBeVisible();
    expect(await page.locator("tbody tr").count()).toBeLessThan(60); // 600 rows, a window drawn
    expect(await page.getByRole("row", { name: /Participant 600\b/ }).count()).toBe(0);
    await page.getByRole("region", { name: "Scoreboard rows" }).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByRole("row", { name: /Participant 600\b/ })).toBeVisible();
    await expectAccessible(page);
});

test("a stranger is told the problem is not theirs to read", async ({ page }) => {
    const contest = await seedRunningContest(freshEmail(), 1);
    await page.goto(`/arena/contests/${contest}/problems/A`);
    await expect(
        page.getByText("This problem is not available to you.", { exact: false }),
    ).toBeVisible();
});
