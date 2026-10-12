-- Issuing a download link for a delivered bundle (Stage 4A). The customer's right to a link is decided
-- here, in one place, and the log row is written in the same step: no link is issued without a row.
-- The function never raises for the expected refusals (pending, revoked, expired); it says which, so
-- the route can answer honestly. It raises "no data" for a caller who may not see the delivery at all,
-- or for a version that is not in it, so those two cases look the same from outside.

create function issue_delivery_download(
    p_delivery uuid, p_version uuid, p_address inet, p_now timestamptz, p_lifetime_s int
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_delivery deliveries%rowtype;
    v_sha text;
    v_task_org uuid;
begin
    select * into v_delivery from deliveries where id = p_delivery;
    if v_user is null or not found or app_org_role(v_delivery.customer_org_id) is null
       or app_org_role(v_delivery.customer_org_id) not in ('owner', 'admin', 'buyer') then
        raise exception 'no such delivery' using errcode = 'no_data_found';
    end if;
    select i.task_org_id, encode(v.bundle_sha256, 'hex') into v_task_org, v_sha
      from order_items i join task_versions v on v.id = i.task_version_id and v.org_id = i.task_org_id
     where i.order_id = v_delivery.order_id and i.task_version_id = p_version;
    if v_sha is null then
        raise exception 'no such item' using errcode = 'no_data_found';
    end if;
    if v_delivery.state = 'revoked' then
        return jsonb_build_object('status', 'revoked');
    elsif v_delivery.state = 'pending' then
        return jsonb_build_object('status', 'pending');
    elsif v_delivery.expires_at <= p_now then
        return jsonb_build_object('status', 'expired');
    end if;
    insert into delivery_access (delivery_id, customer_org_id, user_id, task_version_id, address, issued_at, link_expires_at)
    values (p_delivery, v_delivery.customer_org_id, v_user, p_version, p_address, p_now, p_now + make_interval(secs => p_lifetime_s));
    return jsonb_build_object('status', 'ok', 'task_org_id', v_task_org, 'bundle_sha256', v_sha);
end
$$;
revoke all on function issue_delivery_download(uuid, uuid, inet, timestamptz, int) from public;
grant execute on function issue_delivery_download(uuid, uuid, inet, timestamptz, int) to aura_app;
