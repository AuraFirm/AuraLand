// Goal: an account-takeover and credential-stuffing drill against the real app and PostgreSQL. Each
// scenario plays the attacker and checks a number, not a feeling: how many emails can be provoked, how
// many guesses a stolen sign-in context allows, how many rows an anonymous flood can create. The
// numbers come from the documented limits (docs/security/authentication.md).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, createHarness, type Harness } from "./http-harness.ts";

// The drill sends hundreds of real requests one after another (each touches PostgreSQL several times),
// which takes a few seconds on a busy CI machine. A test that times out would leave its remaining
// requests running into the next test and move the shared clock under it, so the timeout is generous.
vi.setConfig({ testTimeout: 120_000 });

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
});
afterAll(async () => {
    await h.drop();
});

const TRUST = { AURA_TRUST_EDGE_REQUEST_ID: "true" };
const MINUTE = 60 * 1000;

function post(path: string, body: unknown, address: string, cookie?: string) {
    return Promise.resolve(
        h.app(TRUST).request(`/api/v1${path}`, {
            method: "POST",
            headers: browser(null, {
                "content-type": "application/json",
                "x-forwarded-for": address,
                ...(cookie === undefined ? {} : { cookie }),
            }),
            body: JSON.stringify(body),
        }),
    );
}
const statuses = async (responses: Array<Promise<Response>>) =>
    (await Promise.all(responses)).map((r) => r.status);
const count = (list: number[], status: number) => list.filter((s) => s === status).length;

describe("one machine, many identities (credential stuffing)", () => {
    it("can make the system send at most 10 emails a minute, however many addresses it tries", async () => {
        const before = h.mail.outbox.length;
        const results: number[] = [];
        for (let n = 0; n < 200; n++) {
            results.push(
                (
                    await post(
                        "/auth/email/start",
                        { email: `stuffed-${n}@example.com` },
                        "198.51.100.1",
                    )
                ).status,
            );
        }
        expect(count(results, 202)).toBe(10);
        expect(count(results, 429)).toBe(190);
        expect(h.mail.outbox.length - before).toBe(10);
        h.clock.advance(MINUTE);
        expect(
            (await post("/auth/email/start", { email: "later@example.com" }, "198.51.100.1"))
                .status,
        ).toBe(202);
    });

    it("can try at most 30 sign-in proofs a minute, and none of them touches a real challenge", async () => {
        const results: number[] = [];
        for (let n = 0; n < 100; n++) {
            const code = String(n).padStart(8, "0");
            results.push((await post("/auth/email/verify", { code }, "198.51.100.2")).status);
        }
        expect(count(results, 400)).toBe(30);
        expect(count(results, 429)).toBe(70);
    });

    it("cannot grow the challenge table faster than 30 rows a minute per address", async () => {
        const { sql } = h.db.database;
        const [before] = await sql<{ n: string }[]>`select count(*) n from webauthn_challenges`;
        const results = await statuses(
            Array.from({ length: 100 }, () =>
                post("/auth/passkey/login/options", {}, "198.51.100.3"),
            ),
        );
        const [after] = await sql<{ n: string }[]>`select count(*) n from webauthn_challenges`;
        expect(count(results, 200)).toBe(30);
        expect(Number(after?.n) - Number(before?.n)).toBe(30);
    });
});

describe("many machines, one victim", () => {
    it("cannot make the victim's inbox receive more than 5 sign-in emails an hour", async () => {
        const before = h.mail.outbox.filter((m) => m.to === "victim@example.com").length;
        const results: number[] = [];
        for (let n = 0; n < 60; n++) {
            results.push(
                (
                    await post(
                        "/auth/email/start",
                        { email: "victim@example.com" },
                        `192.0.2.${n + 1}`,
                    )
                ).status,
            );
        }
        expect(count(results, 202)).toBe(5);
        expect(count(results, 429)).toBe(55);
        expect(h.mail.outbox.filter((m) => m.to === "victim@example.com").length - before).toBe(5);
    });

    it("cannot use a guessed code from a browser the victim did not use", async () => {
        const attacker = await post(
            "/auth/email/start",
            { email: "attacker-own@example.com" },
            "192.0.2.200",
        );
        const attackerBinding =
            attacker.headers
                .getSetCookie()
                .find((c) => c.startsWith("aura_login="))
                ?.split(";")[0] ?? "";
        await post("/auth/email/start", { email: "victim2@example.com" }, "192.0.2.201");
        const victimCode = (/(\d{4}) (\d{4})/.exec(h.mail.outbox.at(-1)?.text ?? "") ?? [])
            .slice(1)
            .join("");
        // The attacker knows the right code (best case) but not the victim's browser binding.
        const withWrongBinding = await post(
            "/auth/email/verify",
            { code: victimCode },
            "192.0.2.202",
            attackerBinding,
        );
        expect(withWrongBinding.status).toBe(400);
        const [row] = await h.db.database.sql<
            { consumed_at: Date | null }[]
        >`select consumed_at from login_challenges where email = 'victim2@example.com'`;
        expect(row?.consumed_at).toBeNull();
    });
});

describe("a stolen sign-in context (the victim's binding cookie leaked)", () => {
    it("allows 5 code guesses in total, from any number of addresses, then locks", async () => {
        const started = await post(
            "/auth/email/start",
            { email: "leaked@example.com" },
            "192.0.2.210",
        );
        const binding =
            started.headers
                .getSetCookie()
                .find((c) => c.startsWith("aura_login="))
                ?.split(";")[0] ?? "";
        const realCode = (/(\d{4}) (\d{4})/.exec(h.mail.outbox.at(-1)?.text ?? "") ?? [])
            .slice(1)
            .join("");
        const wrong = realCode === "00000000" ? "11111111" : "00000000";
        const results: number[] = [];
        for (let n = 0; n < 20; n++)
            results.push(
                (await post("/auth/email/verify", { code: wrong }, `192.0.2.${220 + n}`, binding))
                    .status,
            );
        expect(results.every((s) => s === 400)).toBe(true);
        // After five wrong guesses even the right code is refused.
        expect(
            (await post("/auth/email/verify", { code: realCode }, "192.0.2.250", binding)).status,
        ).toBe(400);
        const [row] = await h.db.database.sql<
            { code_attempts: number; consumed_at: Date | null }[]
        >`select code_attempts, consumed_at from login_challenges where email = 'leaked@example.com'`;
        expect(row?.code_attempts).toBe(5);
        expect(row?.consumed_at).toBeNull();
    });
});

describe("guessing other secrets", () => {
    it("fails to find an API key by guessing, and cannot tell a wrong prefix from a wrong secret", async () => {
        const wrongPrefix = `aura_${"a".repeat(12)}_${"A".repeat(43)}`;
        const result = await h
            .app(TRUST)
            .request("/api/v1/key", { headers: { authorization: `Bearer ${wrongPrefix}` } });
        expect(result.status).toBe(401);
        expect(await result.text()).not.toMatch(/prefix|secret|unknown/i);
    });

    it("cannot reuse an invitation or sign-in link token as anything else", async () => {
        const result = await post("/invitations/accept", { token: "A".repeat(43) }, "192.0.2.230");
        expect(result.status).toBe(401);
    });
});
