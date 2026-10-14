-- Contest submissions (Stage 5, ADR 0031 decisions 2, 8 and 11).
--   * a submission may belong to a contest (context_id); it is created only by create_contest_submission,
--     which takes the injected clock and checks registration, window, problem, language and the interval
--     between a person's submissions to one problem. The app role keeps no way to insert one directly;
--   * while the contest lasts, nobody reads a contest submission's per-test results (only its verdict and
--     score), so the hidden tests cannot be probed one by one; they open when the contest ends;
--   * practice submissions to a problem of a contest that has not ended are refused for everyone, or the
--     contest's rules and the hidden-results rule could be walked around by anyone who can read the task;
--   * contest submissions are judged before practice ones, and practice is shed first when the queue is long.

alter table submissions add column context_id uuid references contests (id);
alter table submissions drop constraint submissions_context;
alter table submissions add constraint submissions_context check (
    context_kind in ('practice', 'contest') and ((context_kind = 'contest') = (context_id is not null)));
create index submissions_contest on submissions (context_id, user_id, task_version_id, created_at desc)
    where context_id is not null;

grant select (context_id) on submissions to aura_app;

-- The app role inserts practice submissions only (it has no column grant for the context anyway).
drop policy submissions_insert on submissions;
create policy submissions_insert on submissions for insert to aura_app
    with check (user_id = app_user() and app_org_role(org_id) is not null and context_kind = 'practice');

-- The host's owners and admins read the submissions of their contest, whatever organization owns the problem.
create policy submissions_host_read on submissions for select to aura_app
    using (context_id is not null
           and exists (select 1 from contests c where c.id = context_id and app_org_role(c.org_id) in ('owner', 'admin')));

-- Has the contest ended (ended or finalized)? Per-test results are readable only then.
create function app_contest_over(p_contest uuid) returns boolean language sql stable security definer
    set search_path = pg_catalog, public as $$
    select exists (select 1 from contests where id = p_contest and state in ('ended', 'finalized'))
$$;
revoke all on function app_contest_over(uuid) from public;
grant execute on function app_contest_over(uuid) to aura_app;

drop policy verdict_details_read on verdict_details;
create policy verdict_details_read on verdict_details for select to aura_app
    using (exists (select 1 from submissions s where s.id = submission_id
                   and (s.context_id is null or app_contest_over(s.context_id))));

-- Practice submissions to a problem of a contest that has not ended are closed.
create function submissions_contest_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    if new.context_kind = 'practice' and exists (
        select 1 from contest_problems p join contests c on c.id = p.contest_id
         where p.task_version_id = new.task_version_id and c.state in ('scheduled', 'running', 'frozen')
    ) then
        raise exception 'this problem belongs to a contest that has not ended' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger submissions_contest_guard before insert on submissions
    for each row execute function submissions_contest_guard();

-- A submission to a contest problem. Returns the submission id. Refusals use distinct codes so the
-- route can answer honestly: 55000 the contest is not accepting submissions, 22023 the language is not
-- allowed, 54000 too soon after the last submission to this problem (the hint says how many seconds),
-- 53400 the queue is full, 22001 the source is too large.
create function create_contest_submission(
    p_contest uuid, p_label text, p_language text, p_source text, p_now timestamptz, p_ready_max int
) returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_contest contests%rowtype;
    v_problem contest_problems%rowtype;
    v_interval_s int;
    v_last timestamptz;
    v_id uuid;
begin
    if v_user is null then
        raise exception 'sign in to submit' using errcode = 'insufficient_privilege';
    end if;
    select * into v_contest from contests where id = p_contest;
    if not found or not exists (select 1 from registrations where contest_id = p_contest and user_id = v_user) then
        raise exception 'no such contest for you' using errcode = 'no_data_found';
    end if;
    if v_contest.state not in ('running', 'frozen') or p_now < v_contest.starts_at or p_now >= v_contest.ends_at then
        raise exception 'the contest is not accepting submissions' using errcode = '55000';
    end if;
    select * into v_problem from contest_problems where contest_id = p_contest and label = p_label;
    if not found then
        raise exception 'no such problem' using errcode = 'no_data_found';
    end if;
    if not (v_contest.rules -> 'languages') ? p_language then
        raise exception 'that language is not allowed in this contest' using errcode = '22023';
    end if;
    if octet_length(p_source) not between 1 and 262144 or p_source ~ '\x00' then
        raise exception 'the source must be 1 byte to 256 KiB without NUL' using errcode = '22001';
    end if;
    v_interval_s := coalesce((v_contest.rules ->> 'submit_interval_s')::int, 10);
    select max(created_at) into v_last from submissions
     where user_id = v_user and context_id = p_contest and task_version_id = v_problem.task_version_id;
    if v_last is not null and p_now < v_last + make_interval(secs => v_interval_s) then
        raise exception 'too soon after your last submission to this problem' using errcode = '54000',
            hint = ceil(extract(epoch from (v_last + make_interval(secs => v_interval_s) - p_now)))::int::text;
    end if;
    if (select count(*) from jobs where queue = 'judge' and state = 'ready') >= p_ready_max then
        raise exception 'the judge queue is full' using errcode = 'configuration_limit_exceeded';
    end if;
    insert into submissions (org_id, user_id, task_version_id, context_kind, context_id, language, source,
                             source_sha256, source_bytes, created_at, updated_at)
    values (v_problem.task_org_id, v_user, v_problem.task_version_id, 'contest', p_contest, p_language, p_source,
            sha256(convert_to(p_source, 'UTF8')), octet_length(p_source), p_now, p_now)
    returning id into v_id;
    insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
    values ('judge.tier1', v_problem.task_org_id, jsonb_build_object('submission_id', v_id), 'judge', 1, 5, p_now,
            'submission:' || v_id::text, p_now, p_now);
    return v_id;
end
$$;
revoke all on function create_contest_submission(uuid, text, text, text, timestamptz, int) from public;
grant execute on function create_contest_submission(uuid, text, text, text, timestamptz, int) to aura_app;
