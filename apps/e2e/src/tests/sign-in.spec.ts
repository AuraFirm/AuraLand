import { expect, test } from "@playwright/test";
import {
    codeIn,
    expectAccessible,
    freshEmail,
    linkIn,
    signInByEmail,
    signInWithEmailCode,
    waitForMail,
    watchForCspProblems,
} from "../test-helpers.ts";

test("signs in with the emailed code and shows the account", async ({ page }) => {
    const problems = await watchForCspProblems(page);
    const email = freshEmail();
    await signInByEmail(page, email);
    await expect(page.getByText(email)).toBeVisible();
    await expectAccessible(page);
    expect(problems()).toEqual([]);
});

test("signs in by opening the emailed link in the same browser", async ({ page }) => {
    const email = freshEmail();
    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Email me a link and code" }).click();
    await expect(page.getByLabel("Code")).toBeVisible();
    const link = linkIn(await waitForMail(email));
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    // The secret does not stay in the address bar.
    expect(page.url()).not.toContain("#t=");
});

test("a wrong code is refused with a message, and the page stays usable", async ({ page }) => {
    const email = freshEmail();
    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Email me a link and code" }).click();
    const real = codeIn(await waitForMail(email));
    const wrong = real === "00000000" ? "11111111" : "00000000";
    await page.getByLabel("Code").fill(wrong);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /did not work/i })).toBeVisible();
    await page.getByLabel("Code").fill(real);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
});

test("the sign-in page is accessible", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expectAccessible(page);
});

test("people who are not signed in are sent to the sign-in page", async ({ page }) => {
    await page.goto("/account");
    await expect(page).toHaveURL(/\/sign-in$/);
});

test("an incomplete link says so", async ({ page }) => {
    await page.goto("/auth/verify");
    await expect(page.getByRole("alert").filter({ hasText: /incomplete/i })).toBeVisible();
});

test("after signing in, a safe next address is followed and an unsafe one is ignored", async ({
    page,
}) => {
    await page.goto("/sign-in?next=/orgs");
    await signInWithEmailCode(page, freshEmail());
    await expect(page).toHaveURL(/\/orgs$/);

    const other = await page.context().browser()?.newContext();
    const stranger = await other?.newPage();
    if (stranger === undefined) throw new Error("no second browser context");
    await stranger.goto("/sign-in?next=//evil.example/steal");
    await signInWithEmailCode(stranger, freshEmail());
    await expect(stranger).toHaveURL(/localhost:3000\/account$/);
    await other?.close();
});
