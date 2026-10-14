"use client";

import { platformStatusSchema } from "@aura/contracts/api/status";
import { useEffect, useState } from "react";
import { apiGet } from "../lib/api.ts";

// The platform notice, shown on every page when an administrator has set one. It says what is wrong in words
// (the level is written, not only colored) and says nothing when all is well. Asked for again every minute.
const REFRESH_MS = 60_000;

export function StatusBanner() {
    const [status, setStatus] = useState<ReturnType<typeof platformStatusSchema.parse> | null>(
        null,
    );
    useEffect(() => {
        let live = true;
        const look = () =>
            apiGet("/status", platformStatusSchema).then(
                (value) => live && setStatus(value),
                () => undefined, // a failed look keeps the last notice
            );
        void look();
        const timer = setInterval(look, REFRESH_MS);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, []);
    if (status === null || status.level === "ok") return null;
    const outage = status.level === "outage";
    return (
        <div
            role={outage ? "alert" : "status"}
            className="border-b border-line bg-panel px-4 py-2 text-center"
        >
            <strong>{outage ? "Service outage:" : "Service notice:"}</strong> {status.message}
        </div>
    );
}
