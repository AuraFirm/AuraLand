import { expect, test } from "@playwright/test";
import {
    addVirtualAuthenticator,
    expectAccessible,
    freshEmail,
    invitationLinkIn,
    loginAs,
    waitForMail,
    watchForCspProblems,
} from "../test-helpers.ts";

let counter = 0;
const uniqueSlug = () => `e2e-org-${Date.now().toString(36)}-${++counter}`;

test("creates an organization, finds it in the list and renames it", async ({ page }) => {
    const problems = await watchForCspProblems(page);
    await loginAs(page.context(), freshEmail());
    await page.goto("/orgs");
    await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();
    await expect(page.getByText("Personal space · owner")).toBeVisible();
    await expectAccessible(page);

    await page.getByLabel("Name", { exact: true }).fill("Acme Lab");
    await page.getByLabel(/Address/).fill(uniqueSlug());
    await page.getByLabel("Kind").selectOption("company");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("Organization created.")).toBeVisible();
    await page.getByRole("link", { name: "Acme Lab" }).click();
    await expect(page.getByRole("heading", { name: "Acme Lab", level: 1 })).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("Acme Research");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByRole("heading", { name: "Acme Research", level: 1 })).toBeVisible();
    await expectAccessible(page);
    expect(problems()).toEqual([]);
});

test("an organization the person does not belong to looks like a missing page", async ({
    page,
}) => {
    await loginAs(page.context(), freshEmail());
    await page.goto("/orgs/org_018f0000-0000-7000-8000-0000000000aa");
    await expect(page.getByRole("alert").filter({ hasText: /not found/i })).toBeVisible();
});

test("invites a person by email, who joins through the link", async ({ browser, page }) => {
    const owner = freshEmail();
    const invitee = freshEmail();
    await loginAs(page.context(), owner);
    await page.goto("/orgs");
    await page.getByLabel("Name", { exact: true }).fill("Invite Team");
    await page.getByLabel(/Address/).fill(uniqueSlug());
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("link", { name: "Invite Team" }).click();

    await page.getByLabel("Email address to invite").fill(invitee);
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByText("Invitation sent.")).toBeVisible();
    const invitations = page.getByRole("region", { name: "Invitations" });
    await expect(invitations.getByRole("listitem").filter({ hasText: invitee })).toBeVisible();

    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await loginAs(guest, invitee);
    await guestPage.goto(invitationLinkIn(await waitForMail(invitee)));
    await expect(guestPage).toHaveURL(/\/orgs$/);
    await expect(guestPage.getByRole("link", { name: "Invite Team" })).toBeVisible();
    expect(guestPage.url()).not.toContain("#t=");

    await page.reload();
    await expect(page.getByRole("region", { name: "Members" }).getByRole("listitem")).toHaveCount(
        2,
    );
    await guest.close();
});

test("an invitation link says to sign in first when nobody is signed in", async ({ page }) => {
    await page.goto(`/invitations/accept#t=${"A".repeat(43)}`);
    await expect(
        page.getByRole("alert").filter({ hasText: /Sign in with the email address/ }),
    ).toBeVisible();
});

test("API keys: shown once, work for the machine, and stop when revoked", async ({
    page,
    request,
}) => {
    await addVirtualAuthenticator(page);
    await loginAs(page.context(), freshEmail());
    await page.goto("/orgs");
    await page.getByLabel("Name", { exact: true }).fill("Key Team");
    await page.getByLabel(/Address/).fill(uniqueSlug());
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("link", { name: "Key Team" }).click();

    // No passkey yet: the privileged action asks for one, and says so.
    await page.getByLabel("Name for the new key").fill("deploy");
    await page.getByRole("button", { name: "Create key" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Add a passkey first/ })).toBeVisible();

    // Adding a passkey counts as a fresh check, so the same action now goes through.
    await page.goto("/account");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByText("Passkey added.")).toBeVisible();
    await page.goBack();
    await page.getByLabel("Name for the new key").fill("deploy");
    await page.getByRole("button", { name: "Create key" }).click();
    const shown = page.locator("code");
    await expect(shown).toBeVisible();
    const key = (await shown.textContent()) ?? "";
    await expectAccessible(page);

    const headers = { authorization: `Bearer ${key}` };
    expect((await request.get("/api/v1/key", { headers })).status()).toBe(200);
    await page.getByRole("button", { name: "Revoke key deploy" }).click();
    await expect(page.getByText("Key revoked.")).toBeVisible();
    expect((await request.get("/api/v1/key", { headers })).status()).toBe(401);
});
