import type {
    authenticationCredentialSchema,
    registrationCredentialSchema,
} from "@aura/contracts/api/passkeys";
import { assert, InvariantError } from "@aura/contracts/assert";
import { encodeId } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import type { Rng } from "../../platform/rng.ts";
import {
    PASSKEYS_PER_USER_MAX,
    WEBAUTHN_CHALLENGE_BYTES,
    WEBAUTHN_CHALLENGE_TTL_S,
} from "./limits.ts";
import {
    consumeChallenge,
    countPasskeys,
    findPasskey,
    insertChallenge,
    insertPasskey,
    knownTransports,
    listCredentialsOf,
    recordPasskeyUse,
} from "./passkey-queries.ts";
import { findAccountLabels } from "./queries.ts";
import type { SessionDeps } from "./service.ts";
import { issueLoginSession, type LoginSessionInput, userAudit } from "./sign-in.ts";

// Passkey use-cases over SimpleWebAuthn (ADR 0015). Settings follow the Stage 1 plan: attestation
// "none" (we do not vet device makers), user verification required (a passkey is a second factor
// by itself), resident keys preferred, challenges single-use for five minutes. Everything runs as
// `aura_auth` inside a transaction the caller commits even when the answer is a refusal, so a spent
// challenge stays spent.

export interface PasskeyDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly rpId: string;
    readonly rpName: string;
    readonly origin: string;
}

export interface IssuedOptions {
    readonly challengeId: string;
    readonly options: Record<string, unknown>;
}

// The library encodes the bytes for the browser; the encoded text is what the browser signs back
// and what we store and compare.
function newChallengeBytes(rng: Rng): Uint8Array<ArrayBuffer> {
    return new Uint8Array(rng.nextBytes(WEBAUTHN_CHALLENGE_BYTES));
}

export type BeginRegistration =
    | { readonly ok: true; readonly issued: IssuedOptions }
    | { readonly ok: false; readonly reason: "limit_reached" };

export async function beginRegistration(
    tx: Transaction,
    deps: PasskeyDeps,
    userId: string,
): Promise<BeginRegistration> {
    if ((await countPasskeys(tx, userId)) >= PASSKEYS_PER_USER_MAX) {
        return { ok: false, reason: "limit_reached" };
    }
    const labels = await findAccountLabels(tx, userId);
    const options = await generateRegistrationOptions({
        rpName: deps.rpName,
        rpID: deps.rpId,
        // The user handle is the account id, not the email, so nothing personal sits in the passkey.
        userID: Buffer.from(userId.replaceAll("-", ""), "hex"),
        userName: labels.email,
        userDisplayName: labels.handle,
        challenge: newChallengeBytes(deps.rng),
        attestationType: "none",
        excludeCredentials: await listCredentialsOf(tx, userId),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: WEBAUTHN_CHALLENGE_TTL_S * 1000,
    });
    const challengeId = await insertChallenge(tx, {
        challenge: options.challenge,
        purpose: "register",
        userId,
        nowMs: deps.clock.nowUnixMs(),
        ttlS: WEBAUTHN_CHALLENGE_TTL_S,
    });
    return { ok: true, issued: { challengeId, options: plainJson(options) } };
}

export type FinishRegistration =
    | { readonly ok: true; readonly passkeyId: string }
    | { readonly ok: false };

export interface FinishRegistrationInput {
    readonly userId: string;
    readonly challengeId: string;
    readonly credential: z.infer<typeof registrationCredentialSchema>;
    readonly name: string;
    readonly ip: string | null;
}

export async function finishRegistration(
    tx: Transaction,
    deps: PasskeyDeps,
    input: FinishRegistrationInput,
): Promise<FinishRegistration> {
    const spent = await consumeChallenge(tx, input.challengeId, "register", deps.clock.nowUnixMs());
    // A challenge made for one person can never finish another person's registration.
    if (spent === null || spent.userId !== input.userId) return { ok: false };
    const verified = await verifyOrNull(() =>
        verifyRegistrationResponse({
            response: registrationJson(input.credential),
            expectedChallenge: spent.challenge,
            expectedOrigin: deps.origin,
            expectedRPID: deps.rpId,
            requireUserPresence: true,
            requireUserVerification: true,
        }),
    );
    if (verified === null || !verified.verified) return { ok: false };
    const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
    const passkeyId = await insertPasskey(tx, {
        userId: input.userId,
        credentialId: Buffer.from(credential.id, "base64url"),
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: knownTransports(input.credential.response.transports),
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name: input.name,
    });
    if (passkeyId === null) return { ok: false };
    await appendAudit(tx, {
        ...userAudit(input.userId, "auth.passkey_added", input.ip),
        target: encodeId("pky", passkeyId),
    });
    return { ok: true, passkeyId };
}

export async function beginLogin(tx: Transaction, deps: PasskeyDeps): Promise<IssuedOptions> {
    const options = await generateAuthenticationOptions({
        rpID: deps.rpId,
        challenge: newChallengeBytes(deps.rng),
        // No allowed list: the person picks a passkey from their device (discoverable credentials),
        // so this step reveals nothing about which accounts exist.
        userVerification: "required",
        timeout: WEBAUTHN_CHALLENGE_TTL_S * 1000,
    });
    const challengeId = await insertChallenge(tx, {
        challenge: options.challenge,
        purpose: "login",
        userId: null,
        nowMs: deps.clock.nowUnixMs(),
        ttlS: WEBAUTHN_CHALLENGE_TTL_S,
    });
    return { challengeId, options: plainJson(options) };
}

export type FinishLogin = { readonly ok: true; readonly token: string } | { readonly ok: false };

export interface FinishLoginInput {
    readonly challengeId: string;
    readonly credential: z.infer<typeof authenticationCredentialSchema>;
    readonly session: Omit<LoginSessionInput, "userId" | "method">;
}

export async function finishLogin(
    tx: Transaction,
    deps: PasskeyDeps,
    sessions: SessionDeps,
    input: FinishLoginInput,
): Promise<FinishLogin> {
    const nowMs = deps.clock.nowUnixMs();
    const spent = await consumeChallenge(tx, input.challengeId, "login", nowMs);
    if (spent === null) return { ok: false };
    const stored = await findPasskey(tx, Buffer.from(input.credential.id, "base64url"));
    if (stored === null) return { ok: false };
    const verified = await verifyOrNull(() =>
        verifyAuthenticationResponse({
            response: authenticationJson(input.credential),
            expectedChallenge: spent.challenge,
            expectedOrigin: deps.origin,
            expectedRPID: deps.rpId,
            credential: {
                id: input.credential.id,
                publicKey: new Uint8Array(stored.publicKey),
                counter: stored.counter,
                transports: stored.transports,
            },
            requireUserVerification: true,
        }),
    );
    if (verified === null || !verified.verified) return { ok: false };
    if (!userHandleMatches(input.credential.response.userHandle, stored.userId))
        return { ok: false };
    if (stored.userStatus !== "active") {
        await appendAudit(tx, {
            ...userAudit(stored.userId, "auth.login_refused", input.session.ip, {
                reason: "suspended",
            }),
        });
        return { ok: false };
    }
    await recordPasskeyUse(tx, stored.id, {
        counter: verified.authenticationInfo.newCounter,
        backedUp: verified.authenticationInfo.credentialBackedUp,
        nowMs,
    });
    const token = await issueLoginSession(tx, sessions, {
        ...input.session,
        userId: stored.userId,
        method: "passkey",
    });
    return { ok: true, token };
}

// When the browser reports which account the passkey belongs to, it must be the account we found.
function userHandleMatches(userHandle: string | undefined, userId: string): boolean {
    if (userHandle === undefined) return true;
    return userHandle === Buffer.from(userId.replaceAll("-", ""), "hex").toString("base64url");
}

// The library signals a bad response by throwing. That is an expected outcome here (a wrong
// signature, origin or counter), so it becomes a value; a broken invariant still stops the process.
async function verifyOrNull<T>(verify: () => Promise<T>): Promise<T | null> {
    try {
        return await verify();
    } catch (error) {
        if (error instanceof InvariantError) throw error;
        return null;
    }
}

export function relyingPartyId(origin: string): string {
    const host = new URL(origin).hostname;
    assert(host.length > 0, "origin has a host");
    return host;
}

// The library's types forbid explicit `undefined` for absent fields, which our parsed objects have.
// These copy only the fields that are present.
const present = <K extends string, V>(key: K, value: V | undefined) =>
    value === undefined ? {} : { [key]: value };

function registrationJson(
    c: z.infer<typeof registrationCredentialSchema>,
): RegistrationResponseJSON {
    return {
        id: c.id,
        rawId: c.rawId,
        type: c.type,
        clientExtensionResults: c.clientExtensionResults,
        ...present("authenticatorAttachment", c.authenticatorAttachment),
        response: {
            clientDataJSON: c.response.clientDataJSON,
            attestationObject: c.response.attestationObject,
            ...present("authenticatorData", c.response.authenticatorData),
            ...present("transports", c.response.transports),
            ...present("publicKeyAlgorithm", c.response.publicKeyAlgorithm),
            ...present("publicKey", c.response.publicKey),
        },
    };
}

function authenticationJson(
    c: z.infer<typeof authenticationCredentialSchema>,
): AuthenticationResponseJSON {
    return {
        id: c.id,
        rawId: c.rawId,
        type: c.type,
        clientExtensionResults: c.clientExtensionResults,
        ...present("authenticatorAttachment", c.authenticatorAttachment),
        response: {
            clientDataJSON: c.response.clientDataJSON,
            authenticatorData: c.response.authenticatorData,
            signature: c.response.signature,
            ...present("userHandle", c.response.userHandle),
        },
    };
}

// The library leaves absent options as explicit `undefined`, which JSON drops. Round-tripping gives
// exactly what the browser will receive and what the response schema can check.
const jsonObjectSchema = z.record(z.string(), z.json());
function plainJson(value: object): Record<string, unknown> {
    return jsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}
