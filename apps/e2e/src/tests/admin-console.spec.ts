import { expect, test } from "@playwright/test";
import { expectAccessible, freshEmail, loginAs, watchForCspProblems } from "../test-helpers.ts";

let counter = 0;
const uniqueSlug = () => `e2e-admin-${Date.now().toString(36)}-${++counter}`;

// A new company organization is on the free plan: the console shows that, lets the owner claim a domain, and answers plainly when a
// feature belongs to a bigger plan, instead of failing silently.
test("the admin console shows the plan, takes a domain claim and explains plan limits", async ({
    page,
}) => {
    const problems = await watchForCspProblems(page);
    // A fresh passkey check is on record, so the privileged actions below reach the plan check instead of asking for a passkey.
    await loginAs(page.context(), freshEmail(), { stepUp: true });
    await page.goto("/orgs");
    await page.getByLabel("Name", { exact: true }).fill("Console Team");
    await page.getByLabel(/Address/).fill(uniqueSlug());
    await page.getByLabel("Kind").selectOption("company");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("link", { name: "Console Team" }).click();
    await page.getByRole("link", { name: /Admin console/ }).click();

    await expect(
        page.getByRole("heading", { name: "Admin console: Console Team", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("plan-name")).toHaveText("Free");
    await expectAccessible(page);

    await page.getByLabel("Domain to claim").fill("console-team.example");
    await page.getByRole("button", { name: "Add domain" }).click();
    await expect(
        page.getByText("Domain added. Publish the record shown, then verify."),
    ).toBeVisible();
    await expect(
        page.getByText(/_aura-challenge\.console-team\.example = aura-verify=[0-9a-f]{32}/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Create provisioning token" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /plan limit/i })).toBeVisible();

    await page
        .getByLabel("Address to send environment run results to (https)")
        .fill("https://hooks.example.com/aura");
    await page.getByRole("button", { name: "Add endpoint" }).click();
    await expect(
        page
            .getByRole("alert")
            .filter({ hasText: /plan limit/i })
            .first(),
    ).toBeVisible();
    await expectAccessible(page);
    expect(problems()).toEqual([]);
});

test("an ordinary member is told the console is not theirs", async ({ page }) => {
    await loginAs(page.context(), freshEmail());
    await page.goto("/orgs/org_018f0000-0000-7000-8000-0000000000aa/admin");
    await expect(page.getByRole("alert").filter({ hasText: /not found/i })).toBeVisible();
});
