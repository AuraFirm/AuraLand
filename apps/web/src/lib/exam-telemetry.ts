"use client";

import type { TelemetryEvent } from "@aura/contracts/exams";
import { useEffect } from "react";
import { z } from "zod";
import { ApiError, apiSend } from "./api.ts";

// What the page tells the server about the sitting, after the person consented and only while it is under way
// (ADR 0032 decision 8). Counts and durations only: how long the window was away, how many characters were pasted,
// never what they were. Batched and best effort: a lost batch loses telemetry, never work.
const FLUSH_EVERY_MS = 5_000;
const BATCH_MAX = 100;
const BACKLOG_MAX = 500; // events kept while the connection is down; older ones are dropped

type Listener = (event: TelemetryEvent) => void;
const listeners = new Set<Listener>();

// The editor reports its edits here, so it does not need to know whether anyone is listening.
export function reportTelemetry(event: TelemetryEvent): void {
    for (const listener of listeners) listener(event);
}

// Only the size of an edit leaves the page, never the text (the text is the answer, and is saved on its own).
export function reportEdit(before: number, after: number): void {
    if (after === before) return;
    reportTelemetry({
        kind: "edit",
        t: Date.now(),
        data: { added: Math.max(0, after - before), removed: Math.max(0, before - after) },
    });
}

export function useExamTelemetry(examId: string, active: boolean): void {
    useEffect(() => {
        if (!active) return;
        const queue: TelemetryEvent[] = [];
        let stopped = false;
        const push: Listener = (event) => {
            if (stopped) return;
            queue.push(event);
            if (queue.length > BACKLOG_MAX) queue.splice(0, queue.length - BACKLOG_MAX);
        };
        listeners.add(push);
        const undo = watchBrowser(push);
        const flush = async () => {
            if (stopped || queue.length === 0) return;
            const batch = queue.splice(0, BATCH_MAX);
            try {
                await apiSend(`/exams/${examId}/telemetry`, z.object({ accepted: z.number() }), {
                    method: "POST",
                    body: { events: batch },
                });
            } catch (error) {
                // No consent or the time is over: stop for good. A rate limit drops the batch. A network error keeps it.
                if (error instanceof ApiError && (error.status === 403 || error.status === 409))
                    stopped = true;
                else if (!(error instanceof ApiError && error.status === 429))
                    queue.unshift(...batch);
            }
        };
        const timer = setInterval(() => void flush(), FLUSH_EVERY_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
            listeners.delete(push);
            undo();
        };
    }, [examId, active]);
}

// Listeners for what the browser reports. Returns the function that removes them.
function watchBrowser(push: Listener): () => void {
    let lostAt: number | null = null;
    let offlineAt: number | null = null;
    const now = () => Date.now();
    const lost = () => {
        if (lostAt !== null) return;
        lostAt = now();
        push({ kind: "focus_lost", t: now(), data: {} });
    };
    const gained = () => {
        if (lostAt === null) return;
        push({ kind: "focus_gained", t: now(), data: { away_ms: Math.max(0, now() - lostAt) } });
        lostAt = null;
    };
    const visibility = () => (document.visibilityState === "hidden" ? lost() : gained());
    const clip = (kind: "paste" | "copy" | "cut") => (event: ClipboardEvent) => {
        const chars =
            kind === "paste"
                ? (event.clipboardData?.getData("text").length ?? 0)
                : (document.getSelection()?.toString().length ?? 0);
        push({ kind, t: now(), data: { chars } });
    };
    const fullscreen = () => {
        if (document.fullscreenElement === null)
            push({ kind: "fullscreen_exit", t: now(), data: {} });
    };
    const offline = () => {
        offlineAt = now();
        push({ kind: "offline", t: now(), data: {} });
    };
    const online = () => {
        push({
            kind: "online",
            t: now(),
            data: { offline_ms: offlineAt === null ? 0 : Math.max(0, now() - offlineAt) },
        });
        offlineAt = null;
    };
    const paste = clip("paste");
    const copy = clip("copy");
    const cut = clip("cut");
    window.addEventListener("blur", lost);
    window.addEventListener("focus", gained);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("paste", paste);
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    document.addEventListener("fullscreenchange", fullscreen);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
        window.removeEventListener("blur", lost);
        window.removeEventListener("focus", gained);
        document.removeEventListener("visibilitychange", visibility);
        document.removeEventListener("paste", paste);
        document.removeEventListener("copy", copy);
        document.removeEventListener("cut", cut);
        document.removeEventListener("fullscreenchange", fullscreen);
        window.removeEventListener("offline", offline);
        window.removeEventListener("online", online);
    };
}
