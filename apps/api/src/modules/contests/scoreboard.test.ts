// Goal: the scoreboard fold ranks as ADR 0031 says and does not care in what order, or in how many
// pieces, judged submissions arrive. Method: worked ICPC and IOI examples with the tie-breaks and the
// freeze, then seeded random contests folded whole, shuffled and chunked, which must all agree.

import { describe, expect, it } from "vitest";
import {
    addEvent,
    createBoard,
    foldScoreboard,
    type ScoreboardConfig,
    type ScoreboardEvent,
    standings,
} from "./scoreboard.ts";

const MIN = 60_000;
const START = 1_000_000_000;
const END = START + 300 * MIN;
const people = ["u1", "u2", "u3", "u4"];

const icpc = (over: Partial<ScoreboardConfig> = {}): ScoreboardConfig => ({
    rules: { format: "icpc", penaltyMinutesPerWrong: 20 },
    startsAtMs: START,
    endsAtMs: END,
    freezeAtMs: null,
    problems: [
        { label: "A", points: 100 },
        { label: "B", points: 100 },
    ],
    registrants: people.map((userId, order) => ({ userId, order })),
    ...over,
});
const ioi = (over: Partial<ScoreboardConfig> = {}): ScoreboardConfig =>
    icpc({ rules: { format: "ioi" }, ...over });

const ev = (
    userId: string,
    label: string,
    minutes: number,
    verdict: ScoreboardEvent["verdict"],
    score: number | null = null,
): ScoreboardEvent => ({ userId, label, submittedAtMs: START + minutes * MIN, verdict, score });
const order = (
    config: ScoreboardConfig,
    events: ScoreboardEvent[],
    view: "public" | "final" = "final",
) => foldScoreboard(config, events, view).map((row) => row.userId);

describe("ICPC", () => {
    it("ranks by solved, then penalty, with 20 minutes per rejected run before the accept", () => {
        const rows = foldScoreboard(
            icpc(),
            [
                ev("u1", "A", 10, "WA"),
                ev("u1", "A", 30, "AC"), // 30 + 20
                ev("u2", "A", 50, "AC"), // 50
                ev("u2", "B", 70, "AC"), // 70 -> 2 solved, 120
                ev("u3", "A", 5, "AC"),
            ],
            "final",
        );
        expect(rows.map((r) => [r.userId, r.solved, r.penaltyMinutes])).toEqual([
            ["u2", 2, 120],
            ["u3", 1, 5],
            ["u1", 1, 50],
            ["u4", 0, 0],
        ]);
    });

    it("charges nothing for compile errors, system errors or runs after the accept", () => {
        const rows = foldScoreboard(
            icpc(),
            [
                ev("u1", "A", 1, "CE"),
                ev("u1", "A", 2, "SE"),
                ev("u1", "A", 10, "AC"),
                ev("u1", "A", 20, "WA"),
            ],
            "final",
        );
        expect(rows[0]).toMatchObject({ userId: "u1", penaltyMinutes: 10, solved: 1 });
        expect(rows[0]?.cells[0]).toMatchObject({ attempts: 0, minutes: 10 });
    });

    it("breaks ties by the last accept, then by registration order", () => {
        const events = [ev("u2", "A", 40, "AC"), ev("u1", "A", 40, "AC")];
        expect(order(icpc(), events)).toEqual(["u1", "u2", "u3", "u4"]); // same minute: registration
        const apart = [
            ev("u1", "A", 10, "AC"),
            ev("u1", "B", 50, "AC"),
            ev("u2", "A", 30, "AC"),
            ev("u2", "B", 30, "AC"),
        ];
        // u1: 2 solved, 60. u2: 2 solved, 60. Same penalty; u2's last accept (30) is earlier.
        expect(order(icpc(), apart).slice(0, 2)).toEqual(["u2", "u1"]);
    });

    it("hides what happens after the freeze from the public view only", () => {
        const config = icpc({ freezeAtMs: START + 240 * MIN });
        const events = [ev("u1", "A", 10, "AC"), ev("u2", "A", 250, "AC")];
        const publicRows = foldScoreboard(config, events, "public");
        expect(publicRows[1]).toMatchObject({ userId: "u2", solved: 0 });
        expect(publicRows[1]?.cells[0]?.hidden).toBe(1);
        expect(foldScoreboard(config, events, "final")[1]).toMatchObject({
            userId: "u2",
            solved: 1,
        });
    });

    it("lets an earlier accept that is judged later replace a later one", () => {
        const late = ev("u1", "A", 100, "AC");
        const early = ev("u1", "A", 40, "AC");
        const wrongBetween = ev("u1", "A", 70, "WA");
        const rows = foldScoreboard(icpc(), [late, wrongBetween, early], "final");
        expect(rows[0]).toMatchObject({ penaltyMinutes: 40 }); // the WA at 70 now follows the accept
    });
});

describe("IOI", () => {
    it("ranks by best points per problem, then the earliest time the total last improved", () => {
        const rows = foldScoreboard(
            ioi(),
            [
                ev("u1", "A", 10, "PARTIAL", 40),
                ev("u1", "A", 20, "PARTIAL", 70),
                ev("u1", "A", 30, "PARTIAL", 50), // not an improvement
                ev("u2", "A", 5, "AC"),
                ev("u3", "A", 15, "PARTIAL", 100), // ties u2 on points, later
            ],
            "final",
        );
        expect(rows.map((r) => [r.userId, r.points])).toEqual([
            ["u2", 100],
            ["u3", 100],
            ["u1", 70],
            ["u4", 0],
        ]);
    });

    it("scales a percentage to the problem's points exactly", () => {
        const config = ioi({
            problems: [
                { label: "A", points: 250 },
                { label: "B", points: 50 },
            ],
        });
        const rows = foldScoreboard(
            config,
            [ev("u1", "A", 1, "PARTIAL", 33.333), ev("u1", "B", 2, "AC")],
            "final",
        );
        expect(rows[0]?.points).toBe(83.333 + 50);
    });
});

describe("refusing nonsense", () => {
    it("fails loudly on an unknown person, problem or an instant outside the contest", () => {
        const board = createBoard(icpc());
        expect(() => addEvent(board, ev("ghost", "A", 1, "AC"))).toThrow();
        expect(() => addEvent(board, ev("u1", "Z", 1, "AC"))).toThrow();
        expect(() => addEvent(board, ev("u1", "A", -1, "AC"))).toThrow();
        expect(() => addEvent(board, ev("u1", "A", 300, "AC"))).toThrow(); // the end is exclusive
        expect(() => createBoard(icpc({ endsAtMs: START }))).toThrow();
    });
});

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomEvents(random: () => number, count: number): ScoreboardEvent[] {
    const verdicts = ["AC", "WA", "TLE", "CE", "SE", "RTE", "PARTIAL"] as const;
    const out: ScoreboardEvent[] = [];
    for (let i = 0; i < count; i++) {
        const verdict = verdicts[Math.floor(random() * verdicts.length)] ?? "WA";
        const score = verdict === "PARTIAL" ? Math.floor(random() * 99) + 1 : null;
        out.push(
            ev(
                people[Math.floor(random() * 4)] ?? "u1",
                random() < 0.5 ? "A" : "B",
                Math.floor(random() * 299),
                verdict,
                score,
            ),
        );
    }
    return out;
}

function shuffled<T>(random: () => number, items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const held = copy[i];
        const other = copy[j];
        if (held === undefined || other === undefined) throw new Error("index inside the list");
        copy[i] = other;
        copy[j] = held;
    }
    return copy;
}

describe("order independence", () => {
    it("gives one board however the submissions are ordered or chunked (500 seeds, both formats)", () => {
        for (let seed = 1; seed <= 500; seed++) {
            const random = mulberry32(seed);
            const events = randomEvents(random, 1 + Math.floor(random() * 60));
            const freezeAtMs = random() < 0.5 ? START + 200 * MIN : null;
            const config = seed % 2 === 0 ? icpc({ freezeAtMs }) : ioi({ freezeAtMs });
            for (const view of ["public", "final"] as const) {
                const whole = foldScoreboard(config, events, view);
                expect(foldScoreboard(config, shuffled(random, events), view)).toEqual(whole);
                const board = createBoard(config);
                const cut = Math.floor(random() * events.length);
                for (const event of shuffled(random, events.slice(cut))) addEvent(board, event);
                for (const event of events.slice(0, cut)) addEvent(board, event);
                expect(standings(board, view)).toEqual(whole);
            }
        }
    });

    it("never improves a rank by adding a rejected run (ICPC)", () => {
        for (let seed = 1; seed <= 200; seed++) {
            const random = mulberry32(seed);
            const events = randomEvents(random, 30);
            const before = foldScoreboard(icpc(), events, "final");
            const extra = ev("u3", "A", Math.floor(random() * 299), "WA");
            const after = foldScoreboard(icpc(), [...events, extra], "final");
            const rank = (rows: typeof before) => rows.find((r) => r.userId === "u3")?.rank ?? 0;
            expect(rank(after)).toBeGreaterThanOrEqual(rank(before));
            expect(after.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
        }
    });
});
