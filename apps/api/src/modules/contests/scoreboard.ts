import { assert } from "@aura/contracts/assert";
import type { Verdict } from "@aura/contracts/judging";

// The scoreboard as a pure fold (Stage 5, ADR 0031 decision 6). No I/O: the tick (slice 5) reads judged
// submissions and hands them here, so the same code serves the live board, the snapshot, the rating job
// and the tests.
//
// Order independence is the design constraint. Judging finishes out of order (a later submission can be
// judged before an earlier one) and a rejudge can change old verdicts, so a cell keeps only facts that
// do not depend on arrival order: the earliest accepted instant and the rejected instants before it
// (ICPC), or the best score and the earliest instant it was reached (IOI). Folding the events in any
// order, or in any number of chunks, therefore gives the same board; a test checks exactly that.

const MS_PER_MINUTE = 60_000;
// IOI scores are percentages of a problem's points with three decimals; integers keep sums exact.
const SCORE_MILLI_PER_PERCENT = 1000;
const PERCENT_MAX = 100;

export interface ScoreboardProblem {
    readonly label: string;
    readonly points: number;
}

export interface ScoreboardConfig {
    readonly rules:
        | { readonly format: "icpc"; readonly penaltyMinutesPerWrong: number }
        | { readonly format: "ioi" };
    readonly startsAtMs: number;
    readonly endsAtMs: number;
    readonly freezeAtMs: number | null;
    readonly problems: readonly ScoreboardProblem[];
    // Registration order (0-based, unique) is the last tie-break, so ranks are total.
    readonly registrants: readonly { readonly userId: string; readonly order: number }[];
}

// A judged submission. Pending and system-error results are the caller's to withhold or pass: SE is
// never the contestant's fault and is ignored here either way.
export interface ScoreboardEvent {
    readonly userId: string;
    readonly label: string;
    readonly submittedAtMs: number;
    readonly verdict: Verdict;
    readonly score: number | null;
}

interface Cell {
    acceptedAtMs: number | null; // ICPC: earliest accepted instant
    rejectedAtMs: number[]; // ICPC: rejected instants, kept only while they could precede an accept
    bestPointsMilli: number; // IOI
    bestAtMs: number | null; // IOI: earliest instant the best was reached
}

type Cells = Map<string, Cell>;

export interface Board {
    readonly config: ScoreboardConfig;
    readonly pointsByLabel: ReadonlyMap<string, number>;
    readonly orderByUser: ReadonlyMap<string, number>;
    // What everyone sees (stops at the freeze) and the final truth (everything).
    readonly publicCells: Cells;
    readonly finalCells: Cells;
    // Judged submissions at or after the freeze, per user and label, shown as "n hidden" while frozen.
    readonly hiddenCounts: Map<string, number>;
}

export interface CellStanding {
    readonly label: string;
    readonly attempts: number; // ICPC: rejected before the accept (or all rejected if unsolved)
    readonly solved: boolean; // ICPC: accepted; IOI: any points
    readonly minutes: number | null; // ICPC: minutes to the accept
    readonly points: number; // IOI: points earned on this problem
    readonly hidden: number; // judged submissions after the freeze (public view only)
}

export interface Standing {
    readonly rank: number;
    readonly userId: string;
    readonly solved: number; // ICPC solved count; IOI number of problems with points
    readonly penaltyMinutes: number; // ICPC only, else 0
    readonly points: number; // IOI total, else 0
    readonly lastChangeAtMs: number | null; // last accept (ICPC) or last improvement (IOI)
    readonly cells: readonly CellStanding[];
}

export type BoardView = "public" | "final";

export function createBoard(config: ScoreboardConfig): Board {
    assert(config.endsAtMs > config.startsAtMs, "a contest ends after it starts");
    assert(
        config.freezeAtMs === null ||
            (config.freezeAtMs > config.startsAtMs && config.freezeAtMs < config.endsAtMs),
        "the freeze falls inside the contest",
    );
    const pointsByLabel = new Map(config.problems.map((p) => [p.label, p.points]));
    assert(pointsByLabel.size === config.problems.length, "problem labels are unique");
    const orderByUser = new Map(config.registrants.map((r) => [r.userId, r.order]));
    assert(orderByUser.size === config.registrants.length, "each person registers once");
    assert(
        new Set(orderByUser.values()).size === orderByUser.size,
        "registration order is unique, so ranks are total",
    );
    return {
        config,
        pointsByLabel,
        orderByUser,
        publicCells: new Map(),
        finalCells: new Map(),
        hiddenCounts: new Map(),
    };
}

const keyOf = (userId: string, label: string) => `${userId}\u0000${label}`;

const emptyCell = (): Cell => ({
    acceptedAtMs: null,
    rejectedAtMs: [],
    bestPointsMilli: 0,
    bestAtMs: null,
});

// Adds one judged submission. Mutates the board it is given: the board is the fold's accumulator and
// is never shared. Calling it twice with the same event is a caller bug (rejudges rebuild the board).
export function addEvent(board: Board, event: ScoreboardEvent): void {
    const points = board.pointsByLabel.get(event.label);
    assert(points !== undefined, "a submission names a problem of the contest");
    assert(board.orderByUser.has(event.userId), "only registered people have scored submissions");
    const { startsAtMs, endsAtMs, freezeAtMs } = board.config;
    assert(
        event.submittedAtMs >= startsAtMs && event.submittedAtMs < endsAtMs,
        "a contest submission falls inside the contest window",
    );
    if (event.verdict === "SE") return; // never the contestant's fault
    addToCells(board, board.finalCells, event, points);
    if (freezeAtMs === null || event.submittedAtMs < freezeAtMs) {
        addToCells(board, board.publicCells, event, points);
        return;
    }
    const key = keyOf(event.userId, event.label);
    board.hiddenCounts.set(key, (board.hiddenCounts.get(key) ?? 0) + 1);
}

function addToCells(board: Board, cells: Cells, event: ScoreboardEvent, points: number): void {
    const key = keyOf(event.userId, event.label);
    let cell = cells.get(key);
    if (cell === undefined) {
        cell = emptyCell();
        cells.set(key, cell);
    }
    if (board.config.rules.format === "icpc") addIcpc(cell, event);
    else addIoi(cell, event, points);
}

function addIcpc(cell: Cell, event: ScoreboardEvent): void {
    if (event.verdict === "CE") return; // a compile error costs nothing
    if (event.verdict === "AC") {
        if (cell.acceptedAtMs === null || event.submittedAtMs < cell.acceptedAtMs) {
            cell.acceptedAtMs = event.submittedAtMs;
            // Rejections after the earliest accept no longer count; dropping them bounds the list.
            cell.rejectedAtMs = cell.rejectedAtMs.filter((at) => at < event.submittedAtMs);
        }
        return;
    }
    // A rejected run at the very instant of the accept does not count against it: with no order between
    // them, the rule that does not depend on which was judged first is that only earlier runs count.
    const accept = cell.acceptedAtMs;
    if (accept === null || event.submittedAtMs < accept)
        cell.rejectedAtMs.push(event.submittedAtMs);
}

function addIoi(cell: Cell, event: ScoreboardEvent, points: number): void {
    if (event.verdict === "CE") return;
    const percent = event.score ?? (event.verdict === "AC" ? PERCENT_MAX : 0);
    assert(percent >= 0 && percent <= PERCENT_MAX, "a score is a percentage");
    const milli = Math.round(
        (points * Math.round(percent * SCORE_MILLI_PER_PERCENT)) / PERCENT_MAX,
    );
    if (milli === 0) return;
    const better = milli > cell.bestPointsMilli;
    const earlierTie =
        milli === cell.bestPointsMilli &&
        cell.bestAtMs !== null &&
        event.submittedAtMs < cell.bestAtMs;
    if (better || earlierTie) {
        cell.bestPointsMilli = milli;
        cell.bestAtMs = event.submittedAtMs;
    }
}

// The ranked rows for a view. Ranks are 1-based and total: every tie is broken, finally by registration.
export function standings(board: Board, view: BoardView): Standing[] {
    const cells = view === "final" ? board.finalCells : board.publicCells;
    const rows = board.config.registrants.map((r) => rowFor(board, cells, r.userId, view));
    rows.sort((a, b) => compareRows(board, a, b));
    const ranked = rows.map((row, index) => ({ ...row, rank: index + 1 }));
    assert(ranked.length === board.config.registrants.length, "every registrant has a row");
    return ranked;
}

type Row = Omit<Standing, "rank">;

function rowFor(board: Board, cells: Cells, userId: string, view: BoardView): Row {
    const icpc = board.config.rules.format === "icpc";
    const penaltyPerWrong =
        board.config.rules.format === "icpc" ? board.config.rules.penaltyMinutesPerWrong : 0;
    let solved = 0;
    let penaltyMinutes = 0;
    let pointsMilli = 0;
    let lastChangeAtMs: number | null = null;
    const standingCells: CellStanding[] = [];
    for (const { label } of board.config.problems) {
        const key = keyOf(userId, label);
        const cell = cells.get(key) ?? emptyCell();
        const hidden = view === "public" ? (board.hiddenCounts.get(key) ?? 0) : 0;
        const at = icpc ? cell.acceptedAtMs : cell.bestAtMs;
        const done = icpc ? cell.acceptedAtMs !== null : cell.bestPointsMilli > 0;
        const minutes =
            icpc && cell.acceptedAtMs !== null
                ? Math.floor((cell.acceptedAtMs - board.config.startsAtMs) / MS_PER_MINUTE)
                : null;
        if (done) solved++;
        if (at !== null && (lastChangeAtMs === null || at > lastChangeAtMs)) lastChangeAtMs = at;
        if (minutes !== null)
            penaltyMinutes += minutes + cell.rejectedAtMs.length * penaltyPerWrong;
        pointsMilli += cell.bestPointsMilli;
        standingCells.push({
            label,
            attempts: cell.rejectedAtMs.length,
            solved: done,
            minutes,
            points: cell.bestPointsMilli / SCORE_MILLI_PER_PERCENT,
            hidden,
        });
    }
    return {
        userId,
        solved,
        penaltyMinutes,
        points: pointsMilli / SCORE_MILLI_PER_PERCENT,
        lastChangeAtMs,
        cells: standingCells,
    };
}

// ICPC: solved desc, penalty asc, last accept asc. IOI: points desc, last improvement asc. Then the
// registration order. A person with nothing sorts after everyone with something, by registration.
function compareRows(board: Board, a: Row, b: Row): number {
    if (board.config.rules.format === "icpc") {
        if (a.solved !== b.solved) return b.solved - a.solved;
        if (a.penaltyMinutes !== b.penaltyMinutes) return a.penaltyMinutes - b.penaltyMinutes;
    } else if (a.points !== b.points) return b.points - a.points;
    const lastA = a.lastChangeAtMs ?? Number.POSITIVE_INFINITY;
    const lastB = b.lastChangeAtMs ?? Number.POSITIVE_INFINITY;
    if (lastA !== lastB) return lastA - lastB;
    const orderA = board.orderByUser.get(a.userId);
    const orderB = board.orderByUser.get(b.userId);
    assert(orderA !== undefined && orderB !== undefined, "every row belongs to a registrant");
    return orderA - orderB;
}

// The whole fold in one call: the batch form the rating job and the tests use.
export function foldScoreboard(
    config: ScoreboardConfig,
    events: readonly ScoreboardEvent[],
    view: BoardView,
): Standing[] {
    const board = createBoard(config);
    for (const event of events) addEvent(board, event);
    return standings(board, view);
}
