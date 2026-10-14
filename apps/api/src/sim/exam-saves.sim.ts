import { createHash } from "node:crypto";
import { assert } from "@aura/contracts/assert";
import {
    type DraftState,
    edit,
    emptyDraft,
    nextToSend,
    onAck,
    onConflict,
    onOver,
} from "@aura/contracts/exam-sync";
import { decideSave, type SaveOutcome } from "../modules/exams/save-rules.ts";
import type { Scenario } from "./runner.ts";
import type { World } from "./world.ts";

// Goal: autosave under a faulty network and clients that restart. One or two tabs of the same candidate edit a
// file and sync with the real client rules (@aura/contracts/exam-sync) against the real server rule
// (decideSave); requests are dropped, duplicated, delayed and reordered, responses are lost, a tab can crash
// (it keeps its saved state, loses nothing else), and the clock runs through the deadline.
// Invariants: (1) a save a tab was told is stored is still stored, with the same content, at every later
// moment: no acknowledged save is lost; (2) nothing is stored at or after the deadline; (3) stored sequence
// numbers only go up; (4) with one tab and a quiet network before the deadline, the server ends up holding
// the tab's latest text.

// Even seeds keep the deadline far away (so a quiet network must get the last text through); odd seeds put it in
// the middle of the run (so saves keep arriving after it and must all be refused).
const DEADLINE_FAR_MS = 15 * 60_000;
const DEADLINE_NEAR_MS = 150_000;
const STEPS = 320;
const DELAY_MS_MAX = 3000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Row {
    seq: number;
    hash: string;
    content: string;
    at: number;
}
interface Message {
    readonly dueMs: number;
    readonly tab: number;
    readonly request?: { seq: number; content: string };
    readonly response?: { sent: { seq: number; content: string }; outcome: SaveOutcome };
}
interface Tab {
    state: DraftState;
}

export function examSavesScenario(): Scenario {
    return {
        name: "exam-saves",
        stepsMax: STEPS,
        start(world) {
            const deadlineMs =
                world.clock.nowUnixMs() +
                (world.seed % 2 === 0 ? DEADLINE_FAR_MS : DEADLINE_NEAR_MS);
            const rows: Row[] = [];
            const promised: { seq: number; hash: string }[] = []; // what some tab was told is stored
            const tabs: Tab[] = Array.from({ length: 1 + world.rng.nextInt(2) }, () => ({
                state: emptyDraft("cpp"),
            }));
            let inFlight: Message[] = [];
            let quiet = false; // no more faults, so a single tab's last edit must arrive
            return {
                step(index) {
                    if (index === Math.floor(STEPS * 0.55)) quiet = true;
                    act(world, tabs, inFlight, quiet, deadlineMs);
                    inFlight = deliver(world, tabs, inFlight, rows, promised, deadlineMs, quiet);
                },
                check() {
                    for (const row of rows)
                        assert(row.at < deadlineMs, "nothing is stored at or after the deadline");
                    for (let i = 1; i < rows.length; i++) {
                        assert(
                            (rows[i]?.seq ?? 0) > (rows[i - 1]?.seq ?? 0),
                            "stored sequence numbers only go up",
                        );
                    }
                    for (const promise of promised) {
                        const row = rows.find((r) => r.seq === promise.seq);
                        assert(
                            row?.hash === promise.hash,
                            `acknowledged save ${promise.seq} is still stored`,
                        );
                    }
                    const single = tabs.length === 1 ? tabs[0] : undefined;
                    if (
                        single !== undefined &&
                        quiet &&
                        world.clock.nowUnixMs() < deadlineMs - 20_000 &&
                        inFlight.length === 0
                    ) {
                        // After a quiet period with nothing in flight, the tab has either sent everything or has more to send.
                        const outstanding = nextToSend(single.state);
                        assert(
                            outstanding === null ||
                                outstanding.seq > (rows[rows.length - 1]?.seq ?? 0),
                            "the server holds what was acknowledged",
                        );
                    }
                },
            };
        },
    };
}

// One random thing: an edit, a send, a crash, or time passing.
function act(
    world: World,
    tabs: Tab[],
    inFlight: Message[],
    quiet: boolean,
    deadlineMs: number,
): void {
    const tabIndex = world.rng.nextInt(tabs.length);
    const tab = tabs[tabIndex];
    assert(tab !== undefined, "a tab exists");
    const roll = world.rng.nextInt(10);
    if (roll < 3) {
        tab.state = edit(tab.state, `text ${world.rng.nextInt(1_000_000)}`);
    } else if (roll < 7) {
        const out = nextToSend(tab.state);
        if (out === null) return;
        const copies = !quiet && world.rng.nextInt(6) === 0 ? 2 : 1; // a duplicated request
        const lost = !quiet && world.rng.nextInt(5) === 0; // a dropped one
        for (let c = 0; c < copies && !lost; c++) {
            inFlight.push({
                dueMs: world.clock.nowUnixMs() + (quiet ? 50 : world.rng.nextInt(DELAY_MS_MAX)),
                tab: tabIndex,
                request: { seq: out.seq, content: out.content },
            });
        }
    } else if (roll === 7) {
        // A crash and restart: the persisted state stays, requests already on the wire still land.
        tab.state = { ...tab.state };
    } else {
        world.clock.advance(world.rng.nextInt(quiet ? 3000 : 20_000));
    }
    if (world.clock.nowUnixMs() > deadlineMs + 60_000) world.clock.advance(0);
}

// Delivers whatever is due, in arrival order (which is not send order).
function deliver(
    world: World,
    tabs: Tab[],
    inFlight: Message[],
    rows: Row[],
    promised: { seq: number; hash: string }[],
    deadlineMs: number,
    quiet: boolean,
): Message[] {
    const now = world.clock.nowUnixMs();
    const due = inFlight.filter((m) => m.dueMs <= now).sort((a, b) => a.dueMs - b.dueMs);
    const rest = inFlight.filter((m) => m.dueMs > now);
    for (const message of due) {
        if (message.request !== undefined) {
            const outcome = serve(message.request, rows, now, deadlineMs);
            const answer = {
                dueMs: now + (quiet ? 50 : world.rng.nextInt(DELAY_MS_MAX)),
                tab: message.tab,
                response: { sent: message.request, outcome },
            };
            if (quiet || world.rng.nextInt(5) !== 0) rest.push(answer); // the response may be lost
            if (outcome.kind === "stored" || outcome.kind === "repeat")
                promised.push({ seq: message.request.seq, hash: sha(message.request.content) });
        } else if (message.response !== undefined) {
            const tab = tabs[message.tab];
            assert(tab !== undefined, "a response goes to a tab");
            tab.state = apply(tab.state, message.response.outcome);
        }
    }
    return rest;
}

function serve(
    request: { seq: number; content: string },
    rows: Row[],
    now: number,
    deadlineMs: number,
): SaveOutcome {
    const last = rows[rows.length - 1];
    const hash = sha(request.content);
    const outcome = decideSave(
        {
            lastSeq: last?.seq ?? 0,
            lastHash: last?.hash ?? null,
            deadlineMs,
            sessionStarted: true,
            savesLastMinute: rows.filter((r) => r.at > now - 60_000).length,
            savesForProblem: rows.length,
        },
        { seq: request.seq, hash, nowMs: now },
    );
    if (outcome.kind === "stored")
        rows.push({ seq: request.seq, hash, content: request.content, at: now });
    return outcome;
}

function apply(state: DraftState, outcome: SaveOutcome): DraftState {
    if (outcome.kind === "stored" || outcome.kind === "repeat")
        return onAck(state, outcome.ackedSeq);
    if (outcome.kind === "conflict") return onConflict(state, outcome.lastSeq);
    if (outcome.kind === "over") return onOver(state);
    return state; // too many: try again later
}
