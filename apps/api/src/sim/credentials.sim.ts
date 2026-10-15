import { assert } from "@aura/contracts/assert";
import { STATUS_LIST_ENTRIES } from "@aura/contracts/limits";
import type { PublicKey } from "../modules/passport/documents.ts";
import {
    type CredentialRow,
    type IssuingContext,
    type IssuingStore,
    issueWith,
} from "../modules/passport/issuing.ts";
import { encodeStatusList, isRevokedIn, readStatusList } from "../modules/passport/status-list.ts";
import { verifyCredentialJwt } from "../modules/passport/verify.ts";
import { createDevelopmentSigner, type Signer } from "../platform/signer.ts";
import type { Scenario } from "./runner.ts";
import type { World } from "./world.ts";

// Goal: credential issuance under crashes, retries, racing workers, key rotation and revocation. Invariants:
// (1) one credential per (person, kind, event), however many times and however concurrently issuing runs;
// (2) no two credentials share a place in a revocation list;
// (3) after a publish, a bit is set exactly when its credential is revoked;
// (4) at the end, every stored credential verifies with the keys that are published, unless its key was revoked,
//     and then it does not; and what the JWT says (its id, its place in the list) matches the stored row.

const STEPS = 90;
const SUBJECTS = 4;
const EVENTS = 4;
const ORIGIN = "https://passport.example";
const FAULT_ONE_IN = 6;

type Fault = "after_reserve" | "before_insert" | "after_insert" | null;

interface Memory {
    readonly rows: CredentialRow[];
    readonly revokedIds: Set<string>;
    nextSlot: number;
    fault: Fault;
}

class Crash extends Error {}

// The in-memory twin of the PostgreSQL store, with a fault that fires once at a chosen point and yields between
// operations so racing issuers really interleave.
function memoryStore(memory: Memory): IssuingStore {
    const keyOf = (subject: string, kind: string, event: string) => `${subject}|${kind}|${event}`;
    const take = (point: Fault) => {
        if (memory.fault === point) {
            memory.fault = null;
            throw new Crash(point ?? "");
        }
    };
    return {
        async exists(subject, kind, event) {
            await Promise.resolve();
            return memory.rows.some(
                (r) => keyOf(r.subjectUserId, r.kind, r.eventId) === keyOf(subject, kind, event),
            );
        },
        async reserveSlot() {
            await Promise.resolve();
            const n = memory.nextSlot++;
            take("after_reserve");
            return { list: Math.floor(n / STATUS_LIST_ENTRIES), index: n % STATUS_LIST_ENTRIES };
        },
        async insert(row) {
            await Promise.resolve();
            take("before_insert");
            const taken = memory.rows.some(
                (r) =>
                    keyOf(r.subjectUserId, r.kind, r.eventId) ===
                    keyOf(row.subjectUserId, row.kind, row.eventId),
            );
            if (taken) return false;
            memory.rows.push(row);
            take("after_insert");
            return true;
        },
    };
}

interface Published {
    readonly list: Uint8Array;
    readonly revoked: ReadonlySet<string>;
    readonly rowIds: readonly string[];
}

interface State {
    readonly memory: Memory;
    readonly keys: PublicKey[];
    signer: Signer;
    signerCount: number;
    readonly claimed: Set<string>; // events some call reported as issued or existing
    published: Published | null;
    stepsDone: number;
}

export function credentialsScenario(): Scenario {
    return {
        name: "credentials",
        stepsMax: STEPS,
        start(world) {
            const keys: PublicKey[] = [];
            const state: State = {
                memory: { rows: [], revokedIds: new Set(), nextSlot: 0, fault: null },
                keys,
                signer: newSigner(world, keys, 0),
                signerCount: 1,
                claimed: new Set(),
                published: null,
                stepsDone: 0,
            };
            return {
                step: () => act(world, state),
                check: () => checkState(world, state),
            };
        },
    };
}

async function issue(world: World, state: State, subject: number, event: number): Promise<void> {
    const { memory } = state;
    const e = eventOf(subject, event);
    if (world.rng.nextInt(FAULT_ONE_IN) === 0) {
        memory.fault =
            (["after_reserve", "before_insert", "after_insert"] as const)[world.rng.nextInt(3)] ??
            null;
    }
    const context: IssuingContext = {
        clock: world.clock,
        rng: world.rng,
        signer: state.signer,
        issuerDid: "did:web:passport.example",
        issuerName: "AuraLand (simulation)",
        publicOrigin: ORIGIN,
    };
    try {
        await issueWith(memoryStore(memory), context, e);
        state.claimed.add(`${e.subjectUserId}|${e.eventId}`);
    } catch (error) {
        if (!(error instanceof Crash)) throw error; // a crash is expected; anything else is a bug
    } finally {
        memory.fault = null;
    }
}

// One random thing: issue, race two issuers, revoke a credential, rotate the key, revoke a retired key, or publish.
async function act(world: World, state: State): Promise<void> {
    const { memory, keys } = state;
    state.stepsDone++;
    world.clock.advance(1000 * (1 + world.rng.nextInt(60)));
    const roll = world.rng.nextInt(12);
    if (roll < 4) {
        await issue(world, state, world.rng.nextInt(SUBJECTS), world.rng.nextInt(EVENTS));
    } else if (roll === 4) {
        const s = world.rng.nextInt(SUBJECTS);
        const v = world.rng.nextInt(EVENTS);
        await Promise.all([issue(world, state, s, v), issue(world, state, s, v)]); // two workers race
    } else if (roll === 5 && memory.rows.length > 0) {
        memory.revokedIds.add(memory.rows[world.rng.nextInt(memory.rows.length)]?.id ?? "");
    } else if (roll === 6 && state.signerCount < 4) {
        retire(keys, state.signer.keyId);
        state.signer = newSigner(world, keys, state.signerCount++);
    } else if (roll === 7) {
        const old = keys.find((k) => k.status === "retired");
        if (old !== undefined) keys[keys.indexOf(old)] = { ...old, status: "revoked" };
    } else if (roll >= 8) {
        state.published = publish(memory);
    }
}

async function checkState(world: World, state: State): Promise<void> {
    const { memory } = state;
    const people = memory.rows.map((r) => `${r.subjectUserId}|${r.kind}|${r.eventId}`);
    assert(new Set(people).size === people.length, "one credential per person and event");
    const places = memory.rows.map((r) => `${r.statusList}:${r.statusIndex}`);
    assert(new Set(places).size === places.length, "no two credentials share a place in a list");
    for (const key of state.claimed) {
        const [subject, event] = key.split("|");
        assert(
            memory.rows.some((r) => r.subjectUserId === subject && r.eventId === event),
            "an event reported issued has a credential",
        );
    }
    if (state.published !== null) checkPublished(state.published, memory);
    if (state.stepsDone === STEPS) await checkVerifies(memory, state.keys, world.clock.nowUnixMs());
}

const eventOf = (subject: number, event: number) => ({
    subjectUserId: `018f0000-0000-7000-8000-0000000000${String(subject).padStart(2, "0")}`,
    issuerOrgId: "018f0000-0000-7000-8000-0000000000ff",
    eventId: `018f0000-0000-7000-8000-00000000e0${String(event).padStart(2, "0")}`,
    assurance: 0,
    expiresAtMs: null,
    claim: {
        kind: "contest_rank" as const,
        event_title: `Event ${event}`,
        host_name: "Sim",
        rank: 1,
        participants: 2,
        solved: 1,
        finalized_at: "2026-10-01T00:00:00.000Z",
    },
});

function newSigner(world: World, keys: PublicKey[], n: number): Signer {
    const signer = createDevelopmentSigner({
        keyId: `sim-${world.seed}-${n}`,
        appEnvironment: "test",
    });
    keys.push({ kid: signer.keyId, alg: signer.alg, status: "active", jwk: signer.publicJwk() });
    return signer;
}

function retire(keys: PublicKey[], kid: string): void {
    const at = keys.findIndex((k) => k.kid === kid);
    const key = keys[at];
    if (key !== undefined) keys[at] = { ...key, status: "retired" };
}

// What the worker's publish step does: the list from the revoked set of this moment.
function publish(memory: Memory): Published {
    const revoked = memory.rows
        .filter((r) => memory.revokedIds.has(r.id) && r.statusList === 0)
        .map((r) => r.statusIndex);
    const bits = readStatusList(encodeStatusList(revoked));
    assert(bits !== null, "the list this module wrote can be read");
    return {
        list: bits,
        revoked: new Set(memory.revokedIds),
        rowIds: memory.rows.map((r) => r.id),
    };
}

function checkPublished(published: Published, memory: Memory): void {
    for (const row of memory.rows) {
        if (!published.rowIds.includes(row.id) || row.statusList !== 0) continue;
        assert(
            isRevokedIn(published.list, row.statusIndex) === published.revoked.has(row.id),
            "a bit is set exactly when its credential is revoked",
        );
    }
}

async function checkVerifies(
    memory: Memory,
    keys: readonly PublicKey[],
    nowMs: number,
): Promise<void> {
    for (const row of memory.rows) {
        const result = await verifyCredentialJwt(row.jwt, keys, nowMs);
        const key = keys.find((k) => k.kid === row.keyId);
        if (key?.status === "revoked") {
            assert(
                result.outcome === "invalid",
                "a credential signed by a revoked key does not verify",
            );
            continue;
        }
        assert(
            result.outcome === "valid",
            `a credential verifies with the published keys (${result.outcome === "invalid" ? result.reason : result.outcome})`,
        );
        assert(result.credentialId === row.id, "the signed id is the stored id");
        assert(
            result.status.index === row.statusIndex,
            "the signed place in the list is the stored place",
        );
    }
}
