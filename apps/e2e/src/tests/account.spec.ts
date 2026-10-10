import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
    addVirtualAuthenticator,
    expectAccessible,
    freshEmail,
    loginAs,
    signInByEmail,
    watchForCspProblems,
} from "../test-helpers.ts";

test("adds, uses, renames and removes a passkey", async ({ page }) => {
    await addVirtualAuthenticator(page);
    const problems = await watchForCspProblems(page);
    await loginAs(page.context(), freshEmail());
    await page.goto("/account");
    await page.getByLabel("Name for the new passkey (optional)").fill("Work laptop");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByText("Passkey added.")).toBeVisible();
    await expect(page.getByText("Work laptop")).toBeVisible();

    await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
    await expect(page).toHaveURL("/");
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await expect(page.getByText("Work laptop")).toBeVisible();

    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("New name").fill("Home desktop");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Home desktop")).toBeVisible();
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Passkey removed.")).toBeVisible();
    await expect(page.getByText("Home desktop")).toHaveCount(0);
    await expectAccessible(page);
    expect(problems()).toEqual([]);
});

test("shows signed-in devices and signs another one out", async ({ browser, page }) => {
    const email = freshEmail();
    await loginAs(page.context(), email);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await loginAs(other, email);
    await otherPage.goto("/account");
    await page.goto("/account");

    await page.reload();
    await expect(
        page.getByRole("region", { name: "Devices signed in" }).getByText("(this device)"),
    ).toBeVisible();
    const devices = page.getByRole("region", { name: "Devices signed in" });
    await expect(devices.getByText("(this device)")).toBeVisible();
    await devices.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(devices.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);

    await otherPage.reload();
    await expect(otherPage).toHaveURL(/\/sign-in$/);
    await other.close();
});

test("downloads the personal data export", async ({ page }) => {
    const email = freshEmail();
    await loginAs(page.context(), email);
    await page.goto("/account");
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download my data" }).click();
    const file = await (await download).path();
    const body: unknown = JSON.parse(readFileSync(file, "utf8"));
    expect(JSON.stringify(body)).toContain(email);
    expect(JSON.stringify(body)).not.toMatch(/token_hash|public_key/);
});

test("requesting deletion signs out everywhere, and signing in again can cancel it", async ({
    page,
}) => {
    const email = freshEmail();
    await loginAs(page.context(), email);
    await page.goto("/account");
    await page.getByRole("button", { name: "Delete my account…" }).click();
    await page.getByRole("button", { name: "Yes, request deletion" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/sign-in$/);

    await signInByEmail(page, email);
    await expect(page.getByText(/Deletion requested on/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel deletion" }).click();
    await expect(page.getByText(/Deletion requested on/)).toHaveCount(0);
});

test("the account page is accessible", async ({ page }) => {
    await loginAs(page.context(), freshEmail());
    await page.goto("/account");
    await expectAccessible(page);
});
