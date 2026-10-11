import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import { type ObjectStorage, uploadKey } from "../../platform/object-storage.ts";

// Housekeeping jobs. They run on the worker as `aura_worker` and touch the database only through the
// SECURITY DEFINER functions of migration 0016, so a bug here cannot read or change anything else.

export interface HandlerContext {
    readonly clock: Clock;
    readonly storage: ObjectStorage;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}

export const CLEANUP_KIND = "maintenance.cleanup";
export const ABORT_UPLOADS_KIND = "maintenance.abort_uploads";

// Uploads closed per pass; the next pass takes the rest, so one pass is bounded.
const UPLOADS_PER_PASS = 100;

export async function cleanupExpired(context: HandlerContext): Promise<Record<string, number>> {
    const now = new Date(context.clock.nowUnixMs());
    const rows = await context.inTransaction((tx) => tx`select cleanup_expired(${now}) as counts`);
    return z.object({ counts: z.record(z.string(), z.number()) }).parse(rows[0]).counts;
}

// An upload whose plan has expired can no longer be finalized: abort it in storage, then close the row.
// Aborting first means a storage fault leaves the row open and the next pass retries.
export async function abortExpiredUploads(context: HandlerContext): Promise<{ aborted: number }> {
    const now = new Date(context.clock.nowUnixMs());
    const rows = await context.inTransaction(
        (tx) =>
            tx`select id, org_id, storage_upload_id from expired_uploads(${now}, ${UPLOADS_PER_PASS})`,
    );
    const uploads = rows.map((row) =>
        z.object({ id: z.string(), org_id: z.string(), storage_upload_id: z.string() }).parse(row),
    );
    for (const upload of uploads) {
        await context.storage.abortMultipart(
            uploadKey(upload.org_id, upload.id),
            upload.storage_upload_id,
        );
        await context.inTransaction((tx) => tx`select close_upload(${upload.id}, ${now})`);
    }
    return { aborted: uploads.length };
}
