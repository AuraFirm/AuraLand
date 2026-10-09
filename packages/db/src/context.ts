import { assert } from "@aura/contracts/assert";
import type { Sql } from "./client.ts";
import { CONTEXT_ORGS_MAX } from "./limits.ts";

// Row-Level Security reads these transaction-local settings (docs/kit/05 section 6). They are set
// with `set_config(..., true)`, so they vanish at COMMIT/ROLLBACK and a pooled connection can
// never carry one request's identity into the next.

export type ActorKind = "anonymous" | "user" | "api_key" | "worker";

export interface RequestContext {
    readonly actorKind: ActorKind;
    readonly userId: string | null;
    readonly orgIds: readonly string[];
}

export type Transaction = Parameters<Parameters<Sql["begin"]>[1]>[0];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertContextValid(context: RequestContext): void {
    assert(context.orgIds.length <= CONTEXT_ORGS_MAX, "org list within limit");
    for (const orgId of context.orgIds) {
        assert(UUID_PATTERN.test(orgId), "org id is a lowercase uuid");
    }
    if (context.userId !== null) {
        assert(UUID_PATTERN.test(context.userId), "user id is a lowercase uuid");
    }
    if (context.actorKind === "anonymous") {
        assert(context.userId === null, "anonymous actor has no user id");
        assert(context.orgIds.length === 0, "anonymous actor has no orgs");
    }
}

export async function withRequestContext<T>(
    sql: Sql,
    context: RequestContext,
    work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
    assertContextValid(context);
    // tigerlint-allow: no-as-cast -- postgres.js wraps the result type in UnwrapPromiseArray<T>
    return sql.begin(async (transaction) => {
        // Parameters are bound, never interpolated, so identity values cannot inject SQL.
        await transaction`
            select
                set_config('app.actor_kind', ${context.actorKind}, true),
                set_config('app.user_id', ${context.userId ?? ""}, true),
                set_config('app.org_ids', ${context.orgIds.join(",")}, true)
        `;
        return work(transaction);
    }) as Promise<T>;
}
