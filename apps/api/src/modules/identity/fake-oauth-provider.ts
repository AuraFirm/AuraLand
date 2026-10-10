import { createHash, randomBytes } from "node:crypto";
import { startTestServer, type TestServer } from "../../platform/test-helpers.ts";
import type { ProviderEndpoints } from "./oauth-providers.ts";

// A stand-in for GitHub and Google for tests: one local server that behaves like both providers'
// token and profile endpoints, including PKCE. A test "signs in at the provider" by calling
// `authorize`, which returns the code the real provider would put in the redirect.

export interface FakeProfile {
    readonly id: string;
    readonly email: string | null;
    readonly emailVerified: boolean;
}

interface IssuedCode {
    readonly profile: FakeProfile;
    readonly challenge: string;
}

export interface FakeOAuthProvider {
    readonly endpoints: ProviderEndpoints;
    // Every token request the server saw, for assertions about what we send.
    readonly tokenRequests: Array<Record<string, string>>;
    authorize(profile: FakeProfile, codeChallenge: string): string;
    // Makes the next profile or token call answer with this status.
    failNextWith(status: number): void;
    close(): Promise<void>;
}

const sha256Base64Url = (text: string) => createHash("sha256").update(text).digest("base64url");

interface State {
    readonly codes: Map<string, IssuedCode>;
    readonly tokens: Map<string, FakeProfile>;
    readonly tokenRequests: Array<Record<string, string>>;
}

type Send = (status: number, json: unknown) => void;

function handleToken(state: State, url: string, body: string, send: Send) {
    const fields = Object.fromEntries(new URLSearchParams(body));
    state.tokenRequests.push(fields);
    const issued = state.codes.get(fields["code"] ?? "");
    state.codes.delete(fields["code"] ?? "");
    const verifierOk = sha256Base64Url(fields["code_verifier"] ?? "") === issued?.challenge;
    if (issued === undefined || !verifierOk) {
        // GitHub reports a bad code inside a 200; Google uses a 400.
        return url === "/token"
            ? send(400, { error: "invalid_grant" })
            : send(200, { error: "bad_verification_code" });
    }
    const accessToken = randomBytes(16).toString("hex");
    state.tokens.set(accessToken, issued.profile);
    send(200, { access_token: accessToken, token_type: "bearer" });
}

function handleProfile(profile: FakeProfile, url: string, send: Send) {
    if (url === "/user") return send(200, { id: Number(profile.id), login: "someone" });
    if (url === "/user/emails") {
        return send(
            200,
            profile.email === null
                ? []
                : [
                      { email: "other@example.com", primary: false, verified: true },
                      { email: profile.email, primary: true, verified: profile.emailVerified },
                  ],
        );
    }
    if (url === "/v1/userinfo") {
        return send(200, {
            sub: profile.id,
            ...(profile.email === null ? {} : { email: profile.email }),
            email_verified: profile.emailVerified,
        });
    }
    send(404, {});
}

export async function startFakeOAuthProvider(): Promise<FakeOAuthProvider> {
    const state: State = { codes: new Map(), tokens: new Map(), tokenRequests: [] };
    let failure: number | null = null;

    const server: TestServer = await startTestServer((request, body, response) => {
        const send: Send = (status, json) =>
            response
                .writeHead(status, { "content-type": "application/json" })
                .end(JSON.stringify(json));
        if (failure !== null) {
            const status = failure;
            failure = null;
            return send(status, { error: "server_error" });
        }
        const url = request.url ?? "";
        if (
            request.method === "POST" &&
            (url === "/login/oauth/access_token" || url === "/token")
        ) {
            return handleToken(state, url, body, send);
        }
        const profile = state.tokens.get(
            (request.headers.authorization ?? "").replace("Bearer ", ""),
        );
        if (profile === undefined) return send(401, { message: "Bad credentials" });
        handleProfile(profile, url, send);
    });

    return {
        endpoints: {
            authorizeBase: `${server.origin}/authorize`,
            tokenOrigin: server.origin,
            apiOrigin: server.origin,
        },
        tokenRequests: state.tokenRequests,
        authorize(profile, codeChallenge) {
            const code = randomBytes(12).toString("hex");
            state.codes.set(code, { profile, challenge: codeChallenge });
            return code;
        },
        failNextWith(status) {
            failure = status;
        },
        close: () => server.close(),
    };
}
