import { createHash } from "node:crypto";
import { assert } from "@aura/contracts/assert";
import { encodeId } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import type { Clock } from "../../platform/clock.ts";
import type { Rng } from "../../platform/rng.ts";
import { OAUTH_FLOW_TTL_S, OAUTH_SECRET_BYTES } from "./limits.ts";
import { hashSecret } from "./login.ts";
import type { OAuthProvider, ProviderName, ProviderProfile } from "./oauth-providers.ts";
import {
    consumeFlow,
    type FlowPurpose,
    findIdentity,
    findUserIdByEmail,
    findUserStatus,
    insertFlow,
    insertIdentity,
    touchIdentity,
} from "./oauth-queries.ts";
import { findOrCreateAccount } from "./queries.ts";
import type { SessionDeps } from "./service.ts";
import { issueLoginSession, type LoginSessionInput, userAudit } from "./sign-in.ts";

// OAuth sign-in use-cases (ADR 0016). The rules that matter most are in `resolveSignIn`:
//   1. A known provider identity signs its owner in, whatever their email is now.
//   2. A new identity may create an account only with a provider-verified email that no existing
//      account uses. If one does, nothing is linked and the person is told to sign in the usual way
//      and connect the provider from settings. That closes pre-account takeover.
//   3. A "link" attempt attaches the identity to the person who is signed in, and only to them.

export interface OAuthDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly key: Buffer;
    readonly publicOrigin: string;
}

// The one redirect address we register with the providers; it is computed here, never read from a
// request, so it cannot be steered.
export function redirectUriFor(publicOrigin: string, provider: ProviderName): string {
    return `${publicOrigin}/api/v1/auth/oauth/${provider}/callback`;
}

const randomText = (rng: Rng) =>
    Buffer.from(rng.nextBytes(OAUTH_SECRET_BYTES)).toString("base64url");

export interface StartedFlow {
    readonly authorizationUrl: string;
    // Goes in the browser cookie; the server keeps only its hash.
    readonly verifier: string;
}

export async function startOAuth(
    tx: Transaction,
    deps: OAuthDeps,
    provider: OAuthProvider,
    flow: { readonly purpose: FlowPurpose; readonly userId: string | null },
): Promise<StartedFlow> {
    assert((flow.purpose === "link") === (flow.userId !== null), "link flows name their person");
    const state = randomText(deps.rng);
    const verifier = randomText(deps.rng);
    await insertFlow(tx, {
        provider: provider.name,
        purpose: flow.purpose,
        userId: flow.userId,
        stateHash: hashSecret(deps.key, "oauth_state", state),
        verifierHash: hashSecret(deps.key, "oauth_verifier", verifier),
        nowMs: deps.clock.nowUnixMs(),
        ttlS: OAUTH_FLOW_TTL_S,
    });
    const authorizationUrl = provider.authorizationUrl({
        state,
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        redirectUri: redirectUriFor(deps.publicOrigin, provider.name),
    });
    return { authorizationUrl, verifier };
}

export function spendFlow(
    tx: Transaction,
    deps: Pick<OAuthDeps, "clock" | "key">,
    provider: ProviderName,
    proof: { readonly state: string; readonly verifier: string },
) {
    return consumeFlow(tx, {
        provider,
        stateHash: hashSecret(deps.key, "oauth_state", proof.state),
        verifierHash: hashSecret(deps.key, "oauth_verifier", proof.verifier),
        nowMs: deps.clock.nowUnixMs(),
    });
}

export type RefusalReason =
    | "email_unverified"
    | "account_exists"
    | "identity_taken"
    | "suspended"
    | "invalid";

export type Resolution =
    | { readonly kind: "signed_in"; readonly token: string; readonly newAccount: boolean }
    | { readonly kind: "linked" }
    | { readonly kind: "refused"; readonly reason: RefusalReason };

export interface ResolveInput {
    readonly provider: ProviderName;
    readonly profile: ProviderProfile;
    readonly flow: { readonly purpose: FlowPurpose; readonly userId: string | null };
    // Who is signed in right now in this browser, if anyone.
    readonly currentUserId: string | null;
    readonly session: Omit<LoginSessionInput, "userId" | "method">;
}

const refused = (reason: RefusalReason): Resolution => ({ kind: "refused", reason });

export async function resolveSignIn(
    tx: Transaction,
    deps: OAuthDeps,
    sessions: SessionDeps,
    input: ResolveInput,
): Promise<Resolution> {
    const nowMs = deps.clock.nowUnixMs();
    const existing = await findIdentity(tx, input.provider, input.profile.providerUserId);
    if (input.flow.purpose === "link") return resolveLink(tx, input, existing?.userId ?? null);
    if (existing !== null) {
        if (existing.userStatus !== "active") return refused("suspended");
        await touchIdentity(tx, existing.id, nowMs);
        const token = await issueLoginSession(tx, sessions, {
            ...input.session,
            userId: existing.userId,
            method: input.provider,
        });
        return { kind: "signed_in", token, newAccount: false };
    }
    return resolveNewIdentity(tx, deps, sessions, input);
}

async function resolveLink(
    tx: Transaction,
    input: ResolveInput,
    ownerOfIdentity: string | null,
): Promise<Resolution> {
    const { userId } = input.flow;
    // The person who started linking must still be the one signed in, so a flow cannot be finished
    // in a browser belonging to someone else.
    if (userId === null || input.currentUserId !== userId) return refused("invalid");
    if ((await findUserStatus(tx, userId)) !== "active") return refused("suspended");
    if (ownerOfIdentity !== null) {
        return ownerOfIdentity === userId ? { kind: "linked" } : refused("identity_taken");
    }
    const added = await insertIdentity(tx, {
        userId,
        provider: input.provider,
        providerUserId: input.profile.providerUserId,
        email: input.profile.verifiedEmail,
    });
    // False means this person already has another identity at this provider.
    if (!added) return refused("identity_taken");
    await appendAudit(
        tx,
        userAudit(userId, "auth.identity_linked", input.session.ip, { provider: input.provider }),
    );
    return { kind: "linked" };
}

async function resolveNewIdentity(
    tx: Transaction,
    deps: OAuthDeps,
    sessions: SessionDeps,
    input: ResolveInput,
): Promise<Resolution> {
    const email = input.profile.verifiedEmail;
    if (email === null) return refused("email_unverified");
    // Never link to an account found by email alone: whoever controls a provider account with that
    // address has not proven they control ours.
    if ((await findUserIdByEmail(tx, email)) !== null) return refused("account_exists");
    const handle = `user_${Buffer.from(deps.rng.nextBytes(5)).toString("hex")}`;
    const account = await findOrCreateAccount(tx, email, handle, deps.clock.nowUnixMs());
    if (!account.created) return refused("account_exists");
    const added = await insertIdentity(tx, {
        userId: account.id,
        provider: input.provider,
        providerUserId: input.profile.providerUserId,
        email,
    });
    assert(added, "a brand-new account has no identities yet");
    const ip = input.session.ip;
    await appendAudit(tx, userAudit(account.id, "auth.signup", ip, { method: input.provider }));
    await appendAudit(
        tx,
        userAudit(account.id, "auth.identity_linked", ip, { provider: input.provider }),
    );
    const token = await issueLoginSession(tx, sessions, {
        ...input.session,
        userId: account.id,
        method: input.provider,
    });
    return { kind: "signed_in", token, newAccount: true };
}

export async function recordRefusal(
    tx: Transaction,
    provider: ProviderName,
    reason: RefusalReason,
    ip: string | null,
): Promise<void> {
    await appendAudit(tx, {
        actorKind: "anonymous",
        actorUserId: null,
        orgId: null,
        action: "auth.oauth_refused",
        ip,
        detail: { provider, reason },
    });
}

export async function unlinkAudit(
    tx: Transaction,
    userId: string,
    provider: ProviderName,
): Promise<void> {
    await appendAudit(tx, {
        ...userAudit(userId, "auth.identity_unlinked", null, { provider }),
        target: encodeId("usr", userId),
    });
}
