import { z } from "zod";
import type { ScoreboardHub } from "./scoreboard-hub.ts";

// Connects Postgres NOTIFY to the in-process hub. The channel carries "contest:view:version:etag" and no
// board. Started on the first stream, not at boot, so an instance that serves no streams holds no extra
// connection. If the connection drops, postgres.js reconnects and calls onlisten again; any pings sent in
// between are lost, so every open stream is told to look again (a resync).

export const SCOREBOARD_CHANNEL = "contest_scoreboard";

const payloadSchema = z
    .string()
    .regex(/^[0-9a-f-]{36}:(public|final):[0-9]{1,9}:[0-9a-f]{64}$/)
    .transform((text) => {
        const [contestId = "", view = "", version = "", etag = ""] = text.split(":");
        return {
            contestId,
            view: view === "final" ? ("final" as const) : ("public" as const),
            version: Number(version),
            etag,
        };
    });

// postgres.js's `listen`, narrowed to what we use so tests can stand in for it.
export type ListenFunction = (
    channel: string,
    onNotify: (payload: string) => void,
    onListen: () => void,
) => Promise<unknown>;

export interface ScoreboardListener {
    ensureListening(): Promise<void>;
}

export function createScoreboardListener(
    hub: ScoreboardHub,
    listen: ListenFunction,
    onBadPayload: (payload: string) => void,
): ScoreboardListener {
    let started: Promise<void> | null = null;
    return {
        ensureListening() {
            if (started !== null) return started;
            let first = true;
            started = listen(
                SCOREBOARD_CHANNEL,
                (payload) => {
                    const parsed = payloadSchema.safeParse(payload);
                    if (!parsed.success) return onBadPayload(payload);
                    const { contestId, view, version, etag } = parsed.data;
                    hub.publish(contestId, view, { version, etag });
                },
                () => {
                    if (first) first = false;
                    else hub.resync();
                },
            ).then(
                () => undefined,
                (error: unknown) => {
                    started = null; // the next stream tries again
                    throw error;
                },
            );
            return started;
        },
    };
}
