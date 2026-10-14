-- Handing in and judging an exam (Stage 6, slice 5a; ADR 0032 decision 12).
--   * a candidate may hand in early (submit_exam_session); the clock expires the rest at their deadline;
--   * when a sitting is over, the worker turns each problem's final saved draft into a judged submission of
--     context 'exam' (queue priority 2: after contests, before practice), recorded in exam_answers;
--   * a candidate cannot see the verdict, score or per-test results of their exam submissions until the exam's
--     grades are released; the host's owners and admins can at any time; nobody else, including the staff of the
--     organization that owns the task.
-- Submissions now point at their contest or exam by context_id with no foreign key (it can name either table);
-- a trigger checks the pairing on insert, and only the definer functions insert contest or exam submissions.

alter table submissions drop constraint submissions_context_id_fkey;
alter table submissions drop constraint submissions_context;
alter table submissions add constraint submissions_context check (
    context_kind in ('practice', 'contest', 'exam') and ((context_kind = 'practice') = (context_id is null)));

create function submissions_context_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    if new.context_kind = 'contest' and not exists (select 1 from contests where id = new.context_id) then
        raise exception 'a contest submission names a contest' using errcode = 'check_violation';
    end if;
    if new.context_kind = 'exam' and not exists (select 1 from exams where id = new.context_id) then
        raise exception 'an exam submission names an exam' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger submissions_context_guard before insert on submissions
    for each row execute function submissions_context_guard();

create function app_exam_staff(p_exam uuid) returns boolean language sql stable security definer
    set search_path = pg_catalog, public as $$
    select exists (select 1 from exams where id = p_exam and app_org_role(org_id) in ('owner', 'admin'))
$$;
create function app_exam_released(p_exam uuid) returns boolean language sql stable security definer
    set search_path = pg_catalog, public as $$
    select exists (select 1 from exams where id = p_exam and state = 'released')
$$;
revoke all on function app_exam_staff(uuid), app_exam_released(uuid) from public;
grant execute on function app_exam_staff(uuid), app_exam_released(uuid) to aura_app;

drop policy submissions_read on submissions;
create policy submissions_read on submissions for select to aura_app
    using (case when context_kind = 'exam'
                then app_exam_staff(context_id) or (user_id = app_user() and app_exam_released(context_id))
                else user_id = app_user() or app_org_role(org_id) in ('owner', 'admin') end);

drop policy verdict_details_read on verdict_details;
create policy verdict_details_read on verdict_details for select to aura_app
    using (exists (select 1 from submissions s where s.id = submission_id
                   and case when s.context_kind = 'exam' then app_exam_staff(s.context_id) or app_exam_released(s.context_id)
                            else s.context_id is null or app_contest_over(s.context_id) end));

create table exam_answers (
    session_id uuid not null references exam_sessions (id),
    problem_label text not null,
    org_id uuid not null,
    submission_id uuid not null unique references submissions (id),
    created_at timestamptz not null,
    primary key (session_id, problem_label)
);
create index exam_answers_org on exam_answers (org_id);
alter table exam_answers enable row level security;
alter table exam_answers force row level security;
create policy exam_answers_read on exam_answers for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'));
create policy exam_answers_worker on exam_answers for select to aura_worker using (true);
grant select on exam_answers to aura_app, aura_worker;

-- A candidate hands in early. At or after the deadline it is too late: the sitting is only expired.
create function submit_exam_session(p_exam uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_session exam_sessions%rowtype;
begin
    select * into v_session from exam_sessions where exam_id = p_exam and user_id = v_user for update;
    if not found then
        raise exception 'no such session' using errcode = 'no_data_found';
    end if;
    if v_session.state = 'submitted' then
        return;
    end if;
    if v_session.state <> 'started' or p_now >= v_session.deadline_at then
        raise exception 'the sitting is not under way' using errcode = '55000';
    end if;
    update exam_sessions set state = 'submitted', submitted_at = p_now where id = v_session.id;
end
$$;

-- The worker's batch: for sittings that are over, queue each problem's final draft for judging. Returns how many
-- answers were queued; stops short (and says so by returning fewer) when the judge queue is full, to try again.
create function queue_exam_answers(p_now timestamptz, p_ready_max int) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_session record;
    v_draft record;
    v_problem exam_problems%rowtype;
    v_id uuid;
    v_count int := 0;
begin
    for v_session in
        select s.id, s.user_id, s.exam_id, s.org_id from exam_sessions s
         where s.state in ('submitted', 'expired') and s.started_at is not null
           and exists (select 1 from exam_drafts d where d.session_id = s.id
                        and not exists (select 1 from exam_answers a where a.session_id = s.id and a.problem_label = d.problem_label))
         order by s.id limit 100 for update skip locked loop
        for v_draft in
            select distinct on (d.problem_label) d.problem_label, d.language, d.content
              from exam_drafts d
             where d.session_id = v_session.id
               and not exists (select 1 from exam_answers a where a.session_id = v_session.id and a.problem_label = d.problem_label)
             order by d.problem_label, d.seq desc loop
            if (select count(*) from jobs where queue = 'judge' and state = 'ready') >= p_ready_max then
                return v_count;
            end if;
            select * into v_problem from exam_problems where exam_id = v_session.exam_id and label = v_draft.problem_label;
            insert into submissions (org_id, user_id, task_version_id, context_kind, context_id, language, source,
                                     source_sha256, source_bytes, created_at, updated_at)
            values (v_problem.task_org_id, v_session.user_id, v_problem.task_version_id, 'exam', v_session.exam_id,
                    v_draft.language, v_draft.content, sha256(convert_to(v_draft.content, 'UTF8')),
                    greatest(octet_length(v_draft.content), 1), p_now, p_now)
            returning id into v_id;
            insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
            values ('judge.tier1', v_problem.task_org_id, jsonb_build_object('submission_id', v_id), 'judge', 2, 5, p_now,
                    'submission:' || v_id::text, p_now, p_now);
            insert into exam_answers (session_id, problem_label, org_id, submission_id, created_at)
            values (v_session.id, v_draft.problem_label, v_session.org_id, v_id, p_now);
            v_count := v_count + 1;
        end loop;
    end loop;
    return v_count;
end
$$;

revoke all on function submit_exam_session(uuid, timestamptz), queue_exam_answers(timestamptz, int) from public;
grant execute on function submit_exam_session(uuid, timestamptz) to aura_app;
grant execute on function queue_exam_answers(timestamptz, int) to aura_worker;
