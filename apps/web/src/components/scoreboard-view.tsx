"use client";

import { scoreboardResponseSchema } from "@aura/contracts/api/scoreboard";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../lib/api.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice } from "./section.tsx";
import { VirtualRows } from "./virtual-rows.tsx";

// The scoreboard: the stored board, kept fresh by a ping stream with a slow poll as the safety net. A ping
// says only "a new version exists"; the board itself is read from the snapshot. Rows are virtualized.
const ROW_HEIGHT_PX = 36;
const VIEWPORT_HEIGHT_PX = 540;
const POLL_MS = 15_000; // if the stream is down this is how stale the board can get

export function ScoreboardView({ contestId }: { contestId: string }) {
    const load = useCallback(
        () => apiGet(`/contests/${contestId}/scoreboard`, scoreboardResponseSchema),
        [contestId],
    );
    const { data, error, reload } = useLoad(load);
    const live = useLiveVersion(contestId, reload);
    if (error !== "") {
        return (
            <>
                <h1 className="text-2xl font-semibold">Scoreboard</h1>
                <Notice text="There is no scoreboard to show yet." />
            </>
        );
    }
    if (data === null) return <h1 className="text-2xl font-semibold">Scoreboard</h1>;
    const icpc = data.format === "icpc";
    return (
        <>
            <h1 className="text-2xl font-semibold">Scoreboard</h1>
            {data.frozen && (
                <Notice text="The scoreboard is frozen: runs after the freeze are hidden until the organizers lift it." />
            )}
            <p className="text-sm text-muted" role="status">
                {live ? "Live" : "Updating every few seconds"} · version {data.version}
            </p>
            <VirtualRows
                items={data.rows}
                rowHeightPx={ROW_HEIGHT_PX}
                viewportHeightPx={VIEWPORT_HEIGHT_PX}
                label="Scoreboard rows"
                header={<Header board={data} icpc={icpc} />}
                renderRow={(row, index) => (
                    <BoardRow key={row.participant} row={row} index={index} icpc={icpc} />
                )}
            />
        </>
    );
}

type Board = ReturnType<typeof scoreboardResponseSchema.parse>;

function Header({ board, icpc }: { board: Board; icpc: boolean }) {
    return (
        <tr>
            <th scope="col" className="px-2 text-left">
                Rank
            </th>
            <th scope="col" className="px-2 text-left">
                Participant
            </th>
            <th scope="col" className="px-2 text-right">
                {icpc ? "Solved" : "Points"}
            </th>
            {icpc && (
                <th scope="col" className="px-2 text-right">
                    Penalty
                </th>
            )}
            {board.problems.map((p) => (
                <th key={p.label} scope="col" className="px-2 text-center">
                    {p.label}
                </th>
            ))}
        </tr>
    );
}

function BoardRow({
    row,
    index,
    icpc,
}: {
    row: Board["rows"][number];
    index: number;
    icpc: boolean;
}) {
    return (
        <tr
            aria-rowindex={index + 2}
            style={{ height: ROW_HEIGHT_PX }}
            className="border-t border-line"
        >
            <td className="px-2">{row.rank}</td>
            <td className="px-2">
                {row.handle !== null ? (
                    <a className="text-accent underline" href={`/users/${row.handle}`}>
                        {row.display_name ?? row.handle}
                    </a>
                ) : (
                    `Participant ${row.participant}`
                )}
            </td>
            <td className="px-2 text-right">{icpc ? row.solved : row.points}</td>
            {icpc && <td className="px-2 text-right">{row.penalty_minutes}</td>}
            {row.cells.map((cell) => (
                <td key={cell.label} className="px-2 text-center">
                    {cellText(cell, icpc)}
                </td>
            ))}
        </tr>
    );
}

// Words, never color alone: a solved problem says so, an unsolved one shows its tries, hidden runs are counted.
function cellText(
    cell: {
        solved: boolean;
        attempts: number;
        minutes: number | null;
        points: number;
        hidden: number;
    },
    icpc: boolean,
): string {
    const hidden = cell.hidden > 0 ? ` +${cell.hidden}?` : "";
    if (icpc) {
        if (cell.solved) {
            return `✓ ${cell.minutes ?? 0}${cell.attempts > 0 ? ` (-${cell.attempts})` : ""}${hidden}`;
        }
        return cell.attempts > 0 || cell.hidden > 0 ? `✗ ${cell.attempts}${hidden}` : "·";
    }
    return cell.points > 0 ? `${cell.points}${hidden}` : cell.hidden > 0 ? `0${hidden}` : "·";
}

// Opens the ping stream and refreshes the board on each ping; polls slowly regardless. True while the stream
// has delivered something recently. EventSource reconnects by itself; the server closes it every 30 minutes
// and the reconnect is authorized again.
function useLiveVersion(contestId: string, refresh: () => void): boolean {
    const [live, setLive] = useState(false);
    useEffect(() => {
        const source = new EventSource(`/api/v1/contests/${contestId}/scoreboard/stream`);
        source.addEventListener("version", () => {
            setLive(true);
            refresh();
        });
        source.onerror = () => setLive(false);
        const poll = setInterval(refresh, POLL_MS);
        return () => {
            source.close();
            clearInterval(poll);
        };
    }, [contestId, refresh]);
    return live;
}
