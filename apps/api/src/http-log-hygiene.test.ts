// Goal: Stage 1 handles many secrets (sign-in links and codes, cookies, session tokens, API keys,
// OAuth state, invitation links, passkey data) and personal data (email addresses). After running every
// flow through the real app with logging at debug level and no redaction, none of them may appear in
// any log line (docs/kit/08 section 14, "no PII or secrets in logs").

import { randomBytes } from "node:crypto";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import {
    type FakeOAuthProvider,
    startFakeOAuthProvider,
} from "./modules/identity/fake-oauth-provider.ts";
import { createGithubProvider } from "./modules/identity/oauth-providers.ts";
import { createVirtualAuthenticator } from "./modules/identity/virtual-authenticator.ts";

let h: Harness;
let fake: FakeOAuthProvider;
beforeAll(async () => {
    h = await createHarness();
    fake = await startFakeOAuthProvider();
});
afterAll(async () => {
    await fake.close();
    await h.drop();
});

const TRUST = { AURA_TRUST_EDGE_REQUEST_ID: "true" };
const secrets = new Set<string>();
const remember = (...values: Array<string | undefined>) => {
    for (const value of values) if (value !== undefined && value.length >= 8) secrets.add(value);
};
let counter = 0;

function app() {
    return h.app(
        TRUST,
        undefined,
        new Map([
            [
                "github" as const,
                createGithubProvider({ clientId: "c", clientSecret: "s" }, fake.endpoints),
            ],
        ]),
    );
}
async function call(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
) {
    return app().request(`/api/v1${path}`, {
        method,
        headers: browser(token, {
            "content-type": "application/json",
            "x-forwarded-for": `203.0.113.${++counter}`,
            ...extra,
        }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
const cookieValue = (response: Response, name: string) =>
    response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${name}=`))
        ?.split(";")[0]
        ?.split("=")[1] ?? "";

async function emailSignIns() {
    for (const useLink of [true, false]) {
        const email = `hygiene-${++counter}-person@example.com`;
        remember(email);
        const started = await call(null, "POST", "/auth/email/start", { email });
        const binding = cookieValue(started, "aura_login");
        const text = h.mail.outbox.at(-1)?.text ?? "";
        const token = /#t=([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? "";
        const code = (/(\d{4}) (\d{4})/.exec(text) ?? []).slice(1).join("");
        remember(binding, token, code);
        await call(
            null,
            "POST",
            "/auth/email/verify",
            { code: "00000000" },
            { cookie: `aura_login=${binding}` },
        );
        const body = useLink ? { token } : { code };
        const verified = await call(null, "POST", "/auth/email/verify", body, {
            cookie: `aura_login=${binding}`,
        });
        expect(verified.status).toBe(200);
        remember(cookieValue(verified, "aura_session"));
    }
    await call(null, "POST", "/auth/email/start", "not json");
    await call(null, "POST", "/auth/email/start", { email: "bad" });
}

const optionsSchema = z.object({
    challenge_id: z.string(),
    options: z.record(z.string(), z.unknown()),
});

async function signedInFlows() {
    const alice = await h.login(ALICE);
    remember(alice.token, "alice@example.com");
    const authenticator = createVirtualAuthenticator({ origin: ORIGIN, rpId: "localhost" });
    const options = optionsSchema.parse(
        await (await call(alice.token, "POST", "/auth/passkey/register/options", {})).json(),
    );
    remember(String(options.options["challenge"]));
    const credential = authenticator.register(options.options);
    await call(alice.token, "POST", "/auth/passkey/register/verify", {
        challenge_id: options.challenge_id,
        credential,
    });
    remember(authenticator.credentialId);
    const orgId = await team();
    const made = z
        .object({ key: z.string() })
        .parse(
            await (
                await call(alice.token, "POST", `/orgs/${orgId}/api-keys`, { name: "ci" })
            ).json(),
        );
    remember(made.key, made.key.split("_")[2]);
    await app().request("/api/v1/key", { headers: { authorization: `Bearer ${made.key}` } });
    await app().request("/api/v1/key", { headers: { authorization: "Bearer aura_wrongprefix_x" } });
    const invitee = "invited-person@example.com";
    remember(invitee);
    await call(alice.token, "POST", `/orgs/${orgId}/invitations`, { email: invitee });
    remember(/#t=([A-Za-z0-9_-]{43})/.exec(h.mail.outbox.at(-1)?.text ?? "")?.[1]);
}

async function oauthFlow() {
    const started = z
        .object({ authorization_url: z.string() })
        .parse(await (await call(null, "POST", "/auth/oauth/github/start", {})).json());
    const url = new URL(started.authorization_url);
    const state = url.searchParams.get("state") ?? "";
    const code = fake.authorize(
        { id: String(7000 + counter), email: `oauth-${counter}@example.com`, emailVerified: true },
        url.searchParams.get("code_challenge") ?? "",
    );
    remember(state, code, `oauth-${counter}@example.com`);
    remember(cookieValue(await call(null, "POST", "/auth/oauth/github/start", {}), "aura_oauth"));
}

describe("nothing secret reaches the logs", () => {
    it("through email sign-in, sessions, passkeys, API keys, invitations and OAuth", async () => {
        await emailSignIns();
        await signedInFlows();
        await oauthFlow();
        const text = h.logs.join("\n");
        expect(h.logs.length).toBeGreaterThan(10);
        const leaks = [...secrets].filter((secret) => text.includes(secret));
        expect(leaks).toEqual([]);
        // No cookie or authorization header values either.
        expect(text).not.toMatch(/aura_session=|aura_login=|authorization/i);
    });
});

async function team(): Promise<string> {
    const { sql } = h.db.database;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', ${`hygiene-${randomBytes(3).toString("hex")}`}, 'Hygiene') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${ALICE}, 'owner')`;
    return encodeId("org", org?.id ?? "");
}
