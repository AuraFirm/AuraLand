// Goal: the render cache never holds more than its bounds, never serves a text for a different etag, and
// drops the oldest first. Method: small bounds so the edges are reached in a few calls.

import { describe, expect, it } from "vitest";
import { createRenderCache } from "./scoreboard-cache.ts";

describe("the render cache", () => {
    it("serves a text only for the etag it was made from", () => {
        const cache = createRenderCache(100, 10);
        cache.set("a", "e1", "text-1");
        expect(cache.get("a", "e1")).toBe("text-1");
        expect(cache.get("a", "e2")).toBeNull(); // the board changed
        expect(cache.get("b", "e1")).toBeNull();
        cache.set("a", "e2", "text-2"); // replaces, does not add
        expect(cache.size()).toBe(1);
        expect(cache.get("a", "e1")).toBeNull();
    });

    it("keeps within its entry bound and drops the oldest first", () => {
        const cache = createRenderCache(1000, 3);
        for (const key of ["a", "b", "c", "d"]) cache.set(key, "e", key);
        expect(cache.size()).toBe(3);
        expect(cache.get("a", "e")).toBeNull();
        expect(cache.get("d", "e")).toBe("d");
    });

    it("keeps within its byte bound, and does not keep one text bigger than the bound", () => {
        const cache = createRenderCache(10, 100);
        cache.set("a", "e", "123456");
        cache.set("b", "e", "123456"); // 12 > 10: the oldest goes
        expect(cache.get("a", "e")).toBeNull();
        expect(cache.get("b", "e")).toBe("123456");
        cache.set("big", "e", "x".repeat(11)); // never kept, and it must not evict the rest
        expect(cache.get("big", "e")).toBeNull();
        expect(cache.get("b", "e")).toBe("123456");
    });
});
