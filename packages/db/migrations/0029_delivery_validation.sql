-- A delivery states what is known about each task's validation (Stage 4B): the latest passing report's
-- id, the attestation of the node that produced it, and its score. Without one the item still says
-- "not performed". This replaces the function of migration 0021; nothing else in it changes.
create or replace function delivery_build_input(p_delivery uuid) returns jsonb
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
    v_delivery deliveries%rowtype;
    v_order orders%rowtype;
    v_items jsonb;
begin
    select * into v_delivery from deliveries where id = p_delivery and state = 'pending';
    if not found then
        return null; -- revoked, already built or unknown: the job has nothing to do
    end if;
    select * into v_order from orders where id = v_delivery.order_id;
    select coalesce(jsonb_agg(jsonb_build_object(
               'task_version_id', v.id, 'task_id', v.task_id, 'seq', v.seq, 'spec', v.spec,
               'statement', v.statement, 'bundle_sha256', encode(v.bundle_sha256, 'hex'),
               'bundle_bytes', v.bundle_bytes, 'task_org_id', v.org_id, 'waived', v.waived,
               'validation', (select jsonb_build_object('report_id', r.id, 'attestation', r.attestation,
                                                          'score', r.score, 'score_version', r.score_version)
                                from validation_reports r
                               where r.task_version_id = v.id and r.passed
                               order by r.created_at desc, r.id desc limit 1))
               order by v.id), '[]'::jsonb)
      into v_items
      from order_items i join task_versions v on v.id = i.task_version_id and v.org_id = i.task_org_id
     where i.order_id = v_order.id and v.state = 'released';
    return jsonb_build_object(
        'delivery_id', v_delivery.id, 'order_id', v_order.id, 'customer_org_id', v_delivery.customer_org_id,
        'watermark_id', v_delivery.watermark_id, 'created_at', v_delivery.created_at,
        'expires_at', v_delivery.expires_at, 'licence_terms', v_order.licence_terms,
        'expected_item_count', (select count(*) from order_items where order_id = v_order.id),
        'items', v_items);
end
$$;
