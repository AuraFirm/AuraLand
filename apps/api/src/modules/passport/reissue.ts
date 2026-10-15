import { assert } from "@aura/contracts/assert";
import { CREDENTIAL_JWT_BYTES_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import type { Signer } from "../../platform/signer.ts";

// After a signing key is revoked (a suspected leak), every credential it signed stops verifying. This signs the same
// credential again with the active key (ADR 0033): the payload (id, subject, claims, place in the revocation list,
// dates) is carried over unchanged and only the header's key id and the signature are new. Credentials that were
// themselves revoked are left alone. A batch per call; the next tick takes the rest.

const REISSUE_BATCH = 200;
const row = z.object({ id: z.string(), vc_jwt: z.string() });
const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString("base64url");

export async function reissueRevoked(
    tx: Transaction,
    context: { clock: Clock; signer: Signer; issuerDid: string },
): Promise<number> {
    const rows = (
        await tx`select id, vc_jwt from credentials_needing_reissue(${REISSUE_BATCH})`
    ).map((r) => row.parse(r));
    for (const credential of rows) {
        const payload = credential.vc_jwt.split(".")[1];
        assert(payload !== undefined && payload.length > 0, "a stored credential has a payload");
        const header = {
            alg: "ES256",
            typ: "vc+jwt",
            kid: `${context.issuerDid}#${context.signer.keyId}`,
        };
        const text = `${b64url(JSON.stringify(header))}.${payload}`;
        const jwt = `${text}.${b64url(await context.signer.sign(new TextEncoder().encode(text)))}`;
        assert(
            jwt.length <= CREDENTIAL_JWT_BYTES_MAX,
            "a re-signed credential fits its size limit",
        );
        await tx`select reissue_credential(${credential.id}, ${jwt}, ${context.signer.keyId}, ${new Date(context.clock.nowUnixMs())})`;
    }
    return rows.length;
}
