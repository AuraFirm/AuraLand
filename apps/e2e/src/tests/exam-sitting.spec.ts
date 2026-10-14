import { expect, test } from "@playwright/test";
import { seedOpenExam } from "../arena-seeds.ts";
import { expectAccessible, freshEmail, loginAs } from "../test-helpers.ts";

// Goal: a candidate sits down in a real browser: gets ready, sees the computer check and the wording of what is
// recorded, cannot continue without agreeing, starts, and then has a timer and the statement. A person who is not
// on the roster finds nothing. The pages are accessible.

test("a rostered candidate checks, agrees, starts and sees the timer and the statement", async ({
    browser,
}) => {
    const email = freshEmail();
    const exam = await seedOpenExam(email, 30);
    const context = await browser.newContext();
    await loginAs(context, email);
    const page = await context.newPage();

    await page.goto(`/exams/${exam}`);
    await page.getByRole("button", { name: "Get ready" }).click();
    await expect(page.getByRole("heading", { name: "Check this computer" })).toBeVisible();
    await expect(
        page.getByText("This browser can keep your work safe", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("It records nothing else", { exact: false })).toBeVisible();
    const proceed = page.getByRole("button", { name: "Continue" });
    await expect(proceed).toBeDisabled();
    await expectAccessible(page);
    await page.getByLabel("I have read this and I agree").check();
    await proceed.click();

    await expect(page.getByRole("heading", { name: "Ready to start" })).toBeVisible();
    await page.getByRole("button", { name: "Start the exam" }).click();
    await expect(page.getByRole("heading", { name: "Time left" })).toBeVisible();
    await expect(page.getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeVisible();
    await expect(page.getByLabel("Problem A").locator("strong")).toHaveText("two");
    await expectAccessible(page);

    await page.reload(); // a reconnect: the same sitting, the same clock
    await expect(page.getByRole("heading", { name: "Time left" })).toBeVisible();
});

test("a person who is not on the roster finds no exam", async ({ browser }) => {
    const exam = await seedOpenExam(freshEmail());
    const context = await browser.newContext();
    await loginAs(context, freshEmail());
    const page = await context.newPage();
    await page.goto(`/exams/${exam}`);
    await expect(page.getByRole("button", { name: "Get ready" })).toHaveCount(0);
});
