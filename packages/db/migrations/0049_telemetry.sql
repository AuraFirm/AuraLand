-- Telemetry (Stage 6, slice 6; ADR 0032 decision 8). Events of a sitting, accepted only from a started sitting
-- whose person consented, only in the closed list of kinds, only in small batches at a bounded rate, stored in
-- monthly range partitions and deleted when the institution's retention says so. Counts and durations only:
-- the data column never holds what a person typed or pasted.

create table telemetry_events (
    session_id uuid not null,
    org_id uuid not null,
    ts timestamptz not null,
    seq int not null,
    kind text not null,
    data jsonb not null default '{}'::jsonb,
    primary key (session_id, ts, seq),
    constraint telemetry_kind check (kind in ('focus_lost', 'focus_gained', 'fullscreen_exit', 'paste', 'copy', 'cut',
                                              'edit', 'run', 'offline', 'online')),
    constraint telemetry_data check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 1024)
) partition by range (ts);
create table telemetry_events_default partition of telemetry_events default;
create index telemetry_events_org on telemetry_events (org_id);

-- Rows leave only through purge_exam_telemetry, which says so with a setting only it can set.
create function telemetry_events_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'UPDATE' then
        raise exception 'telemetry is never changed' using errcode = 'insufficient_privilege';
    end if;
    if current_setting('aura.telemetry_purge', true) is distinct from 'on' then
        raise exception 'telemetry is deleted only by the retention job' using errcode = 'insufficient_privilege';
    end if;
    return old;
end
$$;
create trigger telemetry_events_guard before update or delete on telemetry_events
    for each row execute function telemetry_events_guard();

alter table telemetry_events enable row level security;
alter table telemetry_events force row level security;
create policy telemetry_events_read on telemetry_events for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'));
create policy telemetry_events_worker on telemetry_events for select to aura_worker using (true);
grant select on telemetry_events to aura_app, aura_worker;

-- Monthly partitions for the month of p_now and the two after it. Idempotent; the worker calls it each tick.
create function ensure_telemetry_partitions(p_now timestamptz) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_month date;
    v_created int := 0;
    v_name text;
begin
    for offset_months in 0..2 loop
        v_month := (date_trunc('month', p_now at time zone 'UTC') + make_interval(months => offset_months))::date;
        v_name := format('telemetry_events_%s', to_char(v_month, 'YYYY_MM'));
        if to_regclass(format('public.%I', v_name)) is null then
            execute format('create table public.%I partition of public.telemetry_events for values from (%L) to (%L)',
                           v_name, v_month::timestamptz, (v_month + interval '1 month')::timestamptz);
            v_created := v_created + 1;
        end if;
    end loop;
    return v_created;
end
$$;

-- Takes a batch from a sitting under way. Refusals (the route turns them into answers): 55000 not under way,
-- 42501 no consent, 54000 too many events lately (400 in ten seconds, forty a second on average), 22023 a bad batch.
create function ingest_telemetry(p_exam uuid, p_events jsonb, p_now timestamptz) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_session exam_sessions%rowtype;
    v_count int := jsonb_array_length(p_events);
    v_recent int;
    v_base int;
begin
    select * into v_session from exam_sessions where exam_id = p_exam and user_id = v_user for update;
    if not found then
        raise exception 'no such session' using errcode = 'no_data_found';
    end if;
    if v_session.consent_at is null then
        raise exception 'telemetry needs consent' using errcode = '42501';
    end if;
    if v_session.state <> 'started' or p_now >= v_session.deadline_at then
        raise exception 'the sitting is not under way' using errcode = '55000';
    end if;
    if v_count < 1 or v_count > 200 then
        raise exception 'a batch is 1 to 200 events' using errcode = '22023';
    end if;
    select count(*) into v_recent from telemetry_events where session_id = v_session.id and ts > p_now - interval '10 seconds';
    if v_recent + v_count > 400 then
        raise exception 'too many events lately' using errcode = '54000';
    end if;
    select coalesce(max(seq), 0) into v_base from telemetry_events
     where session_id = v_session.id and ts >= v_session.started_at;
    -- The page's time is a claim: it is kept only inside the sitting (never before its start, never ahead of now).
    insert into telemetry_events (session_id, org_id, ts, seq, kind, data)
    select v_session.id, v_session.org_id,
           least(p_now, greatest(v_session.started_at, to_timestamp((e.item ->> 't')::bigint / 1000.0))),
           v_base + e.n::int, e.item ->> 'kind', coalesce(e.item -> 'data', '{}'::jsonb)
      from jsonb_array_elements(p_events) with ordinality as e(item, n);
    return v_count;
end
$$;

-- Retention: rows older than their exam's retention days are deleted (a batch at a time), and a monthly partition
-- that ended more than a year and a month ago is dropped whole. Returns the rows deleted.
create function purge_exam_telemetry(p_now timestamptz, p_batch int) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_deleted int;
    v_partition record;
begin
    perform set_config('aura.telemetry_purge', 'on', true);
    with expired as (
        select t.session_id, t.ts, t.seq
          from telemetry_events t
          join exam_sessions s on s.id = t.session_id
          join exams e on e.id = s.exam_id
         where t.ts < p_now - make_interval(days => e.telemetry_retention_days)
         limit greatest(p_batch, 1))
    delete from telemetry_events t using expired x
     where t.session_id = x.session_id and t.ts = x.ts and t.seq = x.seq;
    get diagnostics v_deleted = row_count;
    for v_partition in
        select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
         where i.inhparent = 'telemetry_events'::regclass and c.relname ~ '^telemetry_events_[0-9]{4}_[0-9]{2}$'
           and to_date(substr(c.relname, 18), 'YYYY_MM') + interval '1 month' < (p_now - interval '365 days')::date loop
        execute format('drop table public.%I', v_partition.relname);
    end loop;
    return v_deleted;
end
$$;

revoke all on function ensure_telemetry_partitions(timestamptz), ingest_telemetry(uuid, jsonb, timestamptz),
    purge_exam_telemetry(timestamptz, int) from public;
grant execute on function ingest_telemetry(uuid, jsonb, timestamptz) to aura_app;
grant execute on function ensure_telemetry_partitions(timestamptz), purge_exam_telemetry(timestamptz, int) to aura_worker;
