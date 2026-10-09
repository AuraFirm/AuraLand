import { assert } from "@aura/contracts/assert";
import postgres from "postgres";
import {
    POOL_CONNECT_TIMEOUT_S,
    POOL_CONNECTIONS_MAX,
    POOL_IDLE_TIMEOUT_S,
    POOL_MAX_LIFETIME_S,
} from "./limits.ts";

export type Sql = postgres.Sql;

export interface Database {
    readonly sql: Sql;
    close(timeoutS: number): Promise<void>;
}

// Options are spelled out on purpose (craft: do not rely on library defaults).
export function createDatabase(url: string, connectionsMax = POOL_CONNECTIONS_MAX): Database {
    assert(url.startsWith("postgres://") || url.startsWith("postgresql://"), "database url scheme");
    assert(connectionsMax >= 1 && connectionsMax <= POOL_CONNECTIONS_MAX, "pool size in bounds");
    const sql = postgres(url, {
        max: connectionsMax,
        idle_timeout: POOL_IDLE_TIMEOUT_S,
        connect_timeout: POOL_CONNECT_TIMEOUT_S,
        max_lifetime: POOL_MAX_LIFETIME_S,
        prepare: true,
        // Server notices are not errors; ignoring them keeps migrations quiet and logs clean.
        onnotice: () => undefined,
    });
    return { sql, close: (timeoutS) => sql.end({ timeout: timeoutS }) };
}
