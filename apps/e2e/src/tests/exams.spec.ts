import { type Browser, expect, type Page, test } from "@playwright/test";
import { seedClosedExam } from "../arena-seeds.ts";
import {
    expectAccessible,
    freshEmail,
    loginAs,
    seedReleasedVersion,
    seedTeam,
} from "../test-helpers.ts";

// Goal: an instructor sets an exam up in a real browser: creates it with its first problem, uploads a roster (a
// bad line is named and nothing is saved, a good file is saved) and publishes it. The pages are accessible.

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

test("an instructor creates an exam, uploads a roster and publishes it", async ({ browser }) => {
    const ownerEmail = freshEmail();
    const orgId = await seedTeam("E2E exam university", [{ email: ownerEmail, role: "owner" }]);
    const versionId = await seedReleasedVersion(orgId);
    const title = `Lab exam ${Date.now()}`;

    const owner = await pageFor(browser, ownerEmail);
    await owner.goto(`/orgs/${orgId}`);
    await owner.getByLabel("Exam title").fill(title);
    await owner.getByLabel("Minutes each person has").fill("90");
    await owner.getByLabel(/^People may start from/).fill(localInput(3));
    await owner.getByLabel(/^and until/).fill(localInput(8));
    await owner.getByLabel("First problem label").fill("A");
    await owner.getByLabel(/^Released task version for it/).fill(versionId);
    await owner.getByRole("button", { name: "Create exam" }).click();

    await expect(owner.getByRole("heading", { name: title })).toBeVisible();
    await expect(owner.getByText("draft", { exact: true })).toBeVisible();
    await expect(owner.getByText("Problem A · 100 points")).toBeVisible();
    await expectAccessible(owner);

    await owner.getByLabel(/^or paste it/).fill("email,name\nnot-an-email,Nobody\n");
    await owner.getByRole("button", { name: "Save roster" }).click();
    await expect(owner.getByText("line 2", { exact: false })).toBeVisible();
    await expect(owner.getByText("0 people on the roster.")).toBeVisible();

    await owner
        .getByLabel(/^or paste it/)
        .fill("email,name,extra_minutes\nada@example.com,Ada,30\nben@example.com,Ben,0\n");
    await owner.getByRole("button", { name: "Save roster" }).click();
    await expect(owner.getByText("Roster saved: 2 people.")).toBeVisible();

    await owner.getByRole("button", { name: "Publish" }).click();
    await expect(owner.getByText("scheduled", { exact: true })).toBeVisible();
    await expectAccessible(owner);
});

test("staff grade a rubric, release the grades, and the candidate reads their result", async ({
    browser,
}) => {
    const staff = freshEmail();
    const candidate = freshEmail();
    const exam = await seedClosedExam(staff, candidate);

    const owner = await pageFor(browser, staff);
    await owner.goto(`/exams/${exam}/grading`);
    await expect(owner.getByText("automatic 70 of 100 points", { exact: false })).toBeVisible();
    await owner.getByRole("button", { name: "Show the answer" }).click();
    await expect(owner.getByText("int main() { return 0; }")).toBeVisible();
    await owner.getByLabel(/^Readable code/).fill("25");
    await owner.getByLabel("Comment for the candidate").fill("Clear and tidy.");
    await owner.getByRole("button", { name: "Save grade" }).click();
    await expect(owner.getByText("Saved.")).toBeVisible();
    await expect(owner.getByText("total 95", { exact: false })).toBeVisible();
    await expectAccessible(owner);

    await owner.goto(`/exams/${exam}`);
    await owner.getByRole("button", { name: "Release grades" }).click();
    await expect(owner.getByText("Grades released.")).toBeVisible();

    const student = await pageFor(browser, candidate);
    await student.goto(`/exams/${exam}`);
    await expect(
        student.getByRole("heading", { name: "Your result: 95 of 100 points" }),
    ).toBeVisible();
    await expect(student.getByText("Comment: Clear and tidy.")).toBeVisible();
    await expectAccessible(student);
});

test("staff watch the monitor and replay an answer; the candidate cannot", async ({ browser }) => {
    const staff = freshEmail();
    const candidate = freshEmail();
    const exam = await seedClosedExam(staff, candidate);

    const owner = await pageFor(browser, staff);
    await owner.goto(`/exams/${exam}/monitor`);
    await expect(owner.getByRole("heading", { name: "Monitor" })).toBeVisible();
    await expect(owner.getByText(candidate, { exact: false })).toBeVisible();
    await expectAccessible(owner);
    await owner.getByRole("link", { name: "A", exact: true }).click();
    await expect(owner.getByText("int main() { return 0; }")).toBeVisible();
    await expectAccessible(owner);

    const student = await pageFor(browser, candidate);
    await student.goto(`/exams/${exam}/monitor`);
    await expect(student.getByText("There is nothing to monitor here.")).toBeVisible();
});
