-- Provider events (Stage 9, slice 3). The payment provider tells us a checkout completed or a subscription ended. Each event
-- is applied at most once (keyed by the provider's event id), never out of order (an older event cannot undo a newer one), and
-- never over a plan staff set by hand (a negotiated contract is not a card subscription).

alter table customers alter column updated_by drop not null;
alter table customers add column source text not null default 'staff';
alter table customers add column provider_event_at timestamptz;
alter table customers add constraint customers_source check (
    (source = 'staff' and updated_by is not null) or (source = 'provider' and updated_by is null));

create table billing_events (
    provider_event_id text primary key,
    event_type text not null,
    org_id uuid references orgs (id),
    provider_created_at timestamptz not null,
    received_at timestamptz not null,
    outcome text not null,
    constraint billing_events_id check (char_length(provider_event_id) between 1 and 255),
    constraint billing_events_type check (char_length(event_type) between 1 and 100),
    constraint billing_events_outcome check (outcome in ('applied', 'ignored', 'stale', 'staff_managed'))
);
create index billing_events_org on billing_events (org_id);
create function billing_events_guard() returns trigger language plpgsql as $$
begin
    raise exception 'a provider event is kept as it was' using errcode = 'insufficient_privilege';
end
$$;
create trigger billing_events_guard before update or delete on billing_events
    for each row execute function billing_events_guard();
alter table billing_events enable row level security;
alter table billing_events force row level security;
create policy billing_events_worker on billing_events for select to aura_worker using (true);
grant select on billing_events to aura_worker;

-- Called by the webhook receiver after it has checked the signature. Returns 'duplicate' for an event already seen, otherwise
-- the outcome it recorded. The advisory lock makes two deliveries of the same event wait for each other.
create function apply_provider_event(p_event_id text, p_type text, p_created timestamptz, p_org uuid, p_plan text,
                                     p_billing_ref text, p_now timestamptz) returns text
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_outcome text;
    v_current customers%rowtype;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_event_id, 0));
    if exists (select 1 from billing_events where provider_event_id = p_event_id) then
        return 'duplicate';
    end if;
    if p_org is null or p_plan is null or not exists (select 1 from orgs where id = p_org)
       or not exists (select 1 from plans where key = p_plan) then
        v_outcome := 'ignored';
    else
        select * into v_current from customers where org_id = p_org;
        if found and v_current.source = 'staff' then
            v_outcome := 'staff_managed';
        elsif found and v_current.provider_event_at is not null and v_current.provider_event_at >= p_created then
            v_outcome := 'stale';
        else
            insert into customers (org_id, plan, billing_ref, contract_ref, updated_by, updated_at, source, provider_event_at)
            values (p_org, p_plan, p_billing_ref, null, null, p_now, 'provider', p_created)
            on conflict (org_id) do update set plan = excluded.plan,
                billing_ref = coalesce(excluded.billing_ref, customers.billing_ref),
                updated_at = excluded.updated_at, provider_event_at = excluded.provider_event_at;
            v_outcome := 'applied';
        end if;
    end if;
    insert into billing_events (provider_event_id, event_type, org_id, provider_created_at, received_at, outcome)
    values (p_event_id, p_type, case when v_outcome = 'ignored' and not exists (select 1 from orgs where id = p_org)
                                     then null else p_org end, p_created, p_now, v_outcome);
    return v_outcome;
end
$$;
revoke all on function apply_provider_event(text, text, timestamptz, uuid, text, text, timestamptz) from public;
grant execute on function apply_provider_event(text, text, timestamptz, uuid, text, text, timestamptz) to aura_worker;
