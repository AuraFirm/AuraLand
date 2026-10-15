-- Credentials from events (Stage 7, ADR 0033): the worker finds finished events that have not yet been turned into
-- credentials and reads what it needs. Reading, never deciding: the rules (who earns what) are in the application, and
-- every credential is recorded by insert_credential, which is idempotent.

create table passport_events_done (
    kind text not null,
    event_id uuid not null,
    issued int not null,
    done_at timestamptz not null,
    primary key (kind, event_id),
    constraint passport_events_done_kind check (kind in ('contest', 'exam')),
    constraint passport_events_done_issued check (issued >= 0)
);
alter table passport_events_done enable row level security;
alter table passport_events_done force row level security;
create policy passport_events_done_worker on passport_events_done for select to aura_worker using (true);
grant select on passport_events_done to aura_worker;

create function mark_passport_event_done(p_kind text, p_event uuid, p_issued int, p_now timestamptz) returns void
    language sql security definer set search_path = pg_catalog, public as $$
    insert into passport_events_done (kind, event_id, issued, done_at) values (p_kind, p_event, p_issued, p_now)
    on conflict (kind, event_id) do nothing
$$;

-- The oldest rated, finalized contest that has not been turned into credentials. A contest too small to be rated
-- earns none.
create function next_passport_contest() returns table (contest_id uuid, org_id uuid, title text, host_name text, finalized_at timestamptz)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select c.id, c.org_id, c.title, o.name, c.finalized_at
      from contests c
      join orgs o on o.id = c.org_id
      join contest_ratings r on r.contest_id = c.id and r.dimension = 'contest' and r.status = 'rated'
     where c.rated and c.state = 'finalized'
       and not exists (select 1 from passport_events_done d where d.kind = 'contest' and d.event_id = c.id)
     order by c.finalized_at, c.id limit 1
$$;

create function next_passport_exam() returns table (exam_id uuid, org_id uuid, title text, mode text, host_name text,
                                                    assurance_level int, released_at timestamptz)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select e.id, e.org_id, e.title, e.mode, o.name, e.assurance_level::int, e.grades_released_at
      from exams e
      join orgs o on o.id = e.org_id
     where e.state = 'released'
       and not exists (select 1 from passport_events_done d where d.kind = 'exam' and d.event_id = e.id)
     order by e.grades_released_at, e.id limit 1
$$;

-- What the points of an exam are made of, for each person who sat it. `blocked` is true while a person has an
-- integrity flag that someone confirmed and no appeal overturned: such a person earns no exam credential.
create function passport_exam_rows(p_exam uuid)
    returns table (user_id uuid, label text, points int, auto_percent int, rubric jsonb, judge_score numeric,
                   rubric_scores jsonb, blocked boolean)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select s.user_id, p.label, p.points, p.auto_percent, p.rubric,
           case when sub.state = 'judged' then sub.score end,
           coalesce(g.rubric_scores, '{}'::jsonb),
           exists (select 1 from integrity_flags f where f.session_id = s.id and f.state = 'confirmed')
      from exam_sessions s
      join exam_problems p on p.exam_id = s.exam_id
      left join exam_answers a on a.session_id = s.id and a.problem_label = p.label
      left join submissions sub on sub.id = a.submission_id
      left join exam_grades g on g.session_id = s.id and g.problem_label = p.label
     where s.exam_id = p_exam and s.started_at is not null and s.state in ('submitted', 'expired')
     order by s.user_id, p.label limit 200000
$$;

revoke all on function mark_passport_event_done(text, uuid, int, timestamptz), next_passport_contest(), next_passport_exam(),
    passport_exam_rows(uuid) from public;
grant execute on function mark_passport_event_done(text, uuid, int, timestamptz), next_passport_contest(),
    next_passport_exam(), passport_exam_rows(uuid) to aura_worker;

-- A development signer lives in a process's memory, so every restart makes a new key. The worker of a development or
-- test environment retires the previous development key and registers the new one; retired keys keep verifying what
-- they signed. This works on 'development' keys only: a production key is never touched here (rotation is a person's).
create function register_development_signing_key(p_kid text, p_jwk jsonb, p_now timestamptz) returns boolean
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    if exists (select 1 from signing_keys where kid = p_kid) then
        return false;
    end if;
    update signing_keys set status = 'retired', retired_at = p_now where environment = 'development' and status = 'active';
    insert into signing_keys (kid, alg, public_jwk, environment, not_before) values (p_kid, 'ES256', p_jwk, 'development', p_now);
    return true;
end
$$;
revoke all on function register_development_signing_key(text, jsonb, timestamptz) from public;
grant execute on function register_development_signing_key(text, jsonb, timestamptz) to aura_worker;
