import { expect, test } from "@playwright/test";
import { expectAccessible, seedRatedProfile } from "../test-helpers.ts";

// Goal: a public profile is readable by anyone in a real browser: the name, the rating with its tier written
// out, the history newest first, and a person who is not public is "No such profile". The page is accessible.

test("anyone reads a public profile with its rating and history", async ({ page }) => {
    const handle = await seedRatedProfile();
    await page.goto(`/users/${handle}`);
    await expect(page.getByRole("heading", { name: "Rated Person" })).toBeVisible();
    await expect(page.locator("strong", { hasText: "1688" })).toBeVisible();
    await expect(page.getByText("Expert", { exact: false })).toBeVisible(); // the tier is a word
    await expect(page.getByText("still settling", { exact: false })).toBeVisible();
    const rounds = page.getByRole("listitem").filter({ hasText: "Round" });
    await expect(rounds.first()).toContainText("Winter Round"); // newest first
    await expect(rounds.nth(1)).toContainText("Autumn Round");
    await expect(rounds.first()).toContainText("1561 → 1688 (+127)");
    await expectAccessible(page);
});

test("a missing or non-public person is the same page", async ({ page }) => {
    await page.goto("/users/nobody_here_at_all");
    await expect(page.getByText("No such profile.")).toBeVisible();
});
