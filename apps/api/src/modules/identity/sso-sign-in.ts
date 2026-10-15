import { createHash } from "node:crypto";
import type { SsoFailureReason } from "@aura/contracts/api/sso";
import { encodeId } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import type { Clock } from "../../platform/clock.ts";
import type { Rng } from "../../platform/rng.ts";
import { type IdTokenResult, type OidcTransport, verifyIdToken } from "../sso/service.ts";
import { OAUTH_FLOW_TTL_S, OAUTH_SECRET_BYTES } from "./limits.ts";
import { hashSecret } from "./login.ts";
import { findUserIdByEmail, findUserStatus } from "./oauth-queries.ts";
import { findOrCreateAccount } from "./queries.ts";
import type { SessionDeps } from "./service.ts";
import { issueLoginSession, type LoginSessionInput, userAudit } from "./sign-in.ts";
import {
    type Connection,
    connectionOf,
    consumeSsoFlow,
    findSsoIdentity,
    insertSsoFlow,
    insertSsoIdentity,
    joinOrg,
    orgForEmail,
    orgHasRoom,
    touchSsoIdentity,
    verifiedDomains,
} from "./sso-queries.ts";

// Signing in through an organization's identity provider (Stage 9, slice 6b, ADR 0036). The rules that matter:
//   1. A subject at the provider is the same person on every sign-in; the email is not what identifies them.
//   2. An existing account is attached to a subject only if the id_token's verified email is in a domain the organization has
//      proved it controls (whoever controls the domain controls that mailbox, so this is no weaker than an email link).
//   3. A new account joins the organization as a member, if the plan has room; otherwise nothing is created.
//   4. The redirect address is computed here and never read from a request.

export interface SsoDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly key: Buffer;
    readonly publicOrigin: string;
    readonly oidc: OidcTransport;
}

export const ssoRedirectUri = (publicOrigin: string) => `${publicOrigin}/api/v1/auth/sso/callback`;
const randomText = (rng: Rng) =>
    Buffer.from(rng.nextBytes(OAUTH_SECRET_BYTES)).toString("base64url");

export interface StartedSso {
    readonly authorizationUrl: string;
    // Goes in the browser cookie; the server keeps only its hash.
    readonly verifier: string;
}

// Null when no organization has proved this address's domain and connected a provider.
export async function startSso(
    tx: Transaction,
    deps: SsoDeps,
    email: string,
): Promise<StartedSso | null> {
    const org = await orgForEmail(tx, email);
    if (org === null) return null;
    const connection = await connectionOf(tx, org);
    if (connection === null) return null;
    const [state, verifier, nonce] = [
        randomText(deps.rng),
        randomText(deps.rng),
        randomText(deps.rng),
    ];
    await insertSsoFlow(tx, {
        org,
        stateHash: hashSecret(deps.key, "sso_state", state),
        verifierHash: hashSecret(deps.key, "sso_verifier", verifier),
        nonce,
        nowMs: deps.clock.nowUnixMs(),
        ttlS: OAUTH_FLOW_TTL_S,
    });
    const url = new URL(connection.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", connection.client_id);
    url.searchParams.set("redirect_uri", ssoRedirectUri(deps.publicOrigin));
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set(
        "code_challenge",
        createHash("sha256").update(verifier).digest("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("login_hint", email);
    return { authorizationUrl: url.toString(), verifier };
}

export async function spendSsoFlow(
    tx: Transaction,
    deps: Pick<SsoDeps, "clock" | "key">,
    proof: { state: string; verifier: string },
) {
    const spent = await consumeSsoFlow(tx, {
        stateHash: hashSecret(deps.key, "sso_state", proof.state),
        verifierHash: hashSecret(deps.key, "sso_verifier", proof.verifier),
        nowMs: deps.clock.nowUnixMs(),
    });
    if (spent === null) return null;
    const connection = await connectionOf(tx, spent.org);
    return connection === null ? null : { ...spent, connection };
}

// The network part of the callback, kept apart from any transaction: trade the code for an id_token and check it.
export async function fetchAndVerify(
    deps: Pick<SsoDeps, "clock" | "oidc">,
    flow: { nonce: string; connection: Connection },
    exchange: { code: string; verifier: string; redirectUri: string },
): Promise<IdTokenResult | "unavailable"> {
    const { connection } = flow;
    const idToken = await deps.oidc.exchangeCode({
        tokenEndpoint: connection.token_endpoint,
        clientId: connection.client_id,
        clientSecret: connection.client_secret,
        code: exchange.code,
        codeVerifier: exchange.verifier,
        redirectUri: exchange.redirectUri,
    });
    if (idToken === null) return { ok: false, reason: "malformed" };
    const keys = await deps.oidc.fetchJwks(connection.jwks_uri);
    if (keys === null) return "unavailable";
    return verifyIdToken(idToken, {
        issuer: connection.issuer,
        clientId: connection.client_id,
        nonce: flow.nonce,
        nowMs: deps.clock.nowUnixMs(),
        keys,
    });
}

export type SsoResolution =
    | { readonly kind: "signed_in"; readonly token: string; readonly newAccount: boolean }
    | { readonly kind: "refused"; readonly reason: SsoFailureReason };

const refused = (reason: SsoFailureReason): SsoResolution => ({ kind: "refused", reason });

export async function resolveSso(
    tx: Transaction,
    deps: Pick<SsoDeps, "clock" | "rng">,
    sessions: SessionDeps,
    input: {
        org: string;
        subject: string;
        email: string;
        session: Omit<LoginSessionInput, "userId" | "method">;
    },
): Promise<SsoResolution> {
    const nowMs = deps.clock.nowUnixMs();
    const known = await findSsoIdentity(tx, input.org, input.subject);
    if (known !== null) {
        if (known.status !== "active") return refused("suspended");
        await touchSsoIdentity(tx, input.org, input.subject, nowMs);
        return signedIn(tx, sessions, input, known.userId, false);
    }
    // A new subject. The address must be one the organization has proved it controls.
    const domain = input.email.split("@")[1] ?? "";
    if (!(await verifiedDomains(tx, input.org)).includes(domain)) return refused("wrong_domain");
    const existing = await findUserIdByEmail(tx, input.email);
    if (existing !== null && (await findUserStatus(tx, existing)) !== "active")
        return refused("suspended");
    // A full organization must leave no stray account behind, so room is checked before anything is created.
    if (existing === null && !(await orgHasRoom(tx, input.org))) return refused("plan_full");
    const userId = existing ?? (await createAccount(tx, deps, input.email, nowMs));
    if (userId === null) return refused("invalid");
    if ((await joinOrg(tx, input.org, userId)) === "full") return refused("plan_full");
    if (!(await insertSsoIdentity(tx, { org: input.org, subject: input.subject, userId, nowMs })))
        return refused("invalid");
    await appendAudit(
        tx,
        userAudit(userId, "auth.sso_linked", input.session.ip, { org: encodeId("org", input.org) }),
    );
    return signedIn(tx, sessions, input, userId, existing === null);
}

async function createAccount(
    tx: Transaction,
    deps: Pick<SsoDeps, "rng">,
    email: string,
    nowMs: number,
): Promise<string | null> {
    const handle = `user_${Buffer.from(deps.rng.nextBytes(5)).toString("hex")}`;
    const account = await findOrCreateAccount(tx, email, handle, nowMs);
    return account.created ? account.id : null;
}

async function signedIn(
    tx: Transaction,
    sessions: SessionDeps,
    input: { session: Omit<LoginSessionInput, "userId" | "method"> },
    userId: string,
    newAccount: boolean,
): Promise<SsoResolution> {
    const token = await issueLoginSession(tx, sessions, {
        ...input.session,
        userId,
        method: "sso",
    });
    return { kind: "signed_in", token, newAccount };
}

export async function recordSsoRefusal(
    tx: Transaction,
    org: string,
    reason: string,
    ip: string | null,
): Promise<void> {
    await appendAudit(tx, {
        actorKind: "anonymous",
        actorUserId: null,
        orgId: null,
        action: "auth.sso_refused",
        target: encodeId("org", org),
        ip,
        detail: { reason },
    });
}
