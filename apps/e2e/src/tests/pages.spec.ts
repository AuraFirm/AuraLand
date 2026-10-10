import { expect, test } from "@playwright/test";
import { expectAccessible, watchForCspProblems } from "../test-helpers.ts";

test("the home page and the sign-in result pages are accessible and violate no policy", async ({
    page,
}) => {
    const problems = await watchForCspProblems(page);
    for (const path of [
        "/",
        "/auth/done?status=failed&reason=account_exists",
        "/auth/done?status=signed_in",
    ]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expectAccessible(page);
    }
    expect(problems()).toEqual([]);
});

test("pages carry a per-request nonce policy and the browser enforces it", async ({ page }) => {
    const first = await page.goto("/sign-in");
    const second = await page.goto("/sign-in");
    const policies = [first, second].map(
        (response) => response?.headers()["content-security-policy"] ?? "",
    );
    const nonces = policies.map((policy) => /'nonce-([^']+)'/.exec(policy)?.[1]);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(policies[0]).toContain("default-src 'none'");
    expect(policies[0]).not.toContain("unsafe-eval");
    expect(first?.headers()["cache-control"]).toContain("no-store");

    // Markup that smuggles in an inline handler must not run it: the browser reports a violation.
    const violation = page.evaluate(
        () =>
            new Promise<string>((resolve) => {
                document.addEventListener(
                    "securitypolicyviolation",
                    (event) => resolve(event.violatedDirective),
                    { once: true },
                );
                document.body.insertAdjacentHTML(
                    "beforeend",
                    '<img src="data:," onerror="window.injected = true">',
                );
            }),
    );
    expect(await violation).toContain("script-src");
    expect(await page.evaluate(() => "injected" in window)).toBe(false);
});

test("API answers keep their own strict headers", async ({ request }) => {
    const response = await request.get("/api/v1/auth/methods");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers()["cache-control"]).toBe("no-store");
});
