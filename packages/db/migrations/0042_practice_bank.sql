-- The practice bank (Stage 5, slice 12). Public tasks of platform organizations, listed by a platform
-- administrator, that any signed-in person may solve outside a contest, and the daily challenge picked from
-- them. A signed-in stranger reads a bank problem and submits to it only through the functions below: the
-- tasks and task_versions tables stay closed to people outside the task's organization, so opening the bank
-- does not open the staff routes.

create table practice_bank (
    version_id uuid primary key,
    task_id uuid not null unique,
    org_id uuid not null,
    title text not null constraint practice_bank_title check (char_length(title) between 1 and 120),
    listed_by uuid not null references users (id),
    listed_at timestamptz not null,
    foreign key (version_id, org_id) references task_versions (id, org_id)
);
create index practice_bank_listed on practice_bank (listed_at desc, version_id desc);
create index practice_bank_org on practice_bank (org_id);
create index practice_bank_listed_by on practice_bank (listed_by);

alter table practice_bank enable row level security;
alter table practice_bank force row level security;
create policy practice_bank_read on practice_bank for select to aura_app using (true);
grant select (version_id, title, listed_at) on practice_bank to aura_app;

-- A platform administrator lists a released version of a public task of a platform organization. Listing a
-- newer version of the same task replaces the older entry.
create function practice_list_version(p_version uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_row record;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only platform administrators curate the bank' using errcode = '42501';
    end if;
    select v.id, v.org_id, v.task_id, v.spec ->> 'title' as title into v_row
      from task_versions v join tasks t on t.id = v.task_id join orgs o on o.id = v.org_id
     where v.id = p_version and v.state = 'released' and t.visibility = 'public' and o.kind = 'platform';
    if not found or v_row.title is null then
        raise exception 'only a released version of a public platform task can be listed' using errcode = 'P0002';
    end if;
    insert into practice_bank (version_id, task_id, org_id, title, listed_by, listed_at)
    values (v_row.id, v_row.task_id, v_row.org_id, left(v_row.title, 120), v_user, p_now)
    on conflict (task_id) do update
        set version_id = excluded.version_id, org_id = excluded.org_id, title = excluded.title,
            listed_by = excluded.listed_by, listed_at = excluded.listed_at;
end
$$;

create function practice_unlist_version(p_version uuid) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only platform administrators curate the bank' using errcode = '42501';
    end if;
    delete from practice_bank where version_id = p_version;
    if not found then
        raise exception 'not in the bank' using errcode = 'P0002';
    end if;
end
$$;

-- What a person may read of a bank problem: the statement and limits, nothing of the tests, checker or bundle.
create function practice_problem(p_version uuid)
    returns table (title text, statement text, time_limit_ms int, memory_limit_kib int, languages jsonb)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select b.title, v.statement, (v.spec ->> 'time_limit_ms')::int, (v.spec ->> 'memory_limit_kib')::int,
           v.spec -> 'languages'
      from practice_bank b join task_versions v on v.id = b.version_id and v.org_id = b.org_id
     where b.version_id = p_version and v.state = 'released' and v.statement is not null
$$;

-- The pick of a day: the same for everyone and for every instance, from the bank as it is (the pick can
-- change within a day if the bank does). No streaks, no history.
create function practice_daily(p_day date) returns uuid
    language sql stable security definer set search_path = pg_catalog, public as $$
    select version_id from practice_bank
     order by listed_at, version_id
    offset (select abs(hashtextextended(p_day::text, 7)) % greatest(count(*), 1) from practice_bank)
     limit 1
$$;

-- A signed-in person's practice submission to a bank problem. The same bounds as the practice route for the
-- people of an organization, decided here because the person is not one of them.
create function create_practice_submission(
    p_version uuid, p_language text, p_source text, p_now timestamptz, p_ready_max int
) returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_org uuid;
    v_languages jsonb;
    v_id uuid;
begin
    if v_user is null then
        raise exception 'sign in to submit' using errcode = '42501';
    end if;
    select b.org_id, v.spec -> 'languages' into v_org, v_languages
      from practice_bank b join task_versions v on v.id = b.version_id and v.org_id = b.org_id
     where b.version_id = p_version and v.state = 'released';
    if not found then
        raise exception 'not in the practice bank' using errcode = 'P0002';
    end if;
    if not v_languages ? p_language then
        raise exception 'that language is not accepted here' using errcode = '22023';
    end if;
    if octet_length(p_source) not between 1 and 262144 or p_source ~ '\x00' then
        raise exception 'the source must be 1 byte to 256 KiB without NUL' using errcode = '22001';
    end if;
    if (select count(*) from jobs where queue = 'judge' and state = 'ready') >= p_ready_max then
        raise exception 'the judge queue is full' using errcode = '53400';
    end if;
    insert into submissions (org_id, user_id, task_version_id, context_kind, language, source,
                             source_sha256, source_bytes, created_at, updated_at)
    values (v_org, v_user, p_version, 'practice', p_language, p_source,
            sha256(convert_to(p_source, 'UTF8')), octet_length(p_source), p_now, p_now)
    returning id into v_id;
    insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
    values ('judge.tier1', v_org, jsonb_build_object('submission_id', v_id), 'judge', 5, 5, p_now,
            'submission:' || v_id::text, p_now, p_now);
    return v_id;
end
$$;

revoke all on function practice_list_version(uuid, timestamptz), practice_unlist_version(uuid),
    practice_problem(uuid), practice_daily(date),
    create_practice_submission(uuid, text, text, timestamptz, int) from public;
grant execute on function practice_list_version(uuid, timestamptz), practice_unlist_version(uuid),
    practice_problem(uuid), practice_daily(date),
    create_practice_submission(uuid, text, text, timestamptz, int) to aura_app;
