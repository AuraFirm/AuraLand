import { assert } from "@aura/contracts/assert";
import {
    LOGIN_CODE_ATTEMPTS_MAX,
    LOGIN_CODE_TTL_S,
    LOGIN_LINK_TTL_S,
} from "../modules/identity/limits.ts";
import { hashSecret, type NewChallenge, newChallenge } from "../modules/identity/login.ts";
import { createMemoryChallengeStore } from "./challenge-store.ts";
import type { Scenario } from "./runner.ts";
import type { World } from "./world.ts";

// Goal: drive email sign-in challenges with random starts, right and wrong codes, links, wrong
// browsers, floods of guesses and passing time, and compare every outcome with an independent model
// of the rules. Invariants: a challenge is consumed at most once (by link or by code, never both);
// a code works only before its expiry, only for the right browser and only within five guesses; a
// link works only before its expiry and only for the right browser; guessing never changes another
// challenge; and the store's counters and used-flags always equal the model's.

const KEY = Buffer.alloc(32, 3);
const MS = 1000;
// Jumps just either side of the 10-minute code life and the 15-minute link life.
const ADVANCES_S = [1, 30, 299, 300, 599, 600, 601, 899, 900, 901, 3600];

interface Tracked {
    readonly made: NewChallenge;
    attempts: number;
    consumed: boolean;
}

interface Harness {
    readonly world: World;
    readonly store: ReturnType<typeof createMemoryChallengeStore>;
    readonly tracked: Tracked[];
    lastOperation: string;
}

const now = (h: Harness) => h.world.clock.nowUnixMs();
const pick = (h: Harness) => h.tracked[h.world.rng.nextInt(Math.max(h.tracked.length, 1))];
const bindingOf = (t: Tracked) => hashSecret(KEY, "binding", t.made.binding);
const codeHash = (code: string) => hashSecret(KEY, "code", code);
const STRANGER = hashSecret(KEY, "binding", "a browser that never started this");

// A code that is certainly not the right one for this challenge.
function wrongCode(t: Tracked): string {
    return String((Number(t.made.code) + 1) % 10 ** 8).padStart(8, "0");
}

// Whether a code guess can still be counted for this challenge right now.
function codeLive(h: Harness, t: Tracked): boolean {
    const expires = t.made.record.createdAtMs + LOGIN_CODE_TTL_S * MS;
    return !t.consumed && now(h) < expires && t.attempts < LOGIN_CODE_ATTEMPTS_MAX;
}

async function opStart(h: Harness): Promise<void> {
    const email = `user${h.world.rng.nextInt(5)}@example.com`;
    const made = newChallenge({ clock: h.world.clock, rng: h.world.rng, key: KEY }, email);
    await h.store.insert(made.record);
    h.tracked.push({ made, attempts: 0, consumed: false });
}

async function guess(h: Harness, t: Tracked, code: string): Promise<void> {
    const live = codeLive(h, t);
    const right = code === t.made.code;
    const result = await h.store.tryCode(bindingOf(t), codeHash(code), now(h));
    if (!live) {
        assert(result === null, "a spent, used or expired challenge accepts no guesses");
        return;
    }
    t.attempts++;
    if (right) {
        assert(result?.consumed === true, "the right code consumes a live challenge");
        assert(result.email === t.made.record.email, "the code opens the right email");
        t.consumed = true;
    } else {
        assert(result?.consumed === false, "a wrong code does not consume");
        assert(result.attempts === t.attempts, "every guess is counted exactly once");
    }
}

async function opCodeRight(h: Harness): Promise<void> {
    const t = pick(h);
    if (t !== undefined) await guess(h, t, t.made.code);
}

async function opCodeWrong(h: Harness): Promise<void> {
    const t = pick(h);
    if (t !== undefined) await guess(h, t, wrongCode(t));
}

// More wrong guesses than the limit, then the right code: after the limit nothing opens it.
async function opCodeFlood(h: Harness): Promise<void> {
    const t = pick(h);
    if (t === undefined) return;
    for (let n = 0; n < LOGIN_CODE_ATTEMPTS_MAX + 2; n++) await guess(h, t, wrongCode(t));
    await guess(h, t, t.made.code);
}

async function opLinkRight(h: Harness): Promise<void> {
    const t = pick(h);
    if (t === undefined) return;
    const expires = t.made.record.createdAtMs + LOGIN_LINK_TTL_S * MS;
    const live = !t.consumed && now(h) < expires;
    const result = await h.store.consumeWithLink(
        bindingOf(t),
        hashSecret(KEY, "link", t.made.token),
        now(h),
    );
    if (live) {
        assert(result?.email === t.made.record.email, "a live link signs in the right email, once");
        t.consumed = true;
    } else {
        assert(result === null, "a used or expired link signs in nobody");
    }
}

// Right secrets, wrong browser: always refused, and it must not use up an attempt or the challenge.
async function opWrongBrowser(h: Harness): Promise<void> {
    const t = pick(h);
    if (t === undefined) return;
    const byCode = await h.store.tryCode(STRANGER, codeHash(t.made.code), now(h));
    const byLink = await h.store.consumeWithLink(
        STRANGER,
        hashSecret(KEY, "link", t.made.token),
        now(h),
    );
    assert(
        byCode === null && byLink === null,
        "a different browser can neither guess nor use the link",
    );
}

async function opAdvance(h: Harness): Promise<void> {
    h.world.clock.advance((ADVANCES_S[h.world.rng.nextInt(ADVANCES_S.length)] ?? 1) * MS);
}

const OPERATIONS: ReadonlyArray<{
    name: string;
    weight: number;
    run: (h: Harness) => Promise<void>;
}> = [
    { name: "start", weight: 16, run: opStart },
    { name: "code_right", weight: 14, run: opCodeRight },
    { name: "code_wrong", weight: 24, run: opCodeWrong },
    { name: "code_flood", weight: 5, run: opCodeFlood },
    { name: "link_right", weight: 14, run: opLinkRight },
    { name: "wrong_browser", weight: 7, run: opWrongBrowser },
    { name: "advance", weight: 20, run: opAdvance },
];
const TOTAL_WEIGHT = OPERATIONS.reduce((sum, operation) => sum + operation.weight, 0);

async function stepOnce(h: Harness): Promise<void> {
    let roll = h.world.rng.nextInt(TOTAL_WEIGHT);
    for (const operation of OPERATIONS) {
        if (roll >= operation.weight) {
            roll -= operation.weight;
            continue;
        }
        h.lastOperation = operation.name;
        try {
            await operation.run(h);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`${operation.name}: ${reason}`);
        }
        return;
    }
}

// The store's counters and used-flags must equal the model's for every challenge.
function checkInvariants(h: Harness): void {
    const stored = new Map(h.store.all().map((record) => [record.id, record]));
    for (const t of h.tracked) {
        const record = stored.get(t.made.record.id);
        assert(record !== undefined, "every started challenge is stored");
        const where = `after ${h.lastOperation}`;
        assert(record.codeAttempts === t.attempts, `attempt counts agree ${where}`);
        assert(
            record.codeAttempts <= LOGIN_CODE_ATTEMPTS_MAX,
            `never more than the limit ${where}`,
        );
        assert((record.consumedAtMs !== null) === t.consumed, `used flags agree ${where}`);
        assert(
            (record.consumedBy === null) === !t.consumed,
            `a used challenge names its method ${where}`,
        );
    }
}

export function loginScenario(): Scenario {
    return {
        name: "login",
        stepsMax: 250,
        start(world) {
            const h: Harness = {
                world,
                store: createMemoryChallengeStore(),
                tracked: [],
                lastOperation: "start",
            };
            return { step: () => stepOnce(h), check: () => checkInvariants(h) };
        },
    };
}
