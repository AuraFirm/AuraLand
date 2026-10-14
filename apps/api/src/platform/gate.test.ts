// Goal: the gate never lets more than its number in, serves the line in order, refuses past the line's bound,
// and gives places back exactly once. Method: drive it with promises that settle on demand.

import { describe, expect, it } from "vitest";
import { createGate } from "./gate.ts";

describe("the gate", () => {
    it("lets in up to its number and queues the rest in order", async () => {
        const gate = createGate(2, 10);
        const a = await gate.enter();
        const b = await gate.enter();
        expect([gate.holders(), gate.waiting()]).toEqual([2, 0]);
        const order: string[] = [];
        const c = gate.enter().then((p) => {
            order.push("c");
            return p;
        });
        const d = gate.enter().then((p) => {
            order.push("d");
            return p;
        });
        expect(gate.waiting()).toBe(2);
        a?.release();
        const pc = await c;
        expect(order).toEqual(["c"]); // first in line first
        expect(gate.holders()).toBe(2); // the place passed on, the count did not drop
        b?.release();
        const pd = await d;
        expect(order).toEqual(["c", "d"]);
        pc?.release();
        pd?.release();
        expect([gate.holders(), gate.waiting()]).toEqual([0, 0]);
    });

    it("refuses at once when the line is full, and recovers", async () => {
        const gate = createGate(1, 1);
        const first = await gate.enter();
        const waiting = gate.enter(); // the one place in line
        expect(await gate.enter()).toBeNull(); // no room at all
        first?.release();
        const second = await waiting;
        expect(second).not.toBeNull();
        second?.release();
        expect(await gate.enter()).not.toBeNull();
    });

    it("frees a place once however often it is released", async () => {
        const gate = createGate(1, 5);
        const permit = await gate.enter();
        permit?.release();
        permit?.release();
        permit?.release();
        expect(gate.holders()).toBe(0);
        const one = await gate.enter();
        const two = gate.enter();
        expect(gate.waiting()).toBe(1); // still only one place
        one?.release();
        (await two)?.release();
    });

    it("refuses nonsense bounds", () => {
        expect(() => createGate(0, 1)).toThrow();
        expect(() => createGate(1, -1)).toThrow();
        expect(() => createGate(1.5, 1)).toThrow();
    });
});
