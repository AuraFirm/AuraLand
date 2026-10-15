import { expect, test } from "@playwright/test";
import { expectAccessible } from "../test-helpers.ts";

// Goal: the public verification page tells each outcome in plain words and is accessible. The page is a thin renderer
// of the API's answer, so the browser tests answer the request with each outcome (the API's own behaviour is tested
// against the real code and database in the API suite).

const ID = "crd_018f0000-0000-7000-8000-00000000abcd";
const base = {
    id: ID,
    status_known: true,
    name: "Rank 1 of 5 in Open",
    issuer: "AuraLand (development)",
    description: "Solved 3 problems in a contest hosted by Uni. Assurance level 0.",
    assurance_level: 0,
    environment: "production",
    issued_at: "2026-10-01T12:00:00.000Z",
    jwt: "aaa.bbb.ccc",
};
const answer = (page: import("@playwright/test").Page, body: object) =>
    page.route("**/api/public/credentials/*", (route) => route.fulfill({ json: body }));

for (const [outcome, headline] of [
    ["valid", "This credential is valid"],
    ["expired", "This credential has expired"],
    ["revoked", "This credential was revoked"],
] as const) {
    test(`says ${outcome} in plain words`, async ({ page }) => {
        await answer(page, { ...base, outcome });
        await page.goto(`/verify/${ID}`);
        await expect(page.getByRole("heading", { name: headline })).toBeVisible();
        await expect(page.getByText("Rank 1 of 5 in Open")).toBeVisible();
        await expectAccessible(page);
    });
}

test("warns when the revocation status could not be checked, and about a development credential", async ({
    page,
}) => {
    await answer(page, {
        ...base,
        outcome: "valid",
        status_known: false,
        reason: "whether it was revoked could not be checked",
        environment: "development",
    });
    await page.goto(`/verify/${ID}`);
    await expect(page.getByText("whether it was revoked could not be checked")).toBeVisible();
    await expect(page.getByText("proves nothing", { exact: false })).toBeVisible();
    await expectAccessible(page);
});

test("says unknown without revealing why, and invalid with the reason", async ({ page }) => {
    await answer(page, { id: ID, outcome: "unknown", status_known: false });
    await page.goto(`/verify/${ID}`);
    await expect(
        page.getByRole("heading", { name: "We have no public credential with this address" }),
    ).toBeVisible();
    await expectAccessible(page);
    await page.unroute("**/api/public/credentials/*");
    await answer(page, {
        id: ID,
        outcome: "invalid",
        status_known: false,
        reason: "signature does not match",
    });
    await page.goto(`/verify/${ID}`);
    await expect(page.getByRole("heading", { name: "This credential is not valid" })).toBeVisible();
    await expect(page.getByText("signature does not match")).toBeVisible();
});

test("an address that is not a credential is refused politely", async ({ page }) => {
    await page.route("**/api/public/credentials/*", (route) =>
        route.fulfill({ status: 404, json: { code: "not_found", title: "Not found" } }),
    );
    await page.goto("/verify/nonsense");
    await expect(page.getByText("This address is not a credential.")).toBeVisible();
});
