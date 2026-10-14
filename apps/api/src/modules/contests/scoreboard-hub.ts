import { assert } from "@aura/contracts/assert";

// The in-process fan-out of "a new board exists" pings to open scoreboard streams (Stage 5, slice 6).
// It is memory only. A stream gets a ping, not a board: missed pings collapse into the latest one, so
// a slow client never builds a backlog (the bound the plan called a ring buffer is one slot per stream),
// and a client that missed some simply reads the cacheable snapshot, which is always the truth.

export type ScoreboardViewName = "public" | "final";

export interface HubLimits {
    readonly instanceMax: number;
    readonly contestMax: number;
    readonly viewerMax: (viewer: string) => number;
}

export interface Ping {
    readonly version: number;
    readonly etag: string;
}

export type Wake =
    | { readonly kind: "update"; readonly ping: Ping }
    | { readonly kind: "resync" } // the database connection was re-established: look again
    | { readonly kind: "timeout" }
    | { readonly kind: "closed" };

export interface Subscription {
    // Resolves with the newest unseen ping, a resync request, a timeout or closure. One waiter at a time.
    wait(timeoutMs: number): Promise<Wake>;
    // Records a version the stream has already told its client (from its own read), so older pings drop.
    seen(version: number): void;
    close(): void;
}

export type SubscribeResult =
    | { readonly ok: true; readonly subscription: Subscription }
    | { readonly ok: false; readonly why: "instance" | "contest" | "viewer" };

export interface ScoreboardHub {
    subscribe(contestId: string, view: ScoreboardViewName, viewer: string): SubscribeResult;
    publish(contestId: string, view: ScoreboardViewName, ping: Ping): void;
    resync(): void;
    size(): number;
}

const keyOf = (contestId: string, view: ScoreboardViewName) => `${contestId}:${view}`;

class Stream implements Subscription {
    pending: Ping | null = null;
    resyncing = false;
    closed = false;
    seenVersion = 0;
    private waiter: ((wake: Wake) => void) | null = null;
    private timer: NodeJS.Timeout | null = null;

    readonly key: string;
    readonly contestId: string;
    readonly viewer: string;
    private readonly release: (stream: Stream) => void;

    constructor(key: string, contestId: string, viewer: string, release: (stream: Stream) => void) {
        this.key = key;
        this.contestId = contestId;
        this.viewer = viewer;
        this.release = release;
    }

    seen(version: number): void {
        this.seenVersion = Math.max(this.seenVersion, version);
    }

    wait(timeoutMs: number): Promise<Wake> {
        assert(this.waiter === null, "one waiter at a time");
        assert(timeoutMs >= 1, "a wait has a positive timeout");
        const ready = this.takeReady();
        if (ready !== null) return Promise.resolve(ready);
        return new Promise((resolve) => {
            this.waiter = resolve;
            this.timer = setTimeout(() => this.settle({ kind: "timeout" }), timeoutMs);
            this.timer.unref();
        });
    }

    private takeReady(): Wake | null {
        if (this.closed) return { kind: "closed" };
        if (this.resyncing) {
            this.resyncing = false;
            return { kind: "resync" };
        }
        if (this.pending === null) return null;
        const ping = this.pending;
        this.pending = null;
        this.seenVersion = ping.version;
        return { kind: "update", ping };
    }

    private settle(wake: Wake): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        const resolve = this.waiter;
        this.waiter = null;
        resolve?.(wake);
    }

    nudge(): void {
        if (this.waiter === null) return;
        const ready = this.takeReady();
        if (ready !== null) this.settle(ready);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.release(this);
        this.nudge();
    }
}

export function createScoreboardHub(limits: HubLimits): ScoreboardHub {
    const byKey = new Map<string, Set<Stream>>();
    const perContest = new Map<string, number>();
    const perViewer = new Map<string, number>();
    let total = 0;
    const release = (stream: Stream) => {
        const set = byKey.get(stream.key);
        set?.delete(stream);
        if (set?.size === 0) byKey.delete(stream.key);
        decrement(perContest, stream.contestId);
        decrement(perViewer, stream.viewer);
        total--;
    };
    return {
        subscribe(contestId, view, viewer) {
            if (total >= limits.instanceMax) return { ok: false, why: "instance" };
            if ((perContest.get(contestId) ?? 0) >= limits.contestMax) {
                return { ok: false, why: "contest" };
            }
            if ((perViewer.get(viewer) ?? 0) >= limits.viewerMax(viewer)) {
                return { ok: false, why: "viewer" };
            }
            const key = keyOf(contestId, view);
            const stream = new Stream(key, contestId, viewer, release);
            const set = byKey.get(key) ?? new Set<Stream>();
            set.add(stream);
            byKey.set(key, set);
            perContest.set(contestId, (perContest.get(contestId) ?? 0) + 1);
            perViewer.set(viewer, (perViewer.get(viewer) ?? 0) + 1);
            total++;
            assert(total <= limits.instanceMax, "the instance cap holds");
            return { ok: true, subscription: stream };
        },
        publish(contestId, view, ping) {
            for (const stream of byKey.get(keyOf(contestId, view)) ?? []) {
                // An older or repeated version is dropped; a newer one replaces any pending one.
                if (ping.version <= stream.seenVersion) continue;
                if (stream.pending === null || ping.version > stream.pending.version) {
                    stream.pending = ping;
                }
                stream.nudge();
            }
        },
        resync() {
            for (const set of byKey.values()) {
                for (const stream of set) {
                    stream.resyncing = true;
                    stream.nudge();
                }
            }
        },
        size: () => total,
    };
}

function decrement(counts: Map<string, number>, key: string): void {
    const count = counts.get(key) ?? 0;
    assert(count >= 1, "a counted stream is counted once");
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
}
