import { assert } from "@aura/contracts/assert";
import type { CredentialClaim } from "@aura/contracts/credentials";
import { makeUuidV7 } from "@aura/contracts/ids";
import { CREDENTIAL_JWT_BYTES_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import type { Rng } from "../../platform/rng.ts";
import type { Signer } from "../../platform/signer.ts";
import { issueCredentialJwt } from "./issue.ts";

export interface IssuingContext {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly signer: Signer;
    readonly issuerDid: string;
    readonly issuerName: string;
    readonly publicOrigin: string;
}

export interface Event {
    readonly subjectUserId: string;
    readonly issuerOrgId: string;
    readonly eventId: string;
    readonly claim: CredentialClaim;
    readonly assurance: number;
    readonly expiresAtMs: number | null;
}

const slot = z.object({ status_list: z.number().int(), status_index: z.number().int() });

// Turns one event into one credential, once. A person who already has the credential for this event gets nothing
// new (and no revocation place is spent); a crash between the steps leaves nothing half-recorded because the row is
// written last, in one statement, and repeating the whole thing is safe.
export async function issueOnce(
    tx: Transaction,
    context: IssuingContext,
    event: Event,
): Promise<"issued" | "exists"> {
    const kind = event.claim.kind;
    const existing = await tx`select 1 as one from credentials
        where subject_user_id = ${event.subjectUserId} and kind = ${kind} and event_id = ${event.eventId}`;
    if (existing.length > 0) return "exists";
    const [row] = await tx`select * from reserve_credential_status_slot()`;
    const place = slot.parse(row);
    const nowMs = context.clock.nowUnixMs();
    const id = makeUuidV7(nowMs, context.rng.nextBytes(10));
    const listUrl = `${context.publicOrigin}/passport/status/${place.status_list}.json`;
    const jwt = await issueCredentialJwt(context.signer, {
        id,
        subject: makeUuidV7(nowMs, context.rng.nextBytes(10)),
        issuerDid: context.issuerDid,
        issuerName: context.issuerName,
        claim: event.claim,
        assurance: event.assurance,
        eventId: event.eventId,
        issuedAtMs: nowMs,
        expiresAtMs: event.expiresAtMs,
        status: { listUrl, index: place.status_index },
    });
    assert(jwt.length <= CREDENTIAL_JWT_BYTES_MAX, "a credential fits its size limit");
    const [inserted] =
        await tx`select insert_credential(${id}, ${event.subjectUserId}, ${event.issuerOrgId},
        ${kind}, ${event.eventId}, ${event.assurance}, ${tx.json(event.claim)}, ${jwt}, ${context.signer.keyId},
        ${place.status_list}, ${place.status_index}, ${new Date(nowMs)},
        ${event.expiresAtMs === null ? null : new Date(event.expiresAtMs)}) as inserted`;
    return z.object({ inserted: z.boolean() }).parse(inserted).inserted ? "issued" : "exists";
}
