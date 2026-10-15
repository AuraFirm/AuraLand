import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";

export interface EnvTickContext {
    readonly clock: Clock;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}

// A run whose job died (every attempt failed, or its reports were refused) is failed so that nobody waits for it forever.
export async function failDeadRuns(context: EnvTickContext): Promise<number> {
    return context.inTransaction(async (tx) => {
        const [row] =
            await tx`select fail_dead_env_runs(${new Date(context.clock.nowUnixMs())}) as n`;
        return z.object({ n: z.number() }).parse(row).n;
    });
}
