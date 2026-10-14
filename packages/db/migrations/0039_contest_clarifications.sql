-- Contest clarifications (Stage 5, slice 7b; ADR 0031 decision 12).
-- A registered contestant asks the organizers a plain-text question while the contest runs; the host's owners
-- and admins answer once, either to everyone or to the asker only. Append-only: a question never changes and
-- an answer is set once. Who reads what is a policy: the asker reads their own, the host's staff read all, and
-- everyone who can see the contest reads an answered question marked public. Text only; the page never
-- renders it as Markdown or HTML.

create table contest_clarifications (
    id uuid primary key default uuidv7(),
    contest_id uuid not null references contests (id) on delete cascade,
    org_id uuid not null references orgs (id),
    asker_id uuid not null references users (id),
    problem_label text,
    question text not null,
    answer text,
    answered_by uuid references users (id),
    answered_at timestamptz,
    public boolean not null default false,
    created_at timestamptz not null,
    constraint contest_clarifications_question check (char_length(question) between 1 and 1000 and question !~ '\x00'),
    constraint contest_clarifications_answer check (
        (answer is null) = (answered_at is null) and (answer is null) = (answered_by is null)
        and (answer is null or (char_length(answer) between 1 and 2000 and answer !~ '\x00'))),
    constraint contest_clarifications_public check (not public or answer is not null)
);
create index contest_clarifications_contest on contest_clarifications (contest_id, id desc);
create index contest_clarifications_asker on contest_clarifications (asker_id);
create index contest_clarifications_org on contest_clarifications (org_id);

-- Nothing changes a question; an answer is added once and never edited.
create function contest_clarifications_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'a clarification is never deleted' using errcode = 'insufficient_privilege';
    end if;
    if new.id <> old.id or new.contest_id <> old.contest_id or new.org_id <> old.org_id
       or new.asker_id <> old.asker_id or new.problem_label is distinct from old.problem_label
       or new.question <> old.question or new.created_at <> old.created_at then
        raise exception 'a question does not change' using errcode = 'insufficient_privilege';
    end if;
    if old.answer is not null then
        raise exception 'an answer is given once' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger contest_clarifications_guard before update or delete on contest_clarifications
    for each row execute function contest_clarifications_guard();

alter table contest_clarifications enable row level security;
alter table contest_clarifications force row level security;
create policy contest_clarifications_read on contest_clarifications for select to aura_app
    using (asker_id = app_user()
           or app_org_role(org_id) in ('owner', 'admin')
           or (public and exists (select 1 from contests c where c.id = contest_id)));
-- Writes go through the two functions below; aura_app has no insert or update.
grant select (id, contest_id, problem_label, question, answer, answered_at, public, created_at, asker_id)
    on contest_clarifications to aura_app;

create function ask_clarification(p_contest uuid, p_label text, p_question text, p_now timestamptz, p_per_user_max int)
    returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_contest contests%rowtype;
    v_id uuid;
begin
    if v_user is null then
        raise exception 'sign in to ask' using errcode = 'insufficient_privilege';
    end if;
    select * into v_contest from contests where id = p_contest;
    if not found or not exists (select 1 from registrations where contest_id = p_contest and user_id = v_user) then
        raise exception 'no such contest for you' using errcode = 'no_data_found';
    end if;
    if v_contest.state not in ('running', 'frozen') or p_now < v_contest.starts_at or p_now >= v_contest.ends_at then
        raise exception 'the contest is not accepting questions' using errcode = '55000';
    end if;
    if p_label is not null and not exists (select 1 from contest_problems where contest_id = p_contest and label = p_label) then
        raise exception 'no such problem' using errcode = 'no_data_found';
    end if;
    if char_length(p_question) not between 1 and 1000 or p_question ~ '\x00' then
        raise exception 'a question is 1 to 1000 characters' using errcode = '22001';
    end if;
    if (select count(*) from contest_clarifications where contest_id = p_contest and asker_id = v_user) >= p_per_user_max then
        raise exception 'too many questions' using errcode = '54000';
    end if;
    insert into contest_clarifications (contest_id, org_id, asker_id, problem_label, question, created_at)
    values (p_contest, v_contest.org_id, v_user, p_label, p_question, p_now) returning id into v_id;
    return v_id;
end
$$;

create function answer_clarification(p_clarification uuid, p_answer text, p_public boolean, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_row contest_clarifications%rowtype;
    v_state text;
begin
    select * into v_row from contest_clarifications where id = p_clarification for update;
    if v_user is null or not found or app_org_role(v_row.org_id) is null or app_org_role(v_row.org_id) not in ('owner', 'admin') then
        raise exception 'no such clarification' using errcode = 'no_data_found';
    end if;
    select state into v_state from contests where id = v_row.contest_id;
    if v_state = 'finalized' or v_row.answer is not null then
        raise exception 'this question cannot be answered now' using errcode = '55000';
    end if;
    if char_length(p_answer) not between 1 and 2000 or p_answer ~ '\x00' then
        raise exception 'an answer is 1 to 2000 characters' using errcode = '22001';
    end if;
    update contest_clarifications set answer = p_answer, public = p_public, answered_by = v_user, answered_at = p_now
     where id = p_clarification;
end
$$;

revoke all on function ask_clarification(uuid, text, text, timestamptz, int),
    answer_clarification(uuid, text, boolean, timestamptz) from public;
grant execute on function ask_clarification(uuid, text, text, timestamptz, int),
    answer_clarification(uuid, text, boolean, timestamptz) to aura_app;
