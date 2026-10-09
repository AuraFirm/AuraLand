import { assert } from "@aura/contracts/assert";

// The canonical middleware order (docs/kit/06 section 3, adapted: the access log is outermost
// after the request id so it observes the final status, including mapped errors). Stages add
// their middleware by name; registration order is asserted at startup and in a test.
export const PIPELINE_ORDER = [
    "requestId",
    "accessLog",
    "securityHeaders",
    "bodyLimit",
    "rateLimit",
    "authenticate",
    "csrf",
    "dbContext",
] as const;

export type PipelineName = (typeof PIPELINE_ORDER)[number];

const ORDER_INDEX: ReadonlyMap<string, number> = new Map(
    PIPELINE_ORDER.map((name, index) => [name, index]),
);

export function assertPipelineOrder(registered: readonly string[]): void {
    let lastIndex = -1;
    for (const name of registered) {
        const index = ORDER_INDEX.get(name);
        assert(index !== undefined, `unknown middleware: ${name}`);
        assert(index > lastIndex, `middleware out of order: ${name}`);
        lastIndex = index;
    }
}
