import { ssoConnectionSchema, ssoDomainSchema } from "@aura/contracts/api/sso";
import { encodeId } from "@aura/contracts/ids";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Discovery } from "./oidc.ts";

// SQL for single sign-on connections and domains. The client secret is never selected by the application role.

export async function saveConnection(
    tx: Transaction,
    input: {
        org: string;
        issuer: string;
        clientId: string;
        clientSecret: string;
        discovery: Discovery;
        nowMs: number;
    },
): Promise<void> {
    await tx`select save_sso_connection(${input.org}, ${input.issuer}, ${input.clientId}, ${input.clientSecret},
        ${input.discovery.authorizationEndpoint}, ${input.discovery.tokenEndpoint}, ${input.discovery.jwksUri}, ${new Date(input.nowMs)})`;
}

const connectionRow = z.object({
    org_id: z.string(),
    issuer: z.string(),
    client_id: z.string(),
    updated_at: z.date(),
});

export async function getConnection(tx: Transaction, org: string) {
    const [row] =
        await tx`select org_id, issuer, client_id, updated_at from sso_connections where org_id = ${org}`;
    if (row === undefined) return null;
    const parsed = connectionRow.parse(row);
    return ssoConnectionSchema.parse({
        org_id: encodeId("org", parsed.org_id),
        issuer: parsed.issuer,
        client_id: parsed.client_id,
        updated_at: parsed.updated_at.toISOString(),
    });
}

export async function deleteConnection(tx: Transaction, org: string): Promise<void> {
    await tx`select delete_sso_connection(${org})`;
}

export const challengeName = (domain: string) => `_aura-challenge.${domain}`;
export const challengeValue = (token: string) => `aura-verify=${token}`;

export async function addDomain(
    tx: Transaction,
    org: string,
    domain: string,
    token: string,
    nowMs: number,
): Promise<string> {
    const [row] =
        await tx`select add_sso_domain(${org}, ${domain}, ${token}, ${new Date(nowMs)}) as token`;
    return z.object({ token: z.string() }).parse(row).token;
}

const domainRow = z.object({
    domain: z.string(),
    token: z.string(),
    verified_at: z.date().nullable(),
});

export async function listDomains(tx: Transaction, org: string) {
    const rows =
        await tx`select domain, token, verified_at from sso_domains where org_id = ${org} order by domain limit 20`;
    return rows.map((raw) => {
        const row = domainRow.parse(raw);
        return ssoDomainSchema.parse({
            domain: row.domain,
            txt_name: challengeName(row.domain),
            txt_value: challengeValue(row.token),
            verified: row.verified_at !== null,
        });
    });
}

export async function domainToken(
    tx: Transaction,
    org: string,
    domain: string,
): Promise<string | null> {
    const [row] =
        await tx`select token from sso_domains where org_id = ${org} and domain = ${domain}`;
    return row === undefined ? null : z.object({ token: z.string() }).parse(row).token;
}

export async function markVerified(
    tx: Transaction,
    org: string,
    domain: string,
    nowMs: number,
): Promise<void> {
    await tx`select verify_sso_domain(${org}, ${domain}, ${new Date(nowMs)})`;
}

export async function removeDomain(tx: Transaction, org: string, domain: string): Promise<void> {
    await tx`select remove_sso_domain(${org}, ${domain})`;
}
