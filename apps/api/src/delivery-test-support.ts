import { createHash } from "node:crypto";
import type { Sql } from "@aura/db/client";

// Test support for deliveries (Stage 4C). A delivery cannot be built until every ordered version has its
// delivered bundle, which a judge node records after a watermark job. Tests of other things plant those
// records through the same table, as the database owner: one per ordered version, unchanged (the
// original is delivered) unless `marked` names a replacement hash for that version.
export async function plantDelivered(
    sql: Sql,
    deliveryId: string,
    marked: ReadonlyMap<string, Buffer> = new Map(),
): Promise<void> {
    const [node] = await sql<{ id: string }[]>`
        insert into judge_nodes (name, public_key, state, created_at)
        values (${`planted-${deliveryId.slice(0, 8)}`}, ${createHash("sha256").update(deliveryId).digest()}, 'active', now())
        on conflict (name) do update set name = excluded.name returning id`;
    const items = await sql<{ version: string; org: string; sha: Buffer; bytes: string }[]>`
        select i.task_version_id as version, v.org_id as org, v.bundle_sha256 as sha, v.bundle_bytes::text as bytes
        from deliveries d join order_items i on i.order_id = d.order_id
        join task_versions v on v.id = i.task_version_id and v.org_id = i.task_org_id
        where d.id = ${deliveryId} order by i.task_version_id`;
    for (const item of items) {
        const replacement = marked.get(item.version);
        await sql`insert into delivery_bundles
            (delivery_id, customer_org_id, task_version_id, task_org_id, tag, source_sha256, sha256, bytes,
             answers_marked, solutions_marked, verdicts_checked, node_id, attestation, created_at)
            select d.id, d.customer_org_id, ${item.version}, ${item.org}, delivery_tag(d.watermark_id, ${item.version}),
                   ${item.sha}, ${replacement ?? item.sha}, ${Number(item.bytes)}, false, ${replacement !== undefined},
                   true, ${node?.id ?? ""}, 'development', now()
            from deliveries d where d.id = ${deliveryId}`;
    }
}
