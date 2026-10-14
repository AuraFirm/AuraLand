-- Exams (Stage 6, ADR 0032). An exam belongs to a host organization, uses released task versions as problems,
-- has a roster of people (by email) and one session per person who sits it. The rules that matter most live
-- here, in the database: a person's deadline is decided by the injected clock inside one function; a
-- candidate sees only their own session; a problem's statement is readable only during their own sitting.

create table exams (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    title text not null,
    mode text not null,
    assurance_level smallint not null default 1,
    duration_s int not null,
    window_start timestamptz not null,
    window_end timestamptz not null,
    telemetry_retention_days int not null default 180,
    state text not null default 'draft',
    grades_released_at timestamptz,
    created_by uuid not null references users (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, org_id),
    constraint exams_title check (char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]'),
    constraint exams_mode check (mode in ('ai_free', 'ai_allowed_logged')),
    -- Levels 2 and 3 (supervised, proctored) are not built.
    constraint exams_assurance check (assurance_level = 1),
    constraint exams_duration check (duration_s between 300 and 28800),
    constraint exams_window check (window_end >= window_start + make_interval(secs => duration_s)
                                   and window_end <= window_start + interval '7 days'),
    constraint exams_retention check (telemetry_retention_days between 1 and 365),
    constraint exams_state check (state in ('draft', 'scheduled', 'open', 'closed', 'released')),
    constraint exams_released check ((state = 'released') = (grades_released_at is not null))
);
create index exams_org on exams (org_id, window_start desc, id desc);
create index exams_live on exams (state, window_start) where state in ('scheduled', 'open', 'closed');
create index exams_created_by on exams (created_by);
create trigger exams_updated_at before update on exams for each row execute function set_updated_at();

create table exam_problems (
    exam_id uuid not null,
    org_id uuid not null,
    label text not null,
    task_version_id uuid not null,
    task_org_id uuid not null,
    points int not null,
    auto_percent int not null,
    rubric jsonb not null default '[]'::jsonb,
    primary key (exam_id, label),
    unique (exam_id, task_version_id),
    foreign key (exam_id, org_id) references exams (id, org_id) on delete cascade,
    foreign key (task_version_id, task_org_id) references task_versions (id, org_id),
    constraint exam_problems_label check (label ~ '^[A-Z][A-Z0-9]{0,2}$'),
    constraint exam_problems_points check (points between 1 and 1000),
    constraint exam_problems_auto check (auto_percent between 0 and 100),
    constraint exam_problems_rubric check (jsonb_typeof(rubric) = 'array' and jsonb_array_length(rubric) <= 20)
);
create index exam_problems_version on exam_problems (task_version_id, task_org_id);

create table exam_roster (
    exam_id uuid not null,
    org_id uuid not null,
    email citext not null,
    name text not null,
    extra_minutes int not null default 0,
    primary key (exam_id, email),
    foreign key (exam_id, org_id) references exams (id, org_id) on delete cascade,
    constraint exam_roster_name check (char_length(name) between 1 and 120),
    constraint exam_roster_extra check (extra_minutes between 0 and 480)
);

create table exam_sessions (
    id uuid primary key default uuidv7(),
    exam_id uuid not null,
    org_id uuid not null,
    user_id uuid not null references users (id),
    state text not null default 'invited',
    extra_minutes int not null default 0,
    consent_at timestamptz,
    consent_text_version int,
    started_at timestamptz,
    deadline_at timestamptz,
    submitted_at timestamptz,
    integrity_state text not null default 'unreviewed',
    created_at timestamptz not null,
    unique (exam_id, user_id),
    foreign key (exam_id, org_id) references exams (id, org_id) on delete cascade,
    constraint exam_sessions_state check (state in ('invited', 'consented', 'started', 'submitted', 'expired')),
    constraint exam_sessions_integrity check (integrity_state in ('unreviewed', 'clear', 'needs_review', 'confirmed', 'dismissed')),
    constraint exam_sessions_extra check (extra_minutes between 0 and 480),
    constraint exam_sessions_consent check ((consent_at is null) = (consent_text_version is null)),
    -- A session that has been consented to, started or submitted carries the facts of that step.
    constraint exam_sessions_started check ((state in ('started', 'submitted')) <= (started_at is not null and deadline_at is not null and consent_at is not null)),
    constraint exam_sessions_submitted check ((state = 'submitted') = (submitted_at is not null)),
    constraint exam_sessions_deadline check (deadline_at is null or started_at is null or deadline_at > started_at)
);
create index exam_sessions_user on exam_sessions (user_id, created_at desc);
create index exam_sessions_exam on exam_sessions (exam_id, state);
create index exam_sessions_org on exam_sessions (org_id);
create index exam_sessions_running on exam_sessions (deadline_at) where state = 'started';

-- ---- the guards -------------------------------------------------------------------------------

create function exams_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    v_kind text;
begin
    if tg_op = 'INSERT' then
        select kind into v_kind from orgs where id = new.org_id;
        if v_kind is null or v_kind = 'personal' then
            raise exception 'an exam is hosted by an organization, not a personal space' using errcode = 'check_violation';
        end if;
        if new.state <> 'draft' then
            raise exception 'an exam starts as a draft' using errcode = 'check_violation';
        end if;
        return new;
    end if;
    if new.id <> old.id or new.org_id <> old.org_id or new.created_by <> old.created_by then
        raise exception 'an exam keeps its host and author' using errcode = 'insufficient_privilege';
    end if;
    -- Everything the candidates rely on is fixed once the exam leaves draft.
    if old.state <> 'draft' and (new.title <> old.title or new.mode <> old.mode or new.duration_s <> old.duration_s
        or new.window_start <> old.window_start or new.window_end <> old.window_end
        or new.telemetry_retention_days <> old.telemetry_retention_days) then
        raise exception 'a published exam does not change' using errcode = 'insufficient_privilege';
    end if;
    if new.state <> old.state and not (old.state || '>' || new.state) = any (array[
        'draft>scheduled', 'scheduled>open', 'open>closed', 'closed>released']) then
        raise exception 'an exam cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger exams_guard before insert or update on exams for each row execute function exams_guard();

-- The problem set: draft only, released versions of the host or of the platform bank, and a rubric whose
-- points are exactly the points the judge does not decide.
create function exam_problems_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    v_state text;
    v_manual numeric;
    v_rubric int;
begin
    select state into v_state from exams where id = coalesce(new.exam_id, old.exam_id);
    if v_state is distinct from 'draft' then
        raise exception 'the problems of a published exam do not change' using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'DELETE' then
        return old;
    end if;
    v_manual := new.points * (100 - new.auto_percent) / 100.0;
    select coalesce(sum((item ->> 'max_points')::int), 0) into v_rubric from jsonb_array_elements(new.rubric) item;
    if v_rubric <> v_manual then
        raise exception 'the rubric must carry exactly the points the judge does not decide' using errcode = 'check_violation';
    end if;
    if (select count(distinct item ->> 'id') from jsonb_array_elements(new.rubric) item) <> jsonb_array_length(new.rubric) then
        raise exception 'duplicate rubric id' using errcode = 'check_violation';
    end if;
    if (select count(*) from exam_problems where exam_id = new.exam_id) >= 12 and tg_op = 'INSERT' then
        raise exception 'an exam has at most 12 problems' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger exam_problems_guard before insert or update or delete on exam_problems
    for each row execute function exam_problems_guard();

-- A session moves forward only: invited, consented, started, then submitted or expired; the person and the
-- exam never change; the deadline never moves after it is set.
create function exam_sessions_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'a session is never deleted' using errcode = 'insufficient_privilege';
    end if;
    if new.id <> old.id or new.exam_id <> old.exam_id or new.user_id <> old.user_id or new.org_id <> old.org_id then
        raise exception 'a session keeps its exam and person' using errcode = 'insufficient_privilege';
    end if;
    if old.deadline_at is not null and new.deadline_at is distinct from old.deadline_at then
        raise exception 'a deadline does not move' using errcode = 'insufficient_privilege';
    end if;
    if old.consent_at is not null and (new.consent_at is distinct from old.consent_at
       or new.consent_text_version is distinct from old.consent_text_version) then
        raise exception 'consent is given once' using errcode = 'insufficient_privilege';
    end if;
    if new.state <> old.state and not (old.state || '>' || new.state) = any (array[
        'invited>consented', 'consented>started', 'started>submitted', 'started>expired',
        'invited>expired', 'consented>expired']) then
        raise exception 'a session cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger exam_sessions_guard before update or delete on exam_sessions
    for each row execute function exam_sessions_guard();

-- ---- row-level security -----------------------------------------------------------------------

alter table exams enable row level security;
alter table exams force row level security;
alter table exam_problems enable row level security;
alter table exam_problems force row level security;
alter table exam_roster enable row level security;
alter table exam_roster force row level security;
alter table exam_sessions enable row level security;
alter table exam_sessions force row level security;

-- Is the current person on this exam's roster (by their verified email) or does he hold a session in it?
create function app_exam_candidate(p_exam uuid) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select exists (select 1 from exam_sessions where exam_id = p_exam and user_id = app_user())
        or exists (select 1 from exam_roster r join users u on u.email = r.email
                    where r.exam_id = p_exam and u.id = app_user() and u.email_verified_at is not null)
$$;
revoke all on function app_exam_candidate(uuid) from public;
grant execute on function app_exam_candidate(uuid) to aura_app;

-- Does the current person hold a session that has started in an exam that uses this version? Then the
-- statement is theirs to read, for the sitting and after it, never before.
create function app_reads_exam_problem(p_version uuid) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select exists (
        select 1 from exam_problems p
          join exams e on e.id = p.exam_id
          join exam_sessions s on s.exam_id = e.id and s.user_id = app_user()
         where p.task_version_id = p_version and e.state in ('open', 'closed', 'released')
           and s.state in ('started', 'submitted', 'expired') and s.started_at is not null)
$$;
revoke all on function app_reads_exam_problem(uuid) from public;
grant execute on function app_reads_exam_problem(uuid) to aura_app;

create policy task_versions_exam_read on task_versions for select to aura_app
    using (state = 'released' and app_reads_exam_problem(id));

create policy exams_read on exams for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin') or (state <> 'draft' and app_exam_candidate(id)));
create policy exams_insert on exams for insert to aura_app
    with check (app_org_role(org_id) in ('owner', 'admin') and created_by = app_user());
create policy exams_update on exams for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin') and state = 'draft')
    with check (app_org_role(org_id) in ('owner', 'admin') and state = 'draft');
create policy exams_worker on exams for select to aura_worker using (true);

create policy exam_problems_read on exam_problems for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin') or app_reads_exam_problem(task_version_id));
create policy exam_problems_worker on exam_problems for select to aura_worker using (true);

create policy exam_roster_read on exam_roster for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'));
create policy exam_roster_worker on exam_roster for select to aura_worker using (true);

create policy exam_sessions_read on exam_sessions for select to aura_app
    using (user_id = app_user() or app_org_role(org_id) in ('owner', 'admin'));
create policy exam_sessions_worker on exam_sessions for select to aura_worker using (true);

grant select on exams, exam_problems, exam_roster, exam_sessions to aura_app;
grant insert (org_id, title, mode, duration_s, window_start, window_end, telemetry_retention_days, created_by)
    on exams to aura_app;
grant update (title, mode, duration_s, window_start, window_end, telemetry_retention_days) on exams to aura_app;
grant select on exams, exam_problems, exam_roster, exam_sessions to aura_worker;

-- ---- staff writes, through functions ------------------------------------------------------------

create function add_exam_problem(p_exam uuid, p_label text, p_version uuid, p_points int, p_auto int, p_rubric jsonb)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_exam exams%rowtype;
    v_org uuid;
begin
    select * into v_exam from exams where id = p_exam;
    if not found or app_org_role(v_exam.org_id) is null or app_org_role(v_exam.org_id) not in ('owner', 'admin') then
        raise exception 'no such exam' using errcode = 'no_data_found';
    end if;
    select v.org_id into v_org
      from task_versions v join tasks t on t.id = v.task_id join orgs o on o.id = v.org_id
     where v.id = p_version and v.state = 'released'
       and (v.org_id = v_exam.org_id or (o.kind = 'platform' and t.visibility = 'public'));
    if v_org is null then
        raise exception 'no such released version for this exam' using errcode = 'no_data_found';
    end if;
    insert into exam_problems (exam_id, org_id, label, task_version_id, task_org_id, points, auto_percent, rubric)
    values (p_exam, v_exam.org_id, p_label, p_version, v_org, p_points, p_auto, coalesce(p_rubric, '[]'::jsonb));
end
$$;

create function remove_exam_problem(p_exam uuid, p_label text) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
begin
    select org_id into v_org from exams where id = p_exam;
    if v_org is null or app_org_role(v_org) is null or app_org_role(v_org) not in ('owner', 'admin') then
        raise exception 'no such exam' using errcode = 'no_data_found';
    end if;
    delete from exam_problems where exam_id = p_exam and label = p_label;
    if not found then
        raise exception 'no such problem' using errcode = 'no_data_found';
    end if;
end
$$;

-- Replaces the whole roster (the file is validated as a whole by the caller; the database checks the rest).
-- Until the exam opens: after that the people who sit it are fixed, though an accommodation added late
-- would be a new function, not this one.
create function set_exam_roster(p_exam uuid, p_rows jsonb) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_exam exams%rowtype;
    v_count int := jsonb_array_length(p_rows);
begin
    select * into v_exam from exams where id = p_exam for update;
    if not found or app_org_role(v_exam.org_id) is null or app_org_role(v_exam.org_id) not in ('owner', 'admin')
       or v_exam.state not in ('draft', 'scheduled') then
        raise exception 'no such exam to change the roster of' using errcode = 'no_data_found';
    end if;
    if v_count > 5000 then
        raise exception 'a roster has at most 5000 people' using errcode = 'check_violation';
    end if;
    delete from exam_roster where exam_id = p_exam;
    insert into exam_roster (exam_id, org_id, email, name, extra_minutes)
    select p_exam, v_exam.org_id, lower(r.email), r.name, coalesce(r.extra_minutes, 0)
      from jsonb_to_recordset(p_rows) as r(email text, name text, extra_minutes int);
    return v_count;
end
$$;

create function publish_exam(p_exam uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_exam exams%rowtype;
begin
    select * into v_exam from exams where id = p_exam for update;
    if not found or app_org_role(v_exam.org_id) is null or app_org_role(v_exam.org_id) not in ('owner', 'admin')
       or v_exam.state <> 'draft' then
        raise exception 'no such draft exam' using errcode = 'no_data_found';
    end if;
    if p_now >= v_exam.window_start then
        raise exception 'an exam is published before its window opens' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from exam_problems where exam_id = p_exam)
       or not exists (select 1 from exam_roster where exam_id = p_exam) then
        raise exception 'an exam needs at least one problem and one person' using errcode = 'check_violation';
    end if;
    update exams set state = 'scheduled' where id = p_exam;
end
$$;

create function release_exam_grades(p_exam uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_exam exams%rowtype;
begin
    select * into v_exam from exams where id = p_exam for update;
    if not found or app_org_role(v_exam.org_id) is null or app_org_role(v_exam.org_id) not in ('owner', 'admin')
       or v_exam.state <> 'closed' then
        raise exception 'no such closed exam' using errcode = 'no_data_found';
    end if;
    update exams set state = 'released', grades_released_at = p_now where id = p_exam;
end
$$;

-- ---- the candidate's side, with the clock ----------------------------------------------------------

-- A rostered person gets their session. Staff of the host or of a problem's organization do not sit the exam
-- they could know the answers to. Idempotent.
create function join_exam(p_exam uuid, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_exam exams%rowtype;
    v_roster exam_roster%rowtype;
    v_org uuid;
    v_id uuid;
begin
    if v_user is null then
        raise exception 'sign in to sit an exam' using errcode = 'insufficient_privilege';
    end if;
    select * into v_exam from exams where id = p_exam;
    select r.* into v_roster from exam_roster r join users u on u.email = r.email
     where r.exam_id = p_exam and u.id = v_user and u.email_verified_at is not null;
    if not found or v_exam.state not in ('scheduled', 'open') or p_now >= v_exam.window_end then
        raise exception 'no such exam for you' using errcode = 'no_data_found';
    end if;
    for v_org in select distinct o from (select v_exam.org_id as o union select task_org_id from exam_problems
                                          where exam_id = p_exam) orgs loop
        if app_org_role(v_org) in ('owner', 'admin', 'setter', 'reviewer') then
            raise exception 'staff do not sit the exam they set' using errcode = 'check_violation';
        end if;
    end loop;
    insert into exam_sessions (exam_id, org_id, user_id, extra_minutes, created_at)
    values (p_exam, v_exam.org_id, v_user, v_roster.extra_minutes, p_now)
    on conflict (exam_id, user_id) do nothing;
    select id into v_id from exam_sessions where exam_id = p_exam and user_id = v_user;
    return v_id;
end
$$;

-- Consent to the text of a version, once. Telemetry is refused for a session without it.
create function consent_exam(p_exam uuid, p_text_version int, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_session exam_sessions%rowtype;
begin
    select * into v_session from exam_sessions where exam_id = p_exam and user_id = v_user for update;
    if not found or p_text_version < 1 then
        raise exception 'no such session' using errcode = 'no_data_found';
    end if;
    if v_session.state = 'invited' then
        update exam_sessions set state = 'consented', consent_at = p_now, consent_text_version = p_text_version
         where id = v_session.id;
    elsif v_session.consent_at is null then
        raise exception 'this session can no longer be consented to' using errcode = '55000';
    end if;
end
$$;

-- Starts the sitting. The deadline is the earlier of start + duration + extra and window end + extra, decided
-- here with the given clock. Starting again returns the same session and deadline (a reconnect).
create function start_exam_session(p_exam uuid, p_now timestamptz) returns table (session_id uuid, deadline_at timestamptz)
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_exam exams%rowtype;
    v_session exam_sessions%rowtype;
    v_deadline timestamptz;
begin
    select * into v_exam from exams where id = p_exam;
    select * into v_session from exam_sessions where exam_id = p_exam and user_id = v_user for update;
    if not found or v_exam.id is null then
        raise exception 'no such session' using errcode = 'no_data_found';
    end if;
    if v_session.state in ('started', 'submitted') then
        session_id := v_session.id; deadline_at := v_session.deadline_at;
        return next;
        return;
    end if;
    if v_session.state <> 'consented' then
        raise exception 'consent comes before starting' using errcode = '55000';
    end if;
    if v_exam.state <> 'open' or p_now < v_exam.window_start or p_now >= v_exam.window_end then
        raise exception 'the exam is not open' using errcode = '55000';
    end if;
    v_deadline := least(p_now + make_interval(secs => v_exam.duration_s) + make_interval(mins => v_session.extra_minutes),
                        v_exam.window_end + make_interval(mins => v_session.extra_minutes));
    update exam_sessions set state = 'started', started_at = p_now, deadline_at = v_deadline where id = v_session.id;
    session_id := v_session.id; deadline_at := v_deadline;
    return next;
end
$$;

-- ---- the clock (worker) -----------------------------------------------------------------------------

create function advance_exams(p_now timestamptz) returns table (exam_id uuid, from_state text, to_state text)
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_exam exams%rowtype;
    v_state text;
    v_next text;
begin
    for v_exam in select * from exams where state in ('scheduled', 'open') and window_start <= p_now
                   order by window_start, id limit 200 for update skip locked loop
        v_state := v_exam.state;
        loop
            v_next := case
                when v_state = 'scheduled' and p_now >= v_exam.window_start then 'open'
                when v_state = 'open' and p_now >= v_exam.window_end then 'closed'
                else null end;
            exit when v_next is null;
            update exams set state = v_next where id = v_exam.id;
            exam_id := v_exam.id; from_state := v_state; to_state := v_next;
            return next;
            v_state := v_next;
        end loop;
    end loop;
end
$$;

-- A sitting past its deadline is over: expired, and its last acknowledged save is its answer. People who
-- never started in an exam that has closed are expired too. Returns how many.
create function advance_exam_sessions(p_now timestamptz) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_count int;
begin
    update exam_sessions set state = 'expired'
     where id in (select s.id from exam_sessions s
                   where (s.state = 'started' and s.deadline_at <= p_now)
                      or (s.state in ('invited', 'consented') and exists (
                            select 1 from exams e where e.id = s.exam_id and (e.state in ('closed', 'released') or p_now >= e.window_end)))
                   order by s.id limit 1000 for update skip locked);
    get diagnostics v_count = row_count;
    return v_count;
end
$$;

revoke all on function add_exam_problem(uuid, text, uuid, int, int, jsonb), remove_exam_problem(uuid, text),
    set_exam_roster(uuid, jsonb), publish_exam(uuid, timestamptz), release_exam_grades(uuid, timestamptz),
    join_exam(uuid, timestamptz), consent_exam(uuid, int, timestamptz), start_exam_session(uuid, timestamptz),
    advance_exams(timestamptz), advance_exam_sessions(timestamptz) from public;
grant execute on function add_exam_problem(uuid, text, uuid, int, int, jsonb), remove_exam_problem(uuid, text),
    set_exam_roster(uuid, jsonb), publish_exam(uuid, timestamptz), release_exam_grades(uuid, timestamptz),
    join_exam(uuid, timestamptz), consent_exam(uuid, int, timestamptz), start_exam_session(uuid, timestamptz) to aura_app;
grant execute on function advance_exams(timestamptz), advance_exam_sessions(timestamptz) to aura_worker;
