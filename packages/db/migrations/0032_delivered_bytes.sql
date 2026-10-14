-- Delivered bytes (Stage 4C, ADR 0030). The manifest lists what was actually delivered for each version (the
-- bundle recorded by record_delivery_bundle, with the original's hash beside it and how it was marked), and
-- a download link points at that object: the original in its organization's place when nothing was marked,
-- the delivery's own copy otherwise. Both functions replace their earlier versions.
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
               'delivered', (select jsonb_build_object('sha256', encode(b.sha256, 'hex'), 'bytes', b.bytes,
                                                         'source_sha256', encode(b.source_sha256, 'hex'),
                                                         'answers_marked', b.answers_marked,
                                                         'solutions_marked', b.solutions_marked,
                                                         'verdicts_checked', b.verdicts_checked,
                                                         'attestation', b.attestation)
                               from delivery_bundles b
                              where b.delivery_id = p_delivery and b.task_version_id = v.id),
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

create or replace function issue_delivery_download(
    p_delivery uuid, p_version uuid, p_address inet, p_now timestamptz, p_lifetime_s int
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_delivery deliveries%rowtype;
    v_bundle delivery_bundles%rowtype;
begin
    select * into v_delivery from deliveries where id = p_delivery;
    if v_user is null or not found or app_org_role(v_delivery.customer_org_id) is null
       or app_org_role(v_delivery.customer_org_id) not in ('owner', 'admin', 'buyer') then
        raise exception 'no such delivery' using errcode = 'no_data_found';
    end if;
    if not exists (select 1 from order_items where order_id = v_delivery.order_id and task_version_id = p_version) then
        raise exception 'no such item' using errcode = 'no_data_found';
    end if;
    if v_delivery.state = 'revoked' then
        return jsonb_build_object('status', 'revoked');
    elsif v_delivery.state = 'pending' then
        return jsonb_build_object('status', 'pending');
    elsif v_delivery.expires_at <= p_now then
        return jsonb_build_object('status', 'expired');
    end if;
    select * into v_bundle from delivery_bundles where delivery_id = p_delivery and task_version_id = p_version;
    if not found then
        raise exception 'a ready delivery has a recorded bundle for every item' using errcode = 'data_exception';
    end if;
    insert into delivery_access (delivery_id, customer_org_id, user_id, task_version_id, address, issued_at, link_expires_at)
    values (p_delivery, v_delivery.customer_org_id, v_user, p_version, p_address, p_now, p_now + make_interval(secs => p_lifetime_s));
    return jsonb_build_object('status', 'ok', 'task_org_id', v_bundle.task_org_id,
                              'customer_org_id', v_delivery.customer_org_id,
                              'bundle_sha256', encode(v_bundle.sha256, 'hex'),
                              'is_original', v_bundle.sha256 = v_bundle.source_sha256);
end
$$;
