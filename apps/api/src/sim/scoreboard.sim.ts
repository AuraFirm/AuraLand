import { scoreboardBodySchema } from "@aura/contracts/api/scoreboard";
import { assert } from "@aura/contracts/assert";
import type { ScoreboardInput } from "../modules/contests/scoreboard-body.ts";
import {
    refreshScoreboards,
    type ScoreboardPort,
    type StoredBoards,
} from "../modules/contests/scoreboard-tick.ts";
import type { Scenario } from "./runner.ts";
import type { World } from "./world.ts";

// Goal: the scoreboard tick under random judging. Submissions are judged in any order, rejudged,
// and ticks come at random moments. Invariants: after a tick the stored board equals an independent
// naive ICPC calculation over the whole log (so the pipeline, the fold and the shaping agree with a
// plain reading of the rules); a tick that finds nothing new writes nothing; a version rises by exactly
// one when (and only when) the etag changes; the log delivered to the fold in a different order gives
// the same board.

const MIN = 60_000;
const START = 1_000_000;
const DURATION_MIN = 300;
const PEOPLE = 6;
const LABELS = ["A", "B", "C"] as const;
const VERDICTS = ["AC", "WA", "TLE", "CE", "RTE", "SE"] as const;
const PENALTY = 20;
const FREEZE_MIN = 240;

interface Entry {
    user: number;
    label: string;
    atMin: number;
    verdict: (typeof VERDICTS)[number] | null; // null: not judged yet
}

interface Stored {
    version: number;
    publicEtag: string;
    finalEtag: string;
    stamp: string;
    publicBody: unknown;
    finalBody: unknown;
}

export function scoreboardScenario(): Scenario {
    return {
        name: "scoreboard",
        stepsMax: 120,
        start(world) {
            const log: Entry[] = [];
            let changes = 0; // the database's stamp: moves with every judged change
            let stored: Stored | null = null;
            let writes = 0;
            const port = createPort(world, log, () => changes, {
                get: () => stored,
                set: (next) => {
                    stored = next;
                    writes++;
                },
            });
            return {
                async step() {
                    const roll = world.rng.nextInt(10);
                    if (roll < 4) {
                        log.push({
                            user: world.rng.nextInt(PEOPLE),
                            label: LABELS[world.rng.nextInt(LABELS.length)] ?? "A",
                            atMin: world.rng.nextInt(DURATION_MIN),
                            verdict: null,
                        });
                    } else if (roll < 8) {
                        const entry = log[world.rng.nextInt(Math.max(log.length, 1))];
                        if (entry === undefined) return;
                        // Judging, or a rejudge that changes an earlier verdict.
                        entry.verdict = VERDICTS[world.rng.nextInt(VERDICTS.length)] ?? "WA";
                        changes++;
                    } else {
                        await tickAndCheck(
                            world,
                            log,
                            port,
                            () => stored,
                            () => writes,
                        );
                    }
                },
                async check() {
                    if (stored !== null)
                        assert(stored.version >= 1, "a stored board has a version");
                },
            };
        },
    };
}

async function tickAndCheck(
    world: World,
    log: Entry[],
    port: ScoreboardPort,
    read: () => Stored | null,
    writes: () => number,
): Promise<void> {
    const before = read();
    const writesBefore = writes();
    const changed = await refreshScoreboards(port, world.clock);
    const after = read();
    assert(after !== null, "a live contest has a board after a tick");
    expectSame(after.finalBody, naiveFinal(log), "the final board equals the naive reading");
    if (before !== null && before.stamp === after.stamp && writes() === writesBefore) {
        assert(changed === 0, "an untouched contest reports no change");
    }
    if (before === null) assert(after.version === 1, "the first board is version 1");
    else {
        const moved =
            before.publicEtag !== after.publicEtag || before.finalEtag !== after.finalEtag;
        assert(
            after.version === before.version + (moved ? 1 : 0),
            "version moves iff an etag moved",
        );
        assert(moved === (changed === 1), "the tick reports exactly the etag changes");
    }
    const again = await refreshScoreboards(port, world.clock);
    assert(again === 0, "a second tick with nothing new changes nothing");
}

function createPort(
    world: World,
    log: Entry[],
    stampOf: () => number,
    box: { get(): Stored | null; set(next: Stored): void },
): ScoreboardPort {
    const stampText = () => `running:${stampOf()}`;
    return {
        async work() {
            return box.get()?.stamp === stampText() ? [] : ["c1"];
        },
        async input() {
            return inputOf(world, log, stampText());
        },
        async store(_id: string, boards: StoredBoards) {
            const old = box.get();
            const { rendered } = boards;
            const moved =
                old === null ||
                old.publicEtag !== rendered.publicEtag ||
                old.finalEtag !== rendered.finalEtag;
            box.set({
                version: old === null ? 1 : old.version + (moved ? 1 : 0),
                publicEtag: rendered.publicEtag,
                finalEtag: rendered.finalEtag,
                stamp: boards.stamp,
                publicBody: moved || old === null ? rendered.publicBody : old.publicBody,
                finalBody: moved || old === null ? rendered.finalBody : old.finalBody,
            });
            return moved;
        },
    };
}

// The judged log in a random order, as Postgres is free to return a set of rows.
function inputOf(world: World, log: Entry[], stamp: string): ScoreboardInput {
    const judged = log.flatMap((e) =>
        e.verdict === null
            ? []
            : [
                  {
                      user_id: `u${e.user}`,
                      label: e.label,
                      submitted_at_ms: START + e.atMin * MIN,
                      verdict: e.verdict,
                      score: null,
                  },
              ],
    );
    for (let i = judged.length - 1; i > 0; i--) {
        const j = world.rng.nextInt(i + 1);
        const held = judged[i];
        const other = judged[j];
        assert(held !== undefined && other !== undefined, "indexes inside the list");
        judged[i] = other;
        judged[j] = held;
    }
    return {
        contest_id: "c1",
        org_id: "o1",
        format: "icpc",
        penalty_minutes_per_wrong: PENALTY,
        starts_at_ms: START,
        ends_at_ms: START + DURATION_MIN * MIN,
        freeze_at_ms: START + FREEZE_MIN * MIN,
        stamp,
        problems: LABELS.map((label) => ({ label, points: 100 })),
        registrants: Array.from({ length: PEOPLE }, (_, i) => ({
            user_id: `u${i}`,
            order: i,
            handle: null,
            display_name: null,
        })),
        events: judged,
    };
}

// A plain reading of the ICPC rules, written differently from the fold: per person, per problem, walk the
// submissions in time order. The expected final board as [participant, solved, penalty] by rank.
function naiveFinal(log: Entry[]): number[][] {
    const rows = Array.from({ length: PEOPLE }, (_, user) => {
        let solved = 0;
        let penalty = 0;
        let lastAccept = -1;
        for (const label of LABELS) {
            const mine = log
                .filter((e) => e.user === user && e.label === label && e.verdict !== null)
                .sort(
                    (a, b) =>
                        a.atMin - b.atMin ||
                        Number(b.verdict === "AC") - Number(a.verdict === "AC"),
                );
            // At one instant the accept comes first: a rejected run at the very moment of the accept is
            // not "before" it, the only rule that does not depend on which was logged first.
            let wrong = 0;
            for (const e of mine) {
                if (e.verdict === "CE" || e.verdict === "SE") continue;
                if (e.verdict === "AC") {
                    solved++;
                    penalty += e.atMin + wrong * PENALTY;
                    lastAccept = Math.max(lastAccept, e.atMin);
                    break;
                }
                wrong++;
            }
        }
        return { user, solved, penalty, lastAccept };
    });
    rows.sort(
        (a, b) =>
            b.solved - a.solved ||
            a.penalty - b.penalty ||
            (a.lastAccept < 0 ? Number.POSITIVE_INFINITY : a.lastAccept) -
                (b.lastAccept < 0 ? Number.POSITIVE_INFINITY : b.lastAccept) ||
            a.user - b.user,
    );
    return rows.map((r) => [r.user + 1, r.solved, r.penalty]);
}

function expectSame(body: unknown, expected: number[][], message: string): void {
    const parsed = renderedRows(body);
    assert(
        JSON.stringify(parsed) === JSON.stringify(expected),
        `${message}: ${JSON.stringify(parsed)} vs ${JSON.stringify(expected)}`,
    );
}

function renderedRows(body: unknown): number[][] {
    return scoreboardBodySchema
        .parse(body)
        .rows.map((r) => [r.participant, r.solved, r.penalty_minutes]);
}
