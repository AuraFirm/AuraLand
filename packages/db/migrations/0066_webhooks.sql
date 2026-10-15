-- Customer webhooks (Stage 9, slice 5b). An organization's owners register an https address and the events it wants; each
-- matching event becomes one delivery per endpoint, sent by the worker with retries for up to 24 hours and then given up on
-- (dead). The signing secret is needed in the clear to sign, so it is stored as is but no application role can select it: column
-- privileges leave it out, and only the worker and the definer functions below read it. Plan limits are enforced here, in the
-- function that creates an endpoint.

create table webhook_endpoints (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    url text not null,
    events text[] not null,
    secret_current text not null,
    -- The secret before the last rotation stays valid for signing for 24 hours, so a receiver can switch without a gap.
    secret_previous text,
    secret_rotated_at timestamptz,
    active boolean not null default true,
    created_by uuid not null references users (id),
    created_at timestamptz not null,
    constraint webhook_endpoints_url check (char_length(url) <= 2000 and url like 'https://%'),
    constraint webhook_endpoints_events check (cardinality(events) between 1 and 8
        and events <@ array['env_run.finished', 'credential.issued']),
    constraint webhook_endpoints_secrets check (secret_current ~ '^[0-9a-f]{64}$'
        and (secret_previous is null or secret_previous ~ '^[0-9a-f]{64}$'))
);
create index webhook_endpoints_org on webhook_endpoints (org_id, id);
create index webhook_endpoints_created_by on webhook_endpoints (created_by);
alter table webhook_endpoints enable row level security;
alter table webhook_endpoints force row level security;
create policy webhook_endpoints_read on webhook_endpoints for select to aura_app
    using (coalesce(app_org_role(org_id) in ('owner', 'admin'), false));
create policy webhook_endpoints_worker on webhook_endpoints for select to aura_worker using (true);
-- Column privileges: the secrets are not in this list, so "select *" by the application role fails loudly.
grant select (id, org_id, url, events, secret_rotated_at, active, created_by, created_at) on webhook_endpoints to aura_app;
grant select on webhook_endpoints to aura_worker;

create table webhook_deliveries (
    id uuid primary key default uuidv7(),
    endpoint_id uuid not null references webhook_endpoints (id),
    org_id uuid not null references orgs (id),
    event_type text not null,
    -- The fact that caused the event; with the endpoint and type it is unique, so an event is queued once per endpoint.
    source_id uuid not null,
    payload jsonb not null,
    state text not null default 'pending',
    attempts int not null default 0,
    next_attempt_at timestamptz,
    last_status int,
    last_reason text,
    created_at timestamptz not null,
    finished_at timestamptz,
    unique (endpoint_id, event_type, source_id),
    constraint webhook_deliveries_state check (state in ('pending', 'delivered', 'dead')),
    constraint webhook_deliveries_payload check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
    constraint webhook_deliveries_pending check ((state = 'pending') = (next_attempt_at is not null)),
    constraint webhook_deliveries_finished check ((state = 'pending') = (finished_at is null)),
    constraint webhook_deliveries_attempts check (attempts between 0 and 100),
    constraint webhook_deliveries_reason check (last_reason is null or char_length(last_reason) <= 100)
);
create index webhook_deliveries_due on webhook_deliveries (next_attempt_at) where state = 'pending';
create index webhook_deliveries_org on webhook_deliveries (org_id, id desc);
create index webhook_deliveries_endpoint on webhook_deliveries (endpoint_id, id desc);
alter table webhook_deliveries enable row level security;
alter table webhook_deliveries force row level security;
create policy webhook_deliveries_read on webhook_deliveries for select to aura_app
    using (coalesce(app_org_role(org_id) in ('owner', 'admin'), false));
create policy webhook_deliveries_worker on webhook_deliveries for select to aura_worker using (true);
grant select on webhook_deliveries to aura_app, aura_worker;

create function webhook_owner_only(p_org uuid) returns void language plpgsql stable security definer
    set search_path = pg_catalog, public as $$
begin
    if nullif(current_setting('app.user_id', true), '') is null
       or coalesce(app_org_role(p_org) in ('owner', 'admin'), false) is not true then
        raise exception 'no such organization' using errcode = 'no_data_found';
    end if;
end
$$;

create function create_webhook_endpoint(p_org uuid, p_url text, p_events text[], p_secret text, p_now timestamptz)
    returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_id uuid;
    v_max int;
begin
    perform webhook_owner_only(p_org);
    select webhook_endpoints_max into v_max from org_entitlements(p_org);
    if coalesce(v_max, 0) <= (select count(*) from webhook_endpoints where org_id = p_org and active) then
        raise exception 'this plan has no room for another endpoint' using errcode = 'program_limit_exceeded';
    end if;
    insert into webhook_endpoints (org_id, url, events, secret_current, created_by, created_at)
    values (p_org, p_url, p_events, p_secret, nullif(current_setting('app.user_id', true), '')::uuid, p_now)
    returning id into v_id;
    return v_id;
end
$$;

create function rotate_webhook_secret(p_endpoint uuid, p_secret text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
begin
    select org_id into v_org from webhook_endpoints where id = p_endpoint and active;
    if v_org is null then
        raise exception 'no such endpoint' using errcode = 'no_data_found';
    end if;
    perform webhook_owner_only(v_org);
    update webhook_endpoints set secret_previous = secret_current, secret_current = p_secret, secret_rotated_at = p_now
     where id = p_endpoint;
end
$$;

create function disable_webhook_endpoint(p_endpoint uuid) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
begin
    select org_id into v_org from webhook_endpoints where id = p_endpoint and active;
    if v_org is null then
        raise exception 'no such endpoint' using errcode = 'no_data_found';
    end if;
    perform webhook_owner_only(v_org);
    update webhook_endpoints set active = false where id = p_endpoint;
end
$$;
revoke all on function webhook_owner_only(uuid), create_webhook_endpoint(uuid, text, text[], text, timestamptz),
    rotate_webhook_secret(uuid, text, timestamptz), disable_webhook_endpoint(uuid) from public;
grant execute on function create_webhook_endpoint(uuid, text, text[], text, timestamptz),
    rotate_webhook_secret(uuid, text, timestamptz), disable_webhook_endpoint(uuid) to aura_app;

-- Internal: queue an event for every active endpoint of the organization that wants it. Called by triggers; no role can call it.
create function enqueue_webhook_event(p_org uuid, p_type text, p_source uuid, p_data jsonb, p_now timestamptz) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_count int;
begin
    insert into webhook_deliveries (endpoint_id, org_id, event_type, source_id, payload, next_attempt_at, created_at)
    select e.id, e.org_id, p_type, p_source,
           jsonb_build_object('type', p_type, 'created', floor(extract(epoch from p_now))::bigint, 'data', p_data),
           p_now, p_now
      from webhook_endpoints e where e.org_id = p_org and e.active and p_type = any (e.events)
    on conflict (endpoint_id, event_type, source_id) do nothing;
    get diagnostics v_count = row_count;
    return v_count;
end
$$;
revoke all on function enqueue_webhook_event(uuid, text, uuid, jsonb, timestamptz) from public;

-- A finished or failed environment run is an event for its organization's endpoints.
create function webhook_from_env_run() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    if old.state = 'queued' and new.state in ('done', 'failed') then
        perform enqueue_webhook_event(new.org_id, 'env_run.finished', new.id, jsonb_build_object(
            'run_id', 'evr_' || new.id::text, 'environment_id', 'env_' || new.environment_id::text,
            'state', new.state, 'outcome', new.outcome, 'score', new.score, 'isolation', new.isolation,
            'eligible', new.eligible), new.finished_at);
    end if;
    return new;
end
$$;
create trigger webhook_from_env_run after update on env_runs for each row execute function webhook_from_env_run();

-- The worker takes due deliveries. A claim pushes the next attempt a minute ahead, so a worker that dies mid-delivery loses its claim
-- on its own. Deliveries whose endpoint was switched off are given up on here.
create function claim_due_webhook_deliveries(p_now timestamptz, p_limit int)
    returns table (id uuid, url text, event_type text, payload jsonb, created_at timestamptz, attempts int,
                   secret_current text, secret_previous text, secret_rotated_at timestamptz)
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    update webhook_deliveries d set state = 'dead', next_attempt_at = null, finished_at = p_now,
           last_reason = 'endpoint switched off'
      from webhook_endpoints e
     where d.endpoint_id = e.id and not e.active and d.state = 'pending';
    return query
    with due as (
        select d.id from webhook_deliveries d where d.state = 'pending' and d.next_attempt_at <= p_now
         order by d.next_attempt_at, d.id limit least(greatest(p_limit, 1), 50) for update skip locked)
    update webhook_deliveries d set next_attempt_at = p_now + interval '60 seconds'
      from due, webhook_endpoints e
     where d.id = due.id and e.id = d.endpoint_id
    returning d.id, e.url, d.event_type, d.payload, d.created_at, d.attempts, e.secret_current, e.secret_previous,
              e.secret_rotated_at;
end
$$;

-- Records what happened. p_next null on a failure means: give up.
create function record_webhook_attempt(p_id uuid, p_ok boolean, p_status int, p_reason text, p_next timestamptz, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    update webhook_deliveries set attempts = attempts + 1, last_status = p_status, last_reason = left(p_reason, 100),
           state = case when p_ok then 'delivered' when p_next is null then 'dead' else 'pending' end,
           next_attempt_at = case when p_ok or p_next is null then null else p_next end,
           finished_at = case when p_ok or p_next is null then p_now else null end
     where id = p_id and state = 'pending';
    if not found then
        raise exception 'this delivery is not waiting' using errcode = 'object_not_in_prerequisite_state';
    end if;
end
$$;
revoke all on function claim_due_webhook_deliveries(timestamptz, int), record_webhook_attempt(uuid, boolean, int, text, timestamptz, timestamptz) from public;
grant execute on function claim_due_webhook_deliveries(timestamptz, int), record_webhook_attempt(uuid, boolean, int, text, timestamptz, timestamptz) to aura_worker;
