import type { Transaction } from "@aura/db/context";
import { hasFreshStepUp } from "./authorize.ts";
import { listOwnPasskeys } from "./passkey-queries.ts";

// Actions that change or end how a person is signed in (ASVS V7.5.1 and V7.5.2) ask for a fresh
// passkey check from anyone who holds a passkey. Someone with no passkey has nothing stronger to
// show, so they are not blocked. Runs in the request transaction as `aura_app`.
export async function needsStepUp(
    tx: Transaction,
    stepUpAtMs: number | null,
    nowMs: number,
): Promise<boolean> {
    if (hasFreshStepUp(stepUpAtMs, nowMs)) return false;
    return (await listOwnPasskeys(tx)).length > 0;
}
