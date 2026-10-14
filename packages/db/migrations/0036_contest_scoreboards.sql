-- Contest scoreboards (Stage 5, slice 5; ADR 0031 decision 10).
--   * contest_scoreboards holds the rendered board of each contest, one row per view ('public' stops at the
--     freeze, 'final' is everything). Only the worker writes it, and only through store_contest_scoreboard,
--     so a reader (slice 6) can trust that a row is a fold of the judged-submission log;
--   * the row is rewritten only when its etag changes, and `version` counts those changes, so a client
--     with an etag knows nothing happened and a push channel can be woken exactly when something did;
--   * `stamp` names the input the board was built from (state, judged count, newest update), so the tick
--     skips a contest nothing happened to. A rejudge moves updated_at, so it changes the stamp too;
--   * the worker reads the judged log through scoreboard_input, which returns only what the fold needs
--     and, per person, a name only when their profile is public.

create table contest_scoreboards (
    contest_id uuid not null references contests (id) on delete cascade,
    org_id uuid not null references orgs (id),
    view text not null constraint contest_scoreboards_view check (view in ('public', 'final')),
    version integer not null constraint contest_scoreboards_version check (version >= 1),
    etag text not null constraint contest_scoreboards_etag check (etag ~ '^[0-9a-f]{64}$'),
    stamp text not null,
    body jsonb not null,
    updated_at timestamptz not null,
    primary key (contest_id, view)
);
create index contest_scoreboards_org on contest_scoreboards (org_id);

alter table contest_scoreboards enable row level security;
alter table contest_scoreboards force row level security;
-- Whoever can see a contest may read its public board; its host's owners and admins may read the final one.
-- Nothing is granted to aura_app yet (slice 6 adds the read path), so the policy is the rule waiting for
-- that grant. The worker reaches the table only through the functions below.
create policy contest_scoreboards_read on contest_scoreboards for select to aura_app
    using (exists (select 1 from contests c where c.id = contest_id)
           and (view = 'public' or app_org_role(org_id) in ('owner', 'admin')));

-- Contests whose board may be out of date: live or finished, and the stamp of their input differs from the
-- stamp of the stored board (or there is none). Oldest first, so no contest starves.
create function scoreboard_stamp(p_contest uuid) returns text
    language sql stable security definer set search_path = pg_catalog, public as $$
    select c.state || ':' || count(s.id)::text || ':' || coalesce(max(s.updated_at)::text, '')
      from contests c
      left join submissions s on s.context_id = c.id and s.state = 'judged'
     where c.id = p_contest
     group by c.state
$$;

create function scoreboard_work(p_limit int) returns table (contest_id uuid)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select c.id
      from contests c
      left join contest_scoreboards b on b.contest_id = c.id and b.view = 'public'
     where c.state in ('running', 'frozen', 'ended', 'finalized')
       and b.stamp is distinct from scoreboard_stamp(c.id)
     order by c.starts_at, c.id
     limit least(greatest(p_limit, 1), 100)
$$;

-- Everything the fold needs, as one document: the contest's clock and rules, its problems, its
-- registrants in registration order (with a name only for a public profile) and its judged submissions.
create function scoreboard_input(p_contest uuid) returns jsonb
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
    v_contest contests%rowtype;
    v_result jsonb;
begin
    select * into v_contest from contests where id = p_contest;
    if not found or v_contest.state not in ('running', 'frozen', 'ended', 'finalized') then
        raise exception 'no scoreboard for this contest' using errcode = 'P0002';
    end if;
    select jsonb_build_object(
        'contest_id', v_contest.id,
        'org_id', v_contest.org_id,
        'format', v_contest.rules ->> 'format',
        'penalty_minutes_per_wrong', coalesce((v_contest.rules ->> 'penalty_minutes_per_wrong')::int, 0),
        'starts_at_ms', (extract(epoch from v_contest.starts_at) * 1000)::bigint,
        'ends_at_ms', (extract(epoch from v_contest.ends_at) * 1000)::bigint,
        'freeze_at_ms', (extract(epoch from v_contest.freeze_at) * 1000)::bigint,
        'stamp', scoreboard_stamp(p_contest),
        'problems', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'points', points) order by label)
                                from contest_problems where contest_id = p_contest), '[]'::jsonb),
        'registrants', coalesce((select jsonb_agg(jsonb_build_object(
                'user_id', r.user_id, 'order', r.ord - 1,
                'handle', case when p.visibility = 'public' then p.handle::text end,
                'display_name', case when p.visibility = 'public' then p.display_name end) order by r.ord)
            from (select user_id, row_number() over (order by created_at, user_id) as ord
                    from registrations where contest_id = p_contest) r
            left join profiles p on p.user_id = r.user_id), '[]'::jsonb),
        'events', coalesce((select jsonb_agg(jsonb_build_object(
                'user_id', s.user_id, 'label', cp.label,
                'submitted_at_ms', (extract(epoch from s.created_at) * 1000)::bigint,
                'verdict', s.verdict, 'score', s.score) order by s.created_at, s.id)
            from submissions s
            join contest_problems cp on cp.contest_id = p_contest and cp.task_version_id = s.task_version_id
            where s.context_id = p_contest and s.state = 'judged'), '[]'::jsonb))
    into v_result;
    return v_result;
end
$$;

-- Stores one rendered board per view. Rewrites a row only when its etag changed (bumping `version`), and
-- always records the stamp, so an unchanged board is not written again. Returns whether any view changed.
create function store_contest_scoreboard(
    p_contest uuid, p_stamp text, p_now timestamptz,
    p_public_etag text, p_public_body jsonb, p_final_etag text, p_final_body jsonb
) returns boolean
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
    v_changed boolean := false;
    v_view text;
    v_etag text;
    v_body jsonb;
    v_old text;
begin
    select org_id into v_org from contests where id = p_contest;
    if v_org is null then
        raise exception 'no such contest' using errcode = 'P0002';
    end if;
    foreach v_view in array array['public', 'final'] loop
        v_etag := case v_view when 'public' then p_public_etag else p_final_etag end;
        v_body := case v_view when 'public' then p_public_body else p_final_body end;
        select etag into v_old from contest_scoreboards where contest_id = p_contest and view = v_view;
        if v_old is null then
            insert into contest_scoreboards (contest_id, org_id, view, version, etag, stamp, body, updated_at)
            values (p_contest, v_org, v_view, 1, v_etag, p_stamp, v_body, p_now);
            v_changed := true;
        elsif v_old <> v_etag then
            update contest_scoreboards set version = version + 1, etag = v_etag, stamp = p_stamp, body = v_body,
                   updated_at = p_now where contest_id = p_contest and view = v_view;
            v_changed := true;
        else
            update contest_scoreboards set stamp = p_stamp where contest_id = p_contest and view = v_view;
        end if;
    end loop;
    return v_changed;
end
$$;

revoke all on function scoreboard_stamp(uuid), scoreboard_work(int), scoreboard_input(uuid),
    store_contest_scoreboard(uuid, text, timestamptz, text, jsonb, text, jsonb) from public;
grant execute on function scoreboard_work(int), scoreboard_input(uuid),
    store_contest_scoreboard(uuid, text, timestamptz, text, jsonb, text, jsonb) to aura_worker;
