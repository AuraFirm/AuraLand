import { expect, test } from "@playwright/test";
import { seedCredential } from "../arena-seeds.ts";
import { expectAccessible, freshEmail, loginAs } from "../test-helpers.ts";

// Goal: a person manages who sees a credential in a real browser. It starts private; they widen it, make a link
// (shown once, with its secret in the address), see the link listed and revoke it. The page is accessible.

test("a person sees their credential private, makes a link, and revokes it", async ({
    browser,
}) => {
    const email = freshEmail();
    const title = `Weekly contest ${Date.now()}`;
    const id = await seedCredential(email, title);
    const context = await browser.newContext();
    await loginAs(context, email);
    const page = await context.newPage();

    await page.goto("/passport");
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByLabel("Who can see this")).toHaveValue("private");
    await expect(page.getByRole("button", { name: /Make a link/ })).toHaveCount(0); // private means nobody
    await expectAccessible(page);

    await page.getByLabel("Who can see this").selectOption("link");
    await expect(page.getByRole("button", { name: /Make a link/ })).toBeVisible();
    await page.getByRole("button", { name: /Make a link/ }).click();
    await expect(page.getByText(`/verify/${id}?s=`, { exact: false })).toBeVisible();
    await expect(page.getByText("Link until", { exact: false })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole("button", { name: "Revoke this link" }).click();
    await expect(page.getByText("(revoked)")).toBeVisible();
});

test("a person with no credentials is told when they appear", async ({ browser }) => {
    const context = await browser.newContext();
    await loginAs(context, freshEmail());
    const page = await context.newPage();
    await page.goto("/passport");
    await expect(page.getByText("You have no credentials yet", { exact: false })).toBeVisible();
});

test("the employer page says plainly that access is by invitation", async ({ browser }) => {
    const context = await browser.newContext();
    await loginAs(context, freshEmail());
    const page = await context.newPage();
    await page.goto("/employer");
    await expect(page.getByRole("heading", { name: "Employer" })).toBeVisible();
    await expect(page.getByText("by invitation of the platform", { exact: false })).toBeVisible();
    await expectAccessible(page);
});
