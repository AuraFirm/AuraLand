import { createHash } from "node:crypto";
import { type ScoreboardBody, scoreboardBodySchema } from "@aura/contracts/api/scoreboard";
import { assert } from "@aura/contracts/assert";
import { verdictSchema } from "@aura/contracts/judging";
import { z } from "zod";
import {
    type BoardView,
    foldScoreboard,
    type ScoreboardConfig,
    type ScoreboardEvent,
    type Standing,
} from "./scoreboard.ts";

// From the database's judged-log document to the two stored boards. Pure: the tick does the reading
// and writing, this does the parsing, the fold and the shaping, so a simulation can drive it too.

const MS_PER_SECOND = 1000;

export const scoreboardInputSchema = z
    .object({
        contest_id: z.string(),
        org_id: z.string(),
        format: z.enum(["icpc", "ioi"]),
        penalty_minutes_per_wrong: z.number().int().min(0),
        starts_at_ms: z.number().int(),
        ends_at_ms: z.number().int(),
        freeze_at_ms: z.number().int().nullable(),
        stamp: z.string(),
        problems: z.array(z.object({ label: z.string(), points: z.number().int() }).strict()),
        registrants: z.array(
            z
                .object({
                    user_id: z.string(),
                    order: z.number().int().min(0),
                    handle: z.string().nullable(),
                    display_name: z.string().nullable(),
                })
                .strict(),
        ),
        events: z.array(
            z
                .object({
                    user_id: z.string(),
                    label: z.string(),
                    submitted_at_ms: z.number().int(),
                    verdict: verdictSchema,
                    score: z.number().nullable(),
                })
                .strict(),
        ),
    })
    .strict();
export type ScoreboardInput = z.infer<typeof scoreboardInputSchema>;

export interface RenderedScoreboards {
    readonly publicBody: ScoreboardBody;
    readonly publicEtag: string;
    readonly finalBody: ScoreboardBody;
    readonly finalEtag: string;
}

function configOf(input: ScoreboardInput): ScoreboardConfig {
    return {
        rules:
            input.format === "icpc"
                ? { format: "icpc", penaltyMinutesPerWrong: input.penalty_minutes_per_wrong }
                : { format: "ioi" },
        startsAtMs: input.starts_at_ms,
        endsAtMs: input.ends_at_ms,
        freezeAtMs: input.freeze_at_ms,
        problems: input.problems,
        registrants: input.registrants.map((r) => ({ userId: r.user_id, order: r.order })),
    };
}

const eventsOf = (input: ScoreboardInput): ScoreboardEvent[] =>
    input.events.map((e) => ({
        userId: e.user_id,
        label: e.label,
        submittedAtMs: e.submitted_at_ms,
        verdict: e.verdict,
        score: e.score,
    }));

// The whole truth, ranked, with the people (the rating job needs ids, which no stored board carries).
export function finalStandings(input: ScoreboardInput): Standing[] {
    return foldScoreboard(configOf(input), eventsOf(input), "final");
}

export function renderScoreboards(input: ScoreboardInput): RenderedScoreboards {
    assert(input.registrants.length > 0 || input.events.length === 0, "scores need registrants");
    assert(input.events.length < 1e7, "the judged log fits in memory");
    const config = configOf(input);
    const events = eventsOf(input);
    const publicBody = bodyFor(input, foldScoreboard(config, events, "public"), "public");
    const finalBody = bodyFor(input, foldScoreboard(config, events, "final"), "final");
    return {
        publicBody,
        publicEtag: etagOf(publicBody),
        finalBody,
        finalEtag: etagOf(finalBody),
    };
}

function bodyFor(input: ScoreboardInput, rows: Standing[], view: BoardView): ScoreboardBody {
    const people = new Map(input.registrants.map((r) => [r.user_id, r]));
    const body = {
        view,
        format: input.format,
        frozen: view === "public" && input.freeze_at_ms !== null,
        problems: input.problems,
        rows: rows.map((row) => {
            const person = people.get(row.userId);
            assert(person !== undefined, "a row belongs to a registrant");
            return {
                rank: row.rank,
                participant: person.order + 1,
                handle: person.handle,
                display_name: person.display_name,
                solved: row.solved,
                penalty_minutes: row.penaltyMinutes,
                points: row.points,
                last_change_s:
                    row.lastChangeAtMs === null
                        ? null
                        : Math.floor((row.lastChangeAtMs - input.starts_at_ms) / MS_PER_SECOND),
                cells: row.cells,
            };
        }),
    };
    // Parsing is the check that no user id or other stray field is stored: the schema is strict.
    return scoreboardBodySchema.parse(body);
}

// The key order is fixed by the schema's construction above, so the same board always gives the same text.
function etagOf(body: ScoreboardBody): string {
    return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
