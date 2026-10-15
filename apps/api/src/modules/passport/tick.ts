import type { Transaction } from "@aura/db/context";
import type { Clock } from "../../platform/clock.ts";
import type { ObjectStorage } from "../../platform/object-storage.ts";
import type { Rng } from "../../platform/rng.ts";
import type { Signer } from "../../platform/signer.ts";
import { issuerDid } from "./documents.ts";
import { issueNextEvent } from "./events.ts";
import { publishPassport } from "./publish.ts";

export interface PassportContext {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly signer: Signer;
    readonly storage: ObjectStorage;
    readonly publicOrigin: string;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}

// Passport's housekeeping (ADR 0033), run by the worker every few seconds: make the signing key known, turn the next
// finished event into credentials, and publish the static documents. Slow on purpose compared with the exam clock:
// credentials are not time-critical, and publishing reads every public credential's digest.
export const PASSPORT_TICK_MS = 10_000;

const environmentOf = (signer: Signer) => signer.environment;

export async function runPassportTick(
    context: PassportContext,
): Promise<{ event: string | null; written: number }> {
    const nowMs = context.clock.nowUnixMs();
    const issuing = {
        clock: context.clock,
        rng: context.rng,
        signer: context.signer,
        issuerDid: issuerDid(context.publicOrigin),
        issuerName:
            environmentOf(context.signer) === "development" ? "AuraLand (development)" : "AuraLand",
        publicOrigin: context.publicOrigin,
    };
    // A development key is new at every start: retire the old one and register this one. A production key is
    // registered by a person (rotation), never here.
    if (context.signer.environment === "development") {
        await context.inTransaction(
            (tx) => tx`select register_development_signing_key(${context.signer.keyId},
                ${tx.json(context.signer.publicJwk())}, ${new Date(nowMs)})`,
        );
    }
    const issued = await context.inTransaction((tx) => issueNextEvent(tx, issuing));
    const written = await context.inTransaction((tx) =>
        publishPassport(tx, {
            clock: context.clock,
            storage: context.storage,
            signer: context.signer,
            issuerDid: issuing.issuerDid,
            publicOrigin: context.publicOrigin,
        }),
    );
    return {
        event: issued === null ? null : `${issued.kind}:${issued.issued}`,
        written: written.length,
    };
}
