"use client";

import { serverTimeSchema } from "@aura/contracts/api/contests";
import { useEffect, useState } from "react";
import { apiGet } from "./api.ts";

// The server's time, ticking once a second. A person's own clock can be minutes off, and a contest starts
// by the server's clock, so a countdown that trusted the browser would lie. The offset is measured against
// the middle of the request (half the round trip), and measured again every minute.
const TICK_MS = 1000;
const RESYNC_MS = 60_000;

export function useServerNow(): number | null {
    const [offsetMs, setOffsetMs] = useState<number | null>(null);
    const [, setTick] = useState(0);

    useEffect(() => {
        let live = true;
        const sync = async () => {
            try {
                const sent = Date.now();
                const time = await apiGet("/time", serverTimeSchema);
                const received = Date.now();
                if (live) setOffsetMs(time.now_ms - (sent + received) / 2);
            } catch {
                // A failed sync keeps the last offset; the next minute tries again.
            }
        };
        void sync();
        const resync = setInterval(sync, RESYNC_MS);
        const tick = setInterval(() => setTick((n) => n + 1), TICK_MS);
        return () => {
            live = false;
            clearInterval(resync);
            clearInterval(tick);
        };
    }, []);

    return offsetMs === null ? null : Date.now() + offsetMs;
}
