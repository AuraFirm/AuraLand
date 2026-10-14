-- Grading an exam (Stage 6, slice 5b; ADR 0032 decision 12). A problem's points are split between what the judge
-- awards (auto_percent, from the submission's score) and rubric items a person scores. The host's owners and
-- admins score the rubric while the exam is closed; releasing the grades freezes them and opens the results to the
-- candidates. A release waits until every answer has been judged.

create table exam_grades (
    session_id uuid not null references exam_sessions (id),
    problem_label text not null,
    org_id uuid not null,
    rubric_scores jsonb not null default '{}'::jsonb,
    comment text not null default '',
    graded_by uuid not null references users (id),
    graded_at timestamptz not null,
    primary key (session_id, problem_label),
    constraint exam_grades_scores check (jsonb_typeof(rubric_scores) = 'object'),
    constraint exam_grades_comment check (char_length(comment) <= 2000 and comment !~ '\x00')
);
create index exam_grades_org on exam_grades (org_id);
create index exam_grades_graded_by on exam_grades (graded_by);

-- Grades change only while the exam is closed.
create function exam_grades_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    v_state text;
begin
    select e.state into v_state from exam_sessions s join exams e on e.id = s.exam_id
     where s.id = coalesce(new.session_id, old.session_id);
    if v_state is distinct from 'closed' then
        raise exception 'grades change only while the exam is closed' using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'DELETE' then
        raise exception 'a grade is not deleted' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger exam_grades_guard before insert or update or delete on exam_grades
    for each row execute function exam_grades_guard();

alter table exam_grades enable row level security;
alter table exam_grades force row level security;
create policy exam_grades_read on exam_grades for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')
           or exists (select 1 from exam_sessions s where s.id = session_id and s.user_id = app_user() and app_exam_released(s.exam_id)));
create policy exam_grades_worker on exam_grades for select to aura_worker using (true);
grant select on exam_grades to aura_app, aura_worker;

-- Scores one answer's rubric. Every item named must exist in the problem's rubric and be between 0 and its
-- maximum; items not named score zero. Re-grading before release replaces the earlier scores.
create function grade_exam_answer(p_exam uuid, p_session uuid, p_label text, p_scores jsonb, p_comment text, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_exam exams%rowtype;
    v_problem exam_problems%rowtype;
    v_key text;
begin
    select * into v_exam from exams where id = p_exam;
    if not found or app_org_role(v_exam.org_id) is null or app_org_role(v_exam.org_id) not in ('owner', 'admin') then
        raise exception 'no such exam' using errcode = 'no_data_found';
    end if;
    select * into v_problem from exam_problems where exam_id = p_exam and label = p_label;
    if not found or not exists (select 1 from exam_sessions where id = p_session and exam_id = p_exam) then
        raise exception 'no such answer' using errcode = 'no_data_found';
    end if;
    if v_exam.state <> 'closed' then
        raise exception 'grades change only while the exam is closed' using errcode = '55000';
    end if;
    for v_key in select jsonb_object_keys(p_scores) loop
        if not exists (select 1 from jsonb_array_elements(v_problem.rubric) item
                        where item ->> 'id' = v_key
                          and jsonb_typeof(p_scores -> v_key) = 'number'
                          and (p_scores ->> v_key)::numeric = trunc((p_scores ->> v_key)::numeric)
                          and (p_scores ->> v_key)::int between 0 and (item ->> 'max_points')::int) then
            raise exception 'a rubric score names an item of this problem and is a whole number from 0 to its maximum'
                using errcode = 'check_violation';
        end if;
    end loop;
    insert into exam_grades (session_id, problem_label, org_id, rubric_scores, comment, graded_by, graded_at)
    values (p_session, p_label, v_exam.org_id, p_scores, p_comment, v_user, p_now)
    on conflict (session_id, problem_label) do update
        set rubric_scores = excluded.rubric_scores, comment = excluded.comment, graded_by = excluded.graded_by, graded_at = excluded.graded_at;
end
$$;

-- Everything the grader needs about every answer: who, which problem, what the judge said, what has been scored.
-- Staff only. A person who did not answer a problem still has a row (nothing submitted, zero from the judge).
create function exam_grading_rows(p_exam uuid)
    returns table (session_id uuid, email text, name text, session_state text, label text, points int,
                   auto_percent int, rubric jsonb, submission_id uuid, submission_state text, verdict text,
                   score numeric, rubric_scores jsonb, comment text)
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
    if not exists (select 1 from exams where id = p_exam and app_org_role(org_id) in ('owner', 'admin')) then
        raise exception 'no such exam' using errcode = 'no_data_found';
    end if;
    return query
    select s.id, u.email::text, coalesce(r.name, u.email::text), s.state, p.label, p.points, p.auto_percent, p.rubric,
           a.submission_id, sub.state, sub.verdict, sub.score, coalesce(g.rubric_scores, '{}'::jsonb), coalesce(g.comment, '')
      from exam_sessions s
      join users u on u.id = s.user_id
      left join exam_roster r on r.exam_id = s.exam_id and r.email = u.email
      join exam_problems p on p.exam_id = s.exam_id
      left join exam_answers a on a.session_id = s.id and a.problem_label = p.label
      left join submissions sub on sub.id = a.submission_id
      left join exam_grades g on g.session_id = s.id and g.problem_label = p.label
     where s.exam_id = p_exam and s.started_at is not null
     order by u.email, p.label limit 100000;
end
$$;

-- Releasing waits for every answer to be judged: a grade released over a verdict that is still coming is a wrong grade.
create or replace function release_exam_grades(p_exam uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_exam exams%rowtype;
begin
    select * into v_exam from exams where id = p_exam for update;
    if not found or app_org_role(v_exam.org_id) is null or app_org_role(v_exam.org_id) not in ('owner', 'admin')
       or v_exam.state <> 'closed' then
        raise exception 'no such closed exam' using errcode = 'no_data_found';
    end if;
    if exists (select 1 from exam_sessions where exam_id = p_exam and state in ('started'))
       or exists (select 1 from exam_sessions s where s.exam_id = p_exam and s.state in ('submitted', 'expired') and exists (
                    select 1 from exam_drafts d where d.session_id = s.id
                     and not exists (select 1 from exam_answers a where a.session_id = s.id and a.problem_label = d.problem_label)))
       or exists (select 1 from exam_answers a join submissions sub on sub.id = a.submission_id
                   where a.session_id in (select id from exam_sessions where exam_id = p_exam) and sub.state in ('queued', 'judging')) then
        raise exception 'answers are still being collected or judged' using errcode = '55000';
    end if;
    update exams set state = 'released', grades_released_at = p_now where id = p_exam;
end
$$;

revoke all on function grade_exam_answer(uuid, uuid, text, jsonb, text, timestamptz), exam_grading_rows(uuid) from public;
grant execute on function grade_exam_answer(uuid, uuid, text, jsonb, text, timestamptz), exam_grading_rows(uuid) to aura_app;

-- After release a candidate reads the link from their own answers to their submissions (the results page).
drop policy exam_answers_read on exam_answers;
create policy exam_answers_read on exam_answers for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')
           or exists (select 1 from exam_sessions s where s.id = session_id and s.user_id = app_user() and app_exam_released(s.exam_id)));
