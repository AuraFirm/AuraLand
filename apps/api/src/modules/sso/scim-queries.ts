import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for SCIM. Every function runs for the worker role: the requests come from a machine with a bearer token and no session.

export async function authenticate(
    tx: Transaction,
    hash: Buffer,
    nowMs: number,
): Promise<string | null> {
    const [row] = await tx`select scim_authenticate(${hash}, ${new Date(nowMs)}) as org`;
    return z.object({ org: z.string().nullable() }).parse(row).org;
}

const personRow = z.object({
    user_id: z.string(),
    email: z.string(),
    external_id: z.string().nullable(),
    active: z.boolean(),
    created_at: z.date(),
    updated_at: z.date(),
});
export type Person = z.infer<typeof personRow>;

export async function provision(
    tx: Transaction,
    input: {
        org: string;
        email: string;
        externalId: string | null;
        active: boolean;
        nowMs: number;
    },
): Promise<{
    userId: string | null;
    outcome: "created" | "linked" | "exists" | "wrong_domain" | "full";
}> {
    const [row] =
        await tx`select * from scim_provision(${input.org}, ${input.email}, ${input.externalId}, ${input.active}, ${new Date(input.nowMs)})`;
    const parsed = z
        .object({
            user_id: z.string().nullable(),
            outcome: z.enum(["created", "linked", "exists", "wrong_domain", "full"]),
        })
        .parse(row);
    return { userId: parsed.user_id, outcome: parsed.outcome };
}

export async function getPerson(
    tx: Transaction,
    org: string,
    user: string,
): Promise<Person | null> {
    const [row] = await tx`select * from scim_get(${org}, ${user})`;
    return row === undefined ? null : personRow.parse(row);
}

export async function listPeople(
    tx: Transaction,
    org: string,
    email: string | null,
    start: number,
    count: number,
) {
    const rows = await tx`select * from scim_list(${org}, ${email}, ${start}, ${count})`;
    const parsed = rows.map((row) => personRow.extend({ total: z.coerce.number() }).parse(row));
    return { people: parsed, total: parsed[0]?.total ?? 0 };
}

export async function setActive(
    tx: Transaction,
    org: string,
    user: string,
    active: boolean,
    nowMs: number,
) {
    const [row] =
        await tx`select scim_set_active(${org}, ${user}, ${active}, ${new Date(nowMs)}) as result`;
    return z.object({ result: z.enum(["ok", "missing", "full"]) }).parse(row).result;
}

export async function removePerson(
    tx: Transaction,
    org: string,
    user: string,
    nowMs: number,
): Promise<boolean> {
    const [row] = await tx`select scim_remove(${org}, ${user}, ${new Date(nowMs)}) as removed`;
    return z.object({ removed: z.boolean() }).parse(row).removed;
}
