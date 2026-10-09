import { assert } from "@aura/contracts/assert";
import type { Scenario } from "./runner.ts";

// Goal: prove the simulation loop itself. A bounded FIFO queue is driven by random operations
// while the clock advances; invariants are capacity, order and conservation of items. The same
// state machine with a deliberate bug (`withBug`) must fail on some seeds, and the failing seed
// must reproduce the failure exactly.

const CAPACITY = 8;

export function boundedQueueScenario(withBug: boolean): Scenario {
    return {
        name: withBug ? "selftest-queue-buggy" : "selftest-queue",
        stepsMax: 200,
        start(world) {
            const items: number[] = [];
            let nextId = 0;
            let enqueued = 0;
            let dequeued = 0;
            let lastDequeuedId = -1;
            return {
                step() {
                    world.clock.advance(world.rng.nextInt(1000));
                    if (world.rng.nextFloat() < 0.55) {
                        // The bug: the capacity check is off by one, so the queue overfills.
                        const hasRoom = withBug
                            ? items.length <= CAPACITY
                            : items.length < CAPACITY;
                        if (hasRoom) {
                            items.push(nextId++);
                            enqueued++;
                        }
                        return;
                    }
                    const item = items.shift();
                    if (item !== undefined) {
                        assert(item > lastDequeuedId, "queue is first in, first out");
                        lastDequeuedId = item;
                        dequeued++;
                    }
                },
                check() {
                    assert(items.length <= CAPACITY, "queue never exceeds capacity");
                    assert(enqueued - dequeued === items.length, "no item is lost");
                },
            };
        },
    };
}
