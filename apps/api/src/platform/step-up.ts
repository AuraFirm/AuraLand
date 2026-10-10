// How recently a passkey check must have happened to count as a fresh second factor (ADR 0018).
// Shared by every module that guards a powerful action, so the window is defined once.
export const STEP_UP_FRESH_S = 15 * 60;

// A privileged action needs a passkey check within the last STEP_UP_FRESH_S seconds. A sign-in with
// a passkey counts, as does a step-up, as does registering a new passkey.
export function hasFreshStepUp(stepUpAtMs: number | null, nowMs: number): boolean {
    return stepUpAtMs !== null && nowMs - stepUpAtMs < STEP_UP_FRESH_S * 1000;
}
