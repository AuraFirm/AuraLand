import { expect, test } from "@playwright/test";
import {
    expectAccessible,
    freshEmail,
    loginAs,
    seedDelivery,
    watchForCspProblems,
} from "../test-helpers.ts";

// Goal: a customer's buyer sees their delivery in a real browser, can request a download link (the
// API answers 200 with a short-lived link), sees how to verify the manifest, and a pending delivery or
// someone else's delivery shows no files. The pages are accessible and trigger no CSP violation.

test("a buyer lists a delivery, reads its manifest hash and requests a download link", async ({
    page,
}) => {
    const problems = await watchForCspProblems(page);
    const buyer = freshEmail();
    const deliveryId = await seedDelivery(buyer);
    await loginAs(page.context(), buyer);
    await page.goto("/deliveries");
    await expect(page.getByRole("heading", { name: "Deliveries", exact: true })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("link", { name: "Evaluation pack" }).click();
    await expect(page.getByRole("heading", { name: "Evaluation pack", level: 1 })).toBeVisible();
    await expect(page.getByText(/validation: not performed/)).toBeVisible();
    await expect(page.getByText("Check what you received")).toBeVisible();
    await expectAccessible(page);
    const issued = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/deliveries/${deliveryId}/downloads`) &&
            response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Download Sum of two numbers" }).click();
    expect((await issued).status()).toBe(200);
    expect(problems().filter((text) => text.startsWith("CSP"))).toEqual([]);
});

test("a pending delivery offers no files, and another person's delivery is not found", async ({
    browser,
    page,
}) => {
    const buyer = freshEmail();
    const pending = await seedDelivery(buyer, false);
    await loginAs(page.context(), buyer);
    await page.goto(`/deliveries/${pending}`);
    await expect(page.getByText(/Being prepared/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Download/ })).toHaveCount(0);

    const stranger = await browser.newContext();
    await loginAs(stranger, freshEmail());
    const strangerPage = await stranger.newPage();
    await strangerPage.goto(`/deliveries/${pending}`);
    await expect(strangerPage.getByRole("alert").filter({ hasText: /not found/i })).toBeVisible();
});
