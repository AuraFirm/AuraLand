-- Oral defence v1 (Stage 6, slice 10): for a chosen answer, a language model proposes three to five questions about
-- the candidate's own code, the candidate answers in writing, and a person scores the answers. The model scores
-- nothing: the only writer of `score` is score_oral_defence, which only staff can call. Questions arrive here
-- already checked against a strict schema by the application; the database checks their shape again.

create table oral_defences (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    exam_id uuid not null references exams (id),
    session_id uuid not null references exam_sessions (id),
    problem_label text not null,
    submission_id uuid not null references submissions (id),
    state text not null default 'pending',
    prompt_version int not null,
    questions jsonb,
    answers jsonb,
    failure text not null default '',
    requested_by uuid not null references users (id),
    requested_at timestamptz not null,
    claimed_at timestamptz,
    generated_at timestamptz,
    answered_at timestamptz,
    score int,
    score_note text not null default '',
    scored_by uuid references users (id),
    scored_at timestamptz,
    unique (session_id, problem_label),
    constraint oral_state check (state in ('pending', 'generating', 'ready', 'answered', 'scored', 'failed')),
    constraint oral_questions check (questions is null or (jsonb_typeof(questions) = 'array'
        and jsonb_array_length(questions) between 3 and 5 and pg_column_size(questions) <= 4096)),
    constraint oral_answers check (answers is null or (jsonb_typeof(answers) = 'array'
        and jsonb_array_length(answers) = jsonb_array_length(questions) and pg_column_size(answers) <= 16384)),
    constraint oral_score check (score is null or score between 0 and 100),
    constraint oral_scored check ((state = 'scored') = (score is not null) and (state = 'scored') = (scored_by is not null)),
    constraint oral_texts check (char_length(failure) <= 500 and char_length(score_note) <= 2000
        and failure !~ '\x00' and score_note !~ '\x00')
);
create index oral_defences_exam on oral_defences (exam_id, id);
create index oral_defences_org on oral_defences (org_id);
create index oral_defences_submission on oral_defences (submission_id);
create index oral_defences_requested_by on oral_defences (requested_by);
create index oral_defences_scored_by on oral_defences (scored_by);

create function oral_defences_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'oral defences are kept' using errcode = 'insufficient_privilege';
    end if;
    if new.session_id <> old.session_id or new.problem_label <> old.problem_label
       or new.submission_id <> old.submission_id then
        raise exception 'an oral defence stays with its answer' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger oral_defences_guard before update or delete on oral_defences
    for each row execute function oral_defences_guard();

alter table oral_defences enable row level security;
alter table oral_defences force row level security;
create policy oral_defences_read on oral_defences for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'));
grant select on oral_defences to aura_app;

-- Staff choose an answer to question. Asking again after a failure starts over; otherwise once.
create function request_oral_defence(p_exam uuid, p_session uuid, p_label text, p_prompt_version int, p_now timestamptz)
    returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_exam exams%rowtype := integrity_staff_exam(p_exam);
    v_submission uuid;
    v_id uuid;
    v_state text;
begin
    select ea.submission_id into v_submission from exam_answers ea join exam_sessions s on s.id = ea.session_id
     where ea.session_id = p_session and ea.problem_label = p_label and s.exam_id = p_exam;
    if v_submission is null then
        raise exception 'no such answer' using errcode = 'no_data_found';
    end if;
    select id, state into v_id, v_state from oral_defences where session_id = p_session and problem_label = p_label;
    if found then
        if v_state <> 'failed' then
            raise exception 'this answer has an oral defence already' using errcode = '55000';
        end if;
        update oral_defences set state = 'pending', failure = '', prompt_version = p_prompt_version,
               requested_by = v_user, requested_at = p_now, claimed_at = null where id = v_id;
        return v_id;
    end if;
    insert into oral_defences (org_id, exam_id, session_id, problem_label, submission_id, prompt_version, requested_by, requested_at)
    values (v_exam.org_id, p_exam, p_session, p_label, v_submission, p_prompt_version, v_user, p_now)
    returning id into v_id;
    return v_id;
end
$$;

-- The worker takes a batch of pending requests with the code to ask about. A claim not finished within five
-- minutes is taken again, so a crashed worker does not strand a request.
create function claim_oral_defences(p_limit int, p_now timestamptz)
    returns table (id uuid, language text, source text, prompt_version int)
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    return query
    with taken as (
        update oral_defences o set state = 'generating', claimed_at = p_now
         where o.id in (select x.id from oral_defences x
                         where x.state = 'pending' or (x.state = 'generating' and x.claimed_at < p_now - interval '5 minutes')
                         order by x.requested_at, x.id limit p_limit for update skip locked)
        returning o.id, o.submission_id, o.prompt_version)
    select t.id, s.language, s.source, t.prompt_version from taken t join submissions s on s.id = t.submission_id;
end
$$;

create function store_oral_questions(p_id uuid, p_questions jsonb, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    update oral_defences set state = 'ready', questions = p_questions, generated_at = p_now
     where id = p_id and state = 'generating';
    if not found then
        raise exception 'not being generated' using errcode = '55000';
    end if;
end
$$;

create function fail_oral_defence(p_id uuid, p_reason text)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    update oral_defences set state = 'failed', failure = left(p_reason, 500) where id = p_id and state = 'generating';
end
$$;

-- What the candidate may read of their own: the questions once ready, their answers. Never the score.
create function my_oral_defences(p_exam uuid)
    returns table (id uuid, problem_label text, state text, questions jsonb, answers jsonb)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select o.id, o.problem_label, o.state, case when o.state in ('ready', 'answered', 'scored') then o.questions end,
           o.answers
      from oral_defences o join exam_sessions s on s.id = o.session_id and s.user_id = app_user()
     where o.exam_id = p_exam and o.state <> 'failed'
     order by o.id limit 20
$$;

create function answer_oral_defence(p_id uuid, p_answers jsonb, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_row oral_defences%rowtype;
begin
    select o.* into v_row from oral_defences o join exam_sessions s on s.id = o.session_id
     where o.id = p_id and s.user_id = app_user();
    if not found then
        raise exception 'no such oral defence' using errcode = 'no_data_found';
    end if;
    if v_row.state <> 'ready' then
        raise exception 'not open for answers' using errcode = '55000';
    end if;
    if jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) <> jsonb_array_length(v_row.questions) then
        raise exception 'one answer for each question' using errcode = 'check_violation';
    end if;
    update oral_defences set state = 'answered', answers = p_answers, answered_at = p_now where id = p_id;
end
$$;

-- A person's score of the written answers. The only way `score` is ever set.
create function score_oral_defence(p_id uuid, p_score int, p_note text, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_row oral_defences%rowtype;
begin
    select * into v_row from oral_defences where id = p_id;
    if not found then
        raise exception 'no such oral defence' using errcode = 'no_data_found';
    end if;
    perform integrity_staff_exam(v_row.exam_id);
    if v_row.state <> 'answered' then
        raise exception 'only answered oral defences are scored' using errcode = '55000';
    end if;
    update oral_defences set state = 'scored', score = p_score, score_note = p_note, scored_by = v_user, scored_at = p_now
     where id = p_id;
end
$$;

revoke all on function request_oral_defence(uuid, uuid, text, int, timestamptz), claim_oral_defences(int, timestamptz),
    store_oral_questions(uuid, jsonb, timestamptz), fail_oral_defence(uuid, text), my_oral_defences(uuid),
    answer_oral_defence(uuid, jsonb, timestamptz), score_oral_defence(uuid, int, text, timestamptz) from public;
grant execute on function request_oral_defence(uuid, uuid, text, int, timestamptz), my_oral_defences(uuid),
    answer_oral_defence(uuid, jsonb, timestamptz), score_oral_defence(uuid, int, text, timestamptz) to aura_app;
grant execute on function claim_oral_defences(int, timestamptz), store_oral_questions(uuid, jsonb, timestamptz),
    fail_oral_defence(uuid, text) to aura_worker;
