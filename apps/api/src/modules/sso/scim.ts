import { z } from "zod";
import type { Person } from "./scim-queries.ts";

// SCIM 2.0 Users, the small part identity providers use to create and switch off people (RFC 7643, 7644). Pure helpers: how a
// person is shown, and how the loose request bodies identity providers send are read. Providers add and vary fields, so the request
// side is deliberately not strict; every value we use is checked here.

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export function toResource(person: Person) {
    return {
        schemas: [USER_SCHEMA],
        id: person.user_id,
        ...(person.external_id === null ? {} : { externalId: person.external_id }),
        userName: person.email,
        active: person.active,
        emails: [{ value: person.email, primary: true }],
        meta: {
            resourceType: "User",
            created: person.created_at.toISOString(),
            lastModified: person.updated_at.toISOString(),
        },
    };
}

const flag = z.union([
    z.boolean(),
    z.enum(["True", "False", "true", "false"]).transform((v) => v.toLowerCase() === "true"),
]);

const createBody = z.object({
    userName: z.string().max(254),
    externalId: z.string().min(1).max(255).optional(),
    active: flag.optional(),
});

export function parseCreate(json: unknown) {
    const parsed = createBody.safeParse(json);
    if (!parsed.success) return null;
    const email = z.email().safeParse(parsed.data.userName.toLowerCase());
    if (!email.success) return null;
    return {
        email: email.data,
        externalId: parsed.data.externalId ?? null,
        active: parsed.data.active ?? true,
    };
}

// What a replace or patch says about `active`, or null when it says nothing about it. Okta sends {op, value: {active}}, Azure sends
// {op, path: "active", value: "False"}; both are read. Anything else in the request is ignored.
export function activeFrom(json: unknown): boolean | null {
    const body = z
        .object({
            active: flag.optional(),
            Operations: z
                .array(
                    z.object({ op: z.string(), path: z.string().optional(), value: z.unknown() }),
                )
                .max(20)
                .optional(),
        })
        .safeParse(json);
    if (!body.success) return null;
    if (body.data.active !== undefined) return body.data.active;
    for (const operation of body.data.Operations ?? []) {
        if (operation.op.toLowerCase() !== "replace" && operation.op.toLowerCase() !== "add")
            continue;
        if (operation.path?.toLowerCase() === "active") {
            const direct = flag.safeParse(operation.value);
            if (direct.success) return direct.data;
        }
        if (operation.path === undefined) {
            const nested = z.object({ active: flag }).safeParse(operation.value);
            if (nested.success) return nested.data.active;
        }
    }
    return null;
}

// The only filter we understand: userName eq "someone@example.com".
export function emailFromFilter(
    filter: string | undefined,
): { ok: true; email: string | null } | { ok: false } {
    if (filter === undefined || filter === "") return { ok: true, email: null };
    const match = /^userName eq "([^"\\]{1,254})"$/i.exec(filter.trim());
    return match === null ? { ok: false } : { ok: true, email: (match[1] ?? "").toLowerCase() };
}
