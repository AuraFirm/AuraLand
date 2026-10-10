import { assert } from "@aura/contracts/assert";
import type { AuditEntryInput } from "@aura/contracts/audit";
import { encodeId } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import type { MailPort } from "../../platform/mail.ts";
import { LOGIN_CODE_ATTEMPTS_MAX, LOGIN_CODE_TTL_S, LOGIN_LINK_TTL_S } from "./limits.ts";
import {
    type ChallengeDeps,
    type ChallengeStore,
    formatCode,
    hashSecret,
    type NewChallenge,
    newChallenge,
    normalizeCode,
} from "./login.ts";
import { isPrivilegedAccount } from "./org-queries.ts";
import { findOrCreateAccount } from "./queries.ts";
import type { AuthMethod } from "./rules.ts";
import { createSession, revokeSession, type SessionDeps } from "./service.ts";

// Email sign-in use-cases. `startSignIn` stores a challenge; `sendSignInEmail` delivers it (after
// the challenge is committed, so no database transaction waits on the mail service). `completeSignIn`
// checks the proof, finds or creates the account and starts a session, all in one transaction, so a
// failure anywhere leaves the link unused.

export interface StartDeps extends ChallengeDeps {
    readonly challenges: ChallengeStore;
}

export function startSignIn(deps: StartDeps, email: string): Promise<NewChallenge> {
    const challenge = newChallenge(deps, email);
    return deps.challenges.insert(challenge.record).then(() => challenge);
}

export async function sendSignInEmail(
    mail: MailPort,
    publicOrigin: string,
    email: string,
    challenge: Pick<NewChallenge, "token" | "code">,
): Promise<void> {
    // The token sits in the URL fragment, which browsers never send to servers, logs or referrers.
    const link = `${publicOrigin}/auth/verify#t=${challenge.token}`;
    const text = [
        "Sign in to AuraLand",
        "",
        `Open this link in the same browser you started from (valid ${LOGIN_LINK_TTL_S / 60} minutes):`,
        link,
        "",
        `Or enter this code (valid ${LOGIN_CODE_TTL_S / 60} minutes): ${formatCode(challenge.code)}`,
        "",
        "If you did not ask for this, ignore this email. Nobody can sign in without it.",
    ].join("\n");
    await mail.send({ to: email, subject: "Your AuraLand sign-in", text });
}

export type Proof = { readonly token: string } | { readonly code: string };

export type ProofResult =
    | { readonly ok: true; readonly email: string; readonly method: AuthMethod }
    | { readonly ok: false; readonly locked: boolean };

export interface VerifyDeps {
    readonly challenges: ChallengeStore;
    readonly key: Buffer;
    readonly nowMs: number;
}

// Checks one proof against this browser's challenge. A wrong code is counted by the store; the
// result says whether that guess used up the last attempt.
export async function checkProof(
    deps: VerifyDeps,
    binding: string,
    proof: Proof,
): Promise<ProofResult> {
    const bindingHash = hashSecret(deps.key, "binding", binding);
    if ("token" in proof) {
        const used = await deps.challenges.consumeWithLink(
            bindingHash,
            hashSecret(deps.key, "link", proof.token),
            deps.nowMs,
        );
        return used === null
            ? { ok: false, locked: false }
            : { ok: true, email: used.email, method: "email_link" };
    }
    const code = normalizeCode(proof.code);
    if (code === null) return { ok: false, locked: false };
    const attempt = await deps.challenges.tryCode(
        bindingHash,
        hashSecret(deps.key, "code", code),
        deps.nowMs,
    );
    if (attempt === null) return { ok: false, locked: false };
    if (attempt.consumed) return { ok: true, email: attempt.email, method: "email_code" };
    return { ok: false, locked: attempt.attempts >= LOGIN_CODE_ATTEMPTS_MAX };
}

export interface CompleteInput {
    readonly email: string;
    readonly method: AuthMethod;
    readonly ipNetwork: string | null;
    readonly ip: string | null;
    readonly userAgent: string | null;
    // The session the browser is already using, if any; ended so one browser holds one login.
    readonly previousSessionId: string | null;
}

export type CompleteResult =
    | { readonly ok: true; readonly token: string; readonly newAccount: boolean }
    | { readonly ok: false };

const HANDLE_RANDOM_BYTES = 5;

export function userAudit(
    userId: string,
    action: string,
    ip: string | null,
    detail: Record<string, string> = {},
): AuditEntryInput {
    return {
        actorKind: "user",
        actorUserId: userId,
        orgId: null,
        action,
        target: encodeId("usr", userId),
        ip,
        detail,
    };
}

export interface LoginSessionInput {
    readonly userId: string;
    readonly method: AuthMethod;
    readonly ipNetwork: string | null;
    readonly ip: string | null;
    readonly userAgent: string | null;
    // The session the browser is already using, if any; ended so one browser holds one login.
    readonly previousSessionId: string | null;
}

// The shared tail of every successful sign-in, whatever the method: end the browser's previous
// session, start a new one, and record it. Runs as `aura_auth`. Returns the new session token.
export async function issueLoginSession(
    tx: Transaction,
    deps: SessionDeps,
    input: LoginSessionInput,
): Promise<string> {
    if (input.previousSessionId !== null) {
        await revokeSession(deps, input.previousSessionId, "rotated");
    }
    const created = await createSession(deps, {
        userId: input.userId,
        authMethod: input.method,
        privileged: await isPrivilegedAccount(tx, input.userId),
        ipNetwork: input.ipNetwork,
        userAgent: input.userAgent,
    });
    await appendAudit(
        tx,
        userAudit(input.userId, "auth.login_succeeded", input.ip, { method: input.method }),
    );
    return created.token;
}

// Runs as `aura_auth`. Refuses suspended accounts without creating a session.
export async function completeSignIn(
    tx: Transaction,
    deps: SessionDeps,
    input: CompleteInput,
): Promise<CompleteResult> {
    assert(input.email === input.email.toLowerCase(), "email must be normalized");
    assert(input.method === "email_link" || input.method === "email_code", "email method only");
    const nowMs = deps.clock.nowUnixMs();
    const handle = `user_${Buffer.from(deps.rng.nextBytes(HANDLE_RANDOM_BYTES)).toString("hex")}`;
    const account = await findOrCreateAccount(tx, input.email, handle, nowMs);
    if (account.status !== "active") {
        await appendAudit(
            tx,
            userAudit(account.id, "auth.login_refused", input.ip, { reason: "suspended" }),
        );
        return { ok: false };
    }
    if (account.created) await appendAudit(tx, userAudit(account.id, "auth.signup", input.ip));
    const token = await issueLoginSession(tx, deps, { ...input, userId: account.id });
    return { ok: true, token, newAccount: account.created };
}
