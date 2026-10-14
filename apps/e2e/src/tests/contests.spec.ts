import { type Browser, expect, type Page, test } from "@playwright/test";
import {
    expectAccessible,
    freshEmail,
    loginAs,
    seedReleasedVersion,
    seedTeam,
} from "../test-helpers.ts";

// Goal: the contest screens work in a real browser against the real API and database. An organizer makes
// a contest, adds a problem and publishes it; a stranger finds it in the Arena without signing in,
// registers and is told so; the organizer is told they cannot compete. The pages are accessible.

// What a datetime-local input wants: a wall-clock time in the browser's own zone.
const localInput = (offsetHours: number): string => {
    const date = new Date(Date.now() + offsetHours * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

async function pageFor(browser: Browser, email: string): Promise<Page> {
    const context = await browser.newContext();
    await loginAs(context, email);
    return context.newPage();
}

test("an organizer publishes a contest and a stranger registers for it", async ({ browser }) => {
    const ownerEmail = freshEmail();
    const orgId = await seedTeam("E2E university", [{ email: ownerEmail, role: "owner" }]);
    const versionId = await seedReleasedVersion(orgId);
    const title = `Spring Open ${Date.now()}`;

    const owner = await pageFor(browser, ownerEmail);
    await owner.goto(`/orgs/${orgId}`);
    await owner.getByLabel("Contest title").fill(title);
    await owner.getByLabel(/^Address \(lowercase/).fill(`spring-${Date.now()}`);
    await owner.getByLabel(/^Starts/).fill(localInput(2));
    await owner.getByLabel(/^Ends/).fill(localInput(7));
    await owner.getByRole("button", { name: "Create contest" }).click();
    await expect(owner.getByRole("heading", { name: title })).toBeVisible();
    await expect(owner.getByText("Draft")).toBeVisible();
    await owner.getByLabel(/^Label/).fill("A");
    await owner.getByLabel(/^Released task version/).fill(versionId);
    await owner.getByRole("button", { name: "Add problem" }).click();
    await expect(owner.getByText("Problem A added.")).toBeVisible();
    await owner.getByRole("button", { name: "Publish" }).click();
    await expect(owner.getByText("Starts soon")).toBeVisible();
    await expect(owner.getByText("you organize this contest", { exact: false })).toBeVisible();
    await expectAccessible(owner);

    // Anyone can find it in the Arena without signing in.
    const anonymous = await (await browser.newContext()).newPage();
    await anonymous.goto("/arena");
    await anonymous.getByRole("link", { name: title }).click();
    await expect(anonymous.getByRole("heading", { name: title })).toBeVisible();
    await expect(anonymous.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
    await expectAccessible(anonymous);

    // A stranger registers.
    const stranger = await pageFor(browser, freshEmail());
    await stranger.goto("/arena");
    await stranger.getByRole("link", { name: title }).click();
    await stranger.getByRole("button", { name: "Register" }).click();
    await expect(stranger.getByText("You are registered.").first()).toBeVisible();
    await expectAccessible(stranger);
});
