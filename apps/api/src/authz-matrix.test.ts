// Goal: every route under /api/v1 must declare who may call it, and the declaration must be true.
// The test reads the app's real route table, so a new route without a row (or a row for a route
// that no longer exists) fails CI. It then generates the checks from the rows:
//   anonymous callers get 401 on routes that need a person,
//   a valid session without the custom CSRF header gets 403 on every state-changing route,
//   another person's valid session gets 404 on routes that address one of the caller's own objects.
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

interface Row {
    readonly method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
    readonly path: string;
    // "public": anyone, including anonymous callers. "user": a signed-in person.
    readonly access: "public" | "user";
    // The path addresses an object owned by one person; another person must get 404, not 403.
    readonly owned?: true;
}

// Add a row in the same pull request that adds a route. This list is the written access policy.
const MATRIX: readonly Row[] = [
    { method: "GET", path: "/api/v1/me", access: "user" },
    { method: "GET", path: "/api/v1/me/sessions", access: "user" },
    { method: "DELETE", path: "/api/v1/me/sessions/:id", access: "user", owned: true },
    // Idempotent on purpose: with no session it still succeeds and clears a stale cookie.
    { method: "POST", path: "/api/v1/auth/logout", access: "public" },
    { method: "POST", path: "/api/v1/auth/logout-all", access: "user" },
];

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAMPLE_ID = encodeId("ses", "018f0000-0000-7000-8000-0000000000ee");

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
});
afterAll(async () => {
    await h.drop();
});

const concrete = (path: string) => path.replace(":id", SAMPLE_ID);
const call = (row: Row, headers: Record<string, string>) =>
    h.app().request(concrete(row.path), { method: row.method, headers });

describe("route table", () => {
    it("matches the declared matrix exactly", () => {
        const registered = h
            .app()
            .routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/api/v1"))
            .map((r) => `${r.method} ${r.path}`)
            .sort();
        const declared = MATRIX.map((r) => `${r.method} ${r.path}`).sort();
        expect(registered).toEqual(declared);
    });

    it("answers 404 for paths that are not declared", async () => {
        const { token } = await h.login(ALICE);
        for (const path of ["/api/v1/nothing", "/api/v1/me/secrets", "/api/v1/admin"]) {
            const response = await h.app().request(path, { headers: browser(token) });
            expect(response.status, path).toBe(404);
        }
    });
});

describe("generated checks", () => {
    for (const row of MATRIX) {
        const name = `${row.method} ${row.path}`;

        if (row.access === "user") {
            it(`${name}: anonymous callers get 401`, async () => {
                const response = await call(row, browser(null));
                expect(response.status).toBe(401);
            });
        }

        if (UNSAFE.has(row.method)) {
            it(`${name}: refuses a valid session without the CSRF header with 403`, async () => {
                const { token } = await h.login(ALICE);
                const headers = browser(token);
                delete headers["x-aura-request"];
                expect((await call(row, headers)).status).toBe(403);
            });
        }

        if (row.owned === true) {
            it(`${name}: another person's valid session gets 404, never the object`, async () => {
                const victim = await h.login(ALICE);
                const intruder = await h.login(BOB);
                const path = row.path.replace(":id", encodeId("ses", victim.session.id));
                const response = await h.app().request(path, {
                    method: row.method,
                    headers: browser(intruder.token),
                });
                expect(response.status).toBe(404);
                expect((await h.request("/me", { headers: browser(victim.token) })).status).toBe(
                    200,
                );
            });
        }
    }
});
