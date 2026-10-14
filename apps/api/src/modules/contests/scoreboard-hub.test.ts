// Goal: the stream hub keeps every bound it promises and never builds a backlog. Method: drive subscriptions
// directly (no HTTP, no database) through the caps, coalescing of missed pings, old-ping dropping, resync,
// timeouts and closure, and check the counts return to zero.

import { describe, expect, it } from "vitest";
import { createScoreboardHub } from "./scoreboard-hub.ts";
import { createScoreboardListener, SCOREBOARD_CHANNEL } from "./scoreboard-listener.ts";

const limits = {
    instanceMax: 4,
    contestMax: 3,
    viewerMax: (viewer: string) => (viewer === "u:a" ? 2 : 3),
};
const etag = (n: number) => String(n).padStart(64, "0");
const CONTEST = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function join(hub: ReturnType<typeof createScoreboardHub>, contest = CONTEST, viewer = "u:b") {
    const result = hub.subscribe(contest, "public", viewer);
    if (!result.ok) throw new Error(`refused: ${result.why}`);
    return result.subscription;
}

describe("the hub's caps", () => {
    it("refuses past the viewer, contest and instance caps, and frees a place on close", () => {
        const hub = createScoreboardHub(limits);
        const a1 = join(hub, CONTEST, "u:a");
        join(hub, CONTEST, "u:a");
        expect(hub.subscribe(CONTEST, "public", "u:a")).toEqual({ ok: false, why: "viewer" });
        join(hub, CONTEST, "u:b");
        expect(hub.subscribe(CONTEST, "public", "u:c")).toEqual({ ok: false, why: "contest" });
        join(hub, OTHER, "u:c");
        expect(hub.size()).toBe(4);
        expect(hub.subscribe(OTHER, "public", "u:d")).toEqual({ ok: false, why: "instance" });
        a1.close();
        a1.close(); // closing twice counts once
        expect(hub.size()).toBe(3);
        expect(hub.subscribe(OTHER, "public", "u:d").ok).toBe(true);
    });
});

describe("pings", () => {
    it("wakes a waiter, coalesces missed pings to the newest and drops old or repeated ones", async () => {
        const hub = createScoreboardHub(limits);
        const stream = join(hub);
        const waiting = stream.wait(1000);
        hub.publish(CONTEST, "public", { version: 1, etag: etag(1) });
        expect(await waiting).toEqual({ kind: "update", ping: { version: 1, etag: etag(1) } });
        hub.publish(CONTEST, "public", { version: 2, etag: etag(2) });
        hub.publish(CONTEST, "public", { version: 4, etag: etag(4) });
        hub.publish(CONTEST, "public", { version: 3, etag: etag(3) }); // late and older than the pending one
        expect(await stream.wait(1000)).toEqual({
            kind: "update",
            ping: { version: 4, etag: etag(4) },
        });
        hub.publish(CONTEST, "public", { version: 4, etag: etag(4) }); // already told
        expect((await stream.wait(10)).kind).toBe("timeout");
        hub.publish(OTHER, "public", { version: 9, etag: etag(9) }); // another contest
        hub.publish(CONTEST, "final", { version: 9, etag: etag(9) }); // another view
        expect((await stream.wait(10)).kind).toBe("timeout");
    });

    it("ignores versions the stream already reported from its own read", async () => {
        const hub = createScoreboardHub(limits);
        const stream = join(hub);
        stream.seen(5);
        hub.publish(CONTEST, "public", { version: 5, etag: etag(5) });
        expect((await stream.wait(10)).kind).toBe("timeout");
        hub.publish(CONTEST, "public", { version: 6, etag: etag(6) });
        expect((await stream.wait(10)).kind).toBe("update");
    });

    it("asks every stream to look again on resync, and ends a waiter when closed", async () => {
        const hub = createScoreboardHub(limits);
        const stream = join(hub);
        const waiting = stream.wait(1000);
        hub.resync();
        expect((await waiting).kind).toBe("resync");
        const closing = stream.wait(1000);
        stream.close();
        expect((await closing).kind).toBe("closed");
        expect((await stream.wait(10)).kind).toBe("closed");
        expect(hub.size()).toBe(0);
    });

    it("allows one waiter at a time and a positive timeout", async () => {
        const stream = join(createScoreboardHub(limits));
        const first = stream.wait(5);
        expect(() => stream.wait(5)).toThrow();
        await first;
        expect(() => stream.wait(0)).toThrow();
    });
});

describe("the Postgres listener", () => {
    const payload = (version: number) => `${CONTEST}:public:${version}:${etag(version)}`;

    it("turns notices into pings, ignores junk, and resyncs only after a reconnect", async () => {
        const hub = createScoreboardHub(limits);
        const junk: string[] = [];
        let notify: (text: string) => void = () => undefined;
        let listening: () => void = () => undefined;
        const listener = createScoreboardListener(
            hub,
            async (channel, onNotify, onListen) => {
                expect(channel).toBe(SCOREBOARD_CHANNEL);
                notify = onNotify;
                listening = onListen;
            },
            (text) => junk.push(text),
        );
        await listener.ensureListening();
        await listener.ensureListening(); // started once
        const stream = join(hub);
        listening(); // the first listen is not a reconnect
        notify(payload(3));
        expect(await stream.wait(100)).toEqual({
            kind: "update",
            ping: { version: 3, etag: etag(3) },
        });
        notify("not a notice");
        notify(`${CONTEST}:public:1:short`);
        expect(junk).toHaveLength(2);
        listening(); // reconnected: pings may have been lost
        expect((await stream.wait(100)).kind).toBe("resync");
    });

    it("lets the next stream try again when listening failed", async () => {
        let attempts = 0;
        const listener = createScoreboardListener(
            createScoreboardHub(limits),
            async () => {
                attempts++;
                if (attempts === 1) throw new Error("database down");
            },
            () => undefined,
        );
        await expect(listener.ensureListening()).rejects.toThrow("database down");
        await listener.ensureListening();
        expect(attempts).toBe(2);
    });
});
