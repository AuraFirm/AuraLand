-- Building a delivery (Stage 4A). The worker role reads what goes into a manifest and stores the result
-- through two functions only, so it gets no table privileges on orders or deliveries and cannot touch
-- anything else. The manifest hash is computed here, by the database, from the text it stores.

-- Everything the manifest is made of, for a delivery that is still pending. Statements and specs are
-- read here and nowhere else on the worker's path; the answer is one JSON document, or null.
create function delivery_build_input(p_delivery uuid) returns jsonb
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
               'bundle_bytes', v.bundle_bytes, 'task_org_id', v.org_id, 'waived', v.waived)
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

-- Stores the manifest once. Returns what happened so a retried job is harmless: 'ready' (stored now),
-- 'already_ready' (an earlier attempt stored it), or 'revoked' (nothing to build any more).
create function complete_delivery(p_delivery uuid, p_manifest text, p_now timestamptz) returns text
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_state text;
begin
    select state into v_state from deliveries where id = p_delivery for update;
    if v_state is null then
        raise exception 'no such delivery' using errcode = 'no_data_found';
    end if;
    if v_state = 'revoked' then
        return 'revoked';
    end if;
    if v_state = 'ready' then
        return 'already_ready';
    end if;
    update deliveries
       set state = 'ready', ready_at = p_now, manifest = p_manifest,
           manifest_sha256 = sha256(convert_to(p_manifest, 'UTF8'))
     where id = p_delivery;
    return 'ready';
end
$$;

revoke all on function delivery_build_input(uuid), complete_delivery(uuid, text, timestamptz) from public;
grant execute on function delivery_build_input(uuid), complete_delivery(uuid, text, timestamptz) to aura_worker;
