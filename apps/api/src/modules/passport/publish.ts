import { createHash } from "node:crypto";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import type { ObjectStorage } from "../../platform/object-storage.ts";
import type { Signer } from "../../platform/signer.ts";
import { didDocument, jwks, type PublicKey } from "./documents.ts";
import { encodeStatusList, signStatusList } from "./status-list.ts";

// Publishes the documents a verifier needs as static files (ADR 0033): the issuer's DID document, the key set and one
// signed revocation list per list in use. Run by the worker after anything that changes them. A document is written
// only when its content changed, judged by a digest of the content (a signature differs every time, so the digest is
// of what is being said, not of the signed bytes).

export const DID_KEY = "public/passport/did.json";
export const JWKS_KEY = "public/passport/jwks.json";
export const statusKey = (list: number): string => `public/passport/status/${list}`;
const CREDENTIAL_PREFIX = "public/passport/credentials/";
export const credentialKey = (id: string): string => `${CREDENTIAL_PREFIX}${id}`;
// A bound, not a feature: more public credentials than this wait for the next run.
const PUBLIC_CREDENTIALS_PER_RUN_MAX = 10_000;

export interface PublishContext {
    readonly clock: Clock;
    readonly storage: ObjectStorage;
    readonly signer: Signer;
    readonly issuerDid: string;
    readonly publicOrigin: string;
}

const keyRow = z.object({
    kid: z.string(),
    alg: z.enum(["ES256", "EdDSA"]),
    status: z.enum(["active", "retired", "revoked"]),
    public_jwk: z.object({
        kty: z.string(),
        crv: z.string(),
        x: z.string(),
        y: z.string(),
    }),
});
const listRow = z.object({ status_list: z.number().int(), revoked: z.array(z.number().int()) });

export async function publishedKeys(tx: Transaction): Promise<PublicKey[]> {
    const rows =
        await tx`select kid, alg, status, public_jwk from signing_keys order by not_before, kid`;
    return rows.map((raw) => {
        const row = keyRow.parse(raw);
        return { kid: row.kid, alg: row.alg, status: row.status, jwk: row.public_jwk };
    });
}

const digestOf = (text: string): Buffer => createHash("sha256").update(text).digest();

async function writeIfChanged(
    tx: Transaction,
    context: PublishContext,
    input: { name: string; digest: Buffer; contentType: string; body: () => Promise<string> },
): Promise<boolean> {
    const known = await tx`select digest from passport_artifacts where name = ${input.name}`;
    const same = known[0] !== undefined && Buffer.compare(known[0]["digest"], input.digest) === 0;
    if (same && (await context.storage.getSmall(input.name, 1)).kind !== "missing") return false;
    // The file first, then the record: a crash between them only means the next run writes it again.
    await context.storage.putSmall(
        input.name,
        new TextEncoder().encode(await input.body()),
        input.contentType,
    );
    const now = new Date(context.clock.nowUnixMs());
    await tx`select record_passport_artifact(${input.name}, ${input.digest}, ${now})`;
    return true;
}

// Returns the names written this time.
export async function publishPassport(tx: Transaction, context: PublishContext): Promise<string[]> {
    const keys = await publishedKeys(tx);
    const written: string[] = [];
    const plain = async (name: string, document: object) => {
        const text = JSON.stringify(document);
        const changed = await writeIfChanged(tx, context, {
            name,
            digest: digestOf(text),
            contentType: "application/json",
            body: async () => text,
        });
        if (changed) written.push(name);
    };
    await plain(DID_KEY, didDocument(context.issuerDid, keys));
    await plain(JWKS_KEY, jwks(keys));
    const lists =
        await tx`select status_list, coalesce(array_agg(status_index) filter (where revoked_at is not null), '{}') as revoked
        from credentials group by status_list order by status_list`;
    for (const raw of lists) {
        const list = listRow.parse(raw);
        const encodedList = encodeStatusList(list.revoked);
        const name = statusKey(list.status_list);
        const changed = await writeIfChanged(tx, context, {
            name,
            digest: digestOf(`${list.status_list}:${context.signer.keyId}:${encodedList}`),
            contentType: "application/vc+jwt",
            body: () =>
                signStatusList(context.signer, {
                    listUrl: `${context.publicOrigin}/api/public/status-lists/${list.status_list}`,
                    issuerDid: context.issuerDid,
                    encodedList,
                    issuedAtMs: context.clock.nowUnixMs(),
                }),
        });
        if (changed) written.push(name);
    }
    written.push(...(await publishPublicCredentials(tx, context)));
    return written;
}

// The credentials their holders made public, one file each, so a verifier needs no database. A credential made
// private again has its file removed.
async function publishPublicCredentials(
    tx: Transaction,
    context: PublishContext,
): Promise<string[]> {
    const written: string[] = [];
    const rows = await tx`select id, vc_jwt from credentials where visibility = 'public'
        order by id limit ${PUBLIC_CREDENTIALS_PER_RUN_MAX}`;
    const wanted = new Set<string>();
    for (const raw of rows) {
        const row = z.object({ id: z.string(), vc_jwt: z.string() }).parse(raw);
        const name = credentialKey(row.id);
        wanted.add(name);
        const changed = await writeIfChanged(tx, context, {
            name,
            digest: digestOf(row.vc_jwt),
            contentType: "application/vc+jwt",
            body: async () => row.vc_jwt,
        });
        if (changed) written.push(name);
    }
    const published =
        await tx`select name from passport_artifacts where name like ${`${CREDENTIAL_PREFIX}%`} order by name`;
    for (const raw of published) {
        const name = z.object({ name: z.string() }).parse(raw).name;
        if (wanted.has(name)) continue;
        await context.storage.remove(name);
        await tx`select forget_passport_artifact(${name})`;
        written.push(`-${name}`);
    }
    return written;
}
