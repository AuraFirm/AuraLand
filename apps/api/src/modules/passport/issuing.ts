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

export interface CredentialRow {
    readonly id: string;
    readonly subjectUserId: string;
    readonly issuerOrgId: string;
    readonly kind: string;
    readonly eventId: string;
    readonly assurance: number;
    readonly claim: CredentialClaim;
    readonly jwt: string;
    readonly keyId: string;
    readonly statusList: number;
    readonly statusIndex: number;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number | null;
}

// What issuing needs from storage. PostgreSQL implements it for real; a simulation implements it in memory with
// faults, so the protocol (not the SQL) is what the simulation exercises.
export interface IssuingStore {
    exists(subjectUserId: string, kind: string, eventId: string): Promise<boolean>;
    reserveSlot(): Promise<{ readonly list: number; readonly index: number }>;
    // False when a credential for this (person, kind, event) is already recorded: the unique constraint decides.
    insert(row: CredentialRow): Promise<boolean>;
}

export function postgresIssuingStore(tx: Transaction): IssuingStore {
    return {
        async exists(subjectUserId, kind, eventId) {
            const found = await tx`select 1 as one from credentials
                where subject_user_id = ${subjectUserId} and kind = ${kind} and event_id = ${eventId}`;
            return found.length > 0;
        },
        async reserveSlot() {
            const [row] = await tx`select * from reserve_credential_status_slot()`;
            const place = slot.parse(row);
            return { list: place.status_list, index: place.status_index };
        },
        async insert(row) {
            const [inserted] =
                await tx`select insert_credential(${row.id}, ${row.subjectUserId}, ${row.issuerOrgId},
                ${row.kind}, ${row.eventId}, ${row.assurance}, ${tx.json(row.claim)}, ${row.jwt}, ${row.keyId},
                ${row.statusList}, ${row.statusIndex}, ${new Date(row.issuedAtMs)},
                ${row.expiresAtMs === null ? null : new Date(row.expiresAtMs)}) as inserted`;
            return z.object({ inserted: z.boolean() }).parse(inserted).inserted;
        },
    };
}

// Turns one event into one credential, once. A person who already has the credential for this event gets nothing
// new (and no revocation place is spent); a crash between the steps leaves nothing half-recorded because the row is
// written last, in one statement, and repeating the whole thing is safe. Two workers racing on the same event both
// sign, and the store lets exactly one record.
export async function issueWith(
    store: IssuingStore,
    context: IssuingContext,
    event: Event,
): Promise<"issued" | "exists"> {
    const kind = event.claim.kind;
    if (await store.exists(event.subjectUserId, kind, event.eventId)) return "exists";
    const place = await store.reserveSlot();
    const nowMs = context.clock.nowUnixMs();
    const id = makeUuidV7(nowMs, context.rng.nextBytes(10));
    const listUrl = `${context.publicOrigin}/api/public/status-lists/${place.list}`;
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
        status: { listUrl, index: place.index },
    });
    assert(jwt.length <= CREDENTIAL_JWT_BYTES_MAX, "a credential fits its size limit");
    const inserted = await store.insert({
        id,
        subjectUserId: event.subjectUserId,
        issuerOrgId: event.issuerOrgId,
        kind,
        eventId: event.eventId,
        assurance: event.assurance,
        claim: event.claim,
        jwt,
        keyId: context.signer.keyId,
        statusList: place.list,
        statusIndex: place.index,
        issuedAtMs: nowMs,
        expiresAtMs: event.expiresAtMs,
    });
    return inserted ? "issued" : "exists";
}

export const issueOnce = (tx: Transaction, context: IssuingContext, event: Event) =>
    issueWith(postgresIssuingStore(tx), context, event);
