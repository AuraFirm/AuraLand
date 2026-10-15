-- Metering (Stage 9, slice 2). A usage event is one billable fact: a finished environment run, an opened employer report.
-- Events are written only by triggers on the tables that already record those facts, in the same transaction, keyed by that
-- fact's own id, so a retry, a replay or a second report cannot count twice and no code path can forget to count.

create table usage_events (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    kind text not null,
    -- The id of the fact that caused the event (the run, the view); with the kind it is unique, which is the idempotency.
    source_id uuid not null,
    occurred_at timestamptz not null,
    unique (org_id, kind, source_id),
    constraint usage_events_kind check (kind in ('env_run', 'employer_report'))
);
create index usage_events_month on usage_events (org_id, kind, occurred_at);
create function usage_events_guard() returns trigger language plpgsql as $$
begin
    raise exception 'a usage event is kept as it was' using errcode = 'insufficient_privilege';
end
$$;
create trigger usage_events_guard before update or delete on usage_events
    for each row execute function usage_events_guard();
alter table usage_events enable row level security;
alter table usage_events force row level security;
-- The money side reads events; ordinary members read counts through org_usage.
create policy usage_events_read on usage_events for select to aura_app
    using (coalesce(app_org_role(org_id) in ('owner', 'admin'), false));
create policy usage_events_worker on usage_events for select to aura_worker using (true);
grant select on usage_events to aura_app, aura_worker;

-- A run that finished (the node reported, not a sandbox error) is billable once; the trigger runs inside finish_env_run's update.
create function usage_from_env_run() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    if new.state = 'done' and old.state = 'queued' then
        insert into usage_events (org_id, kind, source_id, occurred_at)
        values (new.org_id, 'env_run', new.id, new.finished_at) on conflict do nothing;
    end if;
    return new;
end
$$;
create trigger usage_from_env_run after update on env_runs for each row execute function usage_from_env_run();

create function usage_from_credential_view() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    insert into usage_events (org_id, kind, source_id, occurred_at)
    values (new.viewer_org_id, 'employer_report', new.id, new.viewed_at) on conflict do nothing;
    return new;
end
$$;
create trigger usage_from_credential_view after insert on credential_views
    for each row execute function usage_from_credential_view();

-- What an organization used in [p_from, p_to). Any member may ask about their own organization.
create function org_usage(p_org uuid, p_from timestamptz, p_to timestamptz)
    returns table (kind text, used bigint)
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
    if app_org_role(p_org) is null then
        return;
    end if;
    return query
    select k.kind, count(e.id) from unnest(array['env_run', 'employer_report']) as k (kind)
      left join usage_events e on e.org_id = p_org and e.kind = k.kind and e.occurred_at >= p_from and e.occurred_at < p_to
     group by k.kind order by k.kind;
end
$$;
revoke all on function org_usage(uuid, timestamptz, timestamptz) from public;
grant execute on function org_usage(uuid, timestamptz, timestamptz) to aura_app;
