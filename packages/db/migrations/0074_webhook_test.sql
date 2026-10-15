-- "Send a test event" (Stage 9, cutlist F82): an owner can have one test delivery sent to an endpoint to check that it receives and
-- verifies signed requests. It travels the same path as a real delivery (same signature, same retries) so that it proves the real thing.
-- At most one test waits at a time per endpoint, so the button cannot be used to flood a receiver.
create function send_webhook_test(p_endpoint uuid, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
    v_id uuid;
begin
    select org_id into v_org from webhook_endpoints where id = p_endpoint and active;
    if v_org is null then
        raise exception 'no such endpoint' using errcode = 'no_data_found';
    end if;
    perform webhook_owner_only(v_org);
    if exists (select 1 from webhook_deliveries where endpoint_id = p_endpoint and event_type = 'webhook.test' and state = 'pending') then
        raise exception 'a test is already waiting' using errcode = 'object_not_in_prerequisite_state';
    end if;
    insert into webhook_deliveries (endpoint_id, org_id, event_type, source_id, payload, next_attempt_at, created_at)
    values (p_endpoint, v_org, 'webhook.test', gen_random_uuid(),
            jsonb_build_object('type', 'webhook.test', 'created', floor(extract(epoch from p_now))::bigint,
                               'data', jsonb_build_object('message', 'This is a test from AuraLand.')), p_now, p_now)
    returning id into v_id;
    return v_id;
end
$$;
revoke all on function send_webhook_test(uuid, timestamptz) from public;
grant execute on function send_webhook_test(uuid, timestamptz) to aura_app;
