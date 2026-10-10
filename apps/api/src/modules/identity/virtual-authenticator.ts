import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

// A software passkey for tests: it does what a phone or security key does (makes a key pair, signs
// challenges, counts uses) and speaks the same JSON the browser library sends. Test code can make it
// misbehave on purpose (wrong origin, no user verification, a counter that goes backwards).

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

const MAJOR_UNSIGNED = 0;
const MAJOR_NEGATIVE = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_MAP = 5;

function header(major: number, value: number): Buffer {
    if (value < 24) return Buffer.from([(major << 5) | value]);
    if (value < 256) return Buffer.from([(major << 5) | 24, value]);
    const wide = Buffer.alloc(3);
    wide[0] = (major << 5) | 25;
    wide.writeUInt16BE(value, 1);
    return wide;
}

// Just enough CBOR for an attestation object and a COSE key: small integers, text and bytes.
type Scalar = number | string | Uint8Array;

function encodeScalar(value: Scalar): Buffer {
    if (typeof value === "number") {
        return value >= 0 ? header(MAJOR_UNSIGNED, value) : header(MAJOR_NEGATIVE, -1 - value);
    }
    if (typeof value === "string") {
        const text = Buffer.from(value);
        return Buffer.concat([header(MAJOR_TEXT, text.length), text]);
    }
    return Buffer.concat([header(MAJOR_BYTES, value.length), Buffer.from(value)]);
}

function encodeMap(entries: ReadonlyArray<readonly [Scalar, Scalar]>): Buffer {
    const parts = [header(MAJOR_MAP, entries.length)];
    for (const [key, value] of entries) parts.push(encodeScalar(key), encodeScalar(value));
    return Buffer.concat(parts);
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();
const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64url");

export interface Behavior {
    readonly origin?: string;
    readonly rpId?: string;
    readonly userVerified?: boolean;
    // The counter value to report instead of the next one.
    readonly counter?: number;
    // A user handle to report instead of the one given at registration; null reports none.
    readonly userHandle?: string | null;
    readonly challenge?: string;
}

export interface VirtualAuthenticator {
    readonly credentialId: string;
    register(options: Record<string, unknown>, behavior?: Behavior): Record<string, unknown>;
    assert(options: Record<string, unknown>, behavior?: Behavior): Record<string, unknown>;
}

interface Defaults {
    readonly origin: string;
    readonly rpId: string;
}

function clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

function authenticatorData(
    rpId: string,
    flags: number,
    count: number,
    attested: Buffer | null,
): Buffer {
    const fixed = Buffer.alloc(37);
    sha256(Buffer.from(rpId)).copy(fixed, 0);
    fixed[32] = flags;
    fixed.writeUInt32BE(count, 33);
    return attested === null ? fixed : Buffer.concat([fixed, attested]);
}

function flagsFor(behavior: Behavior, extra: number): number {
    const verified = behavior.userVerified === false ? 0 : FLAG_USER_VERIFIED;
    return FLAG_USER_PRESENT | FLAG_BACKUP_ELIGIBLE | verified | extra;
}

function coseKey(publicKey: KeyObject): Buffer {
    const jwk = publicKey.export({ format: "jwk" });
    return encodeMap([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]);
}

function userIdOf(options: Record<string, unknown>): string {
    const user = options["user"];
    if (typeof user === "object" && user !== null && "id" in user && typeof user.id === "string") {
        return user.id;
    }
    throw new Error("registration options carry no user id");
}

function challengeOf(options: Record<string, unknown>, behavior: Behavior): string {
    return behavior.challenge ?? String(options["challenge"]);
}

interface Identity {
    readonly privateKey: KeyObject;
    readonly publicKey: KeyObject;
    readonly credentialId: Buffer;
}

function attestedCredential(identity: Identity): Buffer {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(identity.credentialId.length);
    return Buffer.concat([
        Buffer.alloc(16),
        length,
        identity.credentialId,
        coseKey(identity.publicKey),
    ]);
}

function registrationResponse(
    identity: Identity,
    defaults: Defaults,
    options: Record<string, unknown>,
    behavior: Behavior,
): Record<string, unknown> {
    const rpId = behavior.rpId ?? defaults.rpId;
    const flags = flagsFor(behavior, FLAG_ATTESTED_CREDENTIAL);
    const data = authenticatorData(rpId, flags, 0, attestedCredential(identity));
    const object = Buffer.concat([
        header(MAJOR_MAP, 3),
        encodeScalar("fmt"),
        encodeScalar("none"),
        encodeScalar("attStmt"),
        header(MAJOR_MAP, 0),
        encodeScalar("authData"),
        encodeScalar(data),
    ]);
    const origin = behavior.origin ?? defaults.origin;
    const client = clientData("webauthn.create", challengeOf(options, behavior), origin);
    return {
        id: b64(identity.credentialId),
        rawId: b64(identity.credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
            clientDataJSON: b64(client),
            attestationObject: b64(object),
            transports: ["internal"],
        },
    };
}

function assertionResponse(
    identity: Identity,
    defaults: Defaults,
    options: Record<string, unknown>,
    behavior: Behavior,
    state: { readonly counter: number; readonly userHandle: string | null },
): Record<string, unknown> {
    const rpId = behavior.rpId ?? defaults.rpId;
    const data = authenticatorData(rpId, flagsFor(behavior, 0), state.counter, null);
    const origin = behavior.origin ?? defaults.origin;
    const client = clientData("webauthn.get", challengeOf(options, behavior), origin);
    const signature = sign("sha256", Buffer.concat([data, sha256(client)]), identity.privateKey);
    const handle = behavior.userHandle === undefined ? state.userHandle : behavior.userHandle;
    return {
        id: b64(identity.credentialId),
        rawId: b64(identity.credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
            clientDataJSON: b64(client),
            authenticatorData: b64(data),
            signature: b64(signature),
            ...(handle === null ? {} : { userHandle: handle }),
        },
    };
}

export function createVirtualAuthenticator(defaults: Defaults): VirtualAuthenticator {
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const identity: Identity = { ...keys, credentialId: randomBytes(32) };
    let counter = 0;
    let userHandle: string | null = null;
    return {
        credentialId: b64(identity.credentialId),
        register(options, behavior = {}) {
            userHandle = userIdOf(options);
            return registrationResponse(identity, defaults, options, behavior);
        },
        assert(options, behavior = {}) {
            counter = behavior.counter ?? counter + 1;
            return assertionResponse(identity, defaults, options, behavior, {
                counter,
                userHandle,
            });
        },
    };
}
