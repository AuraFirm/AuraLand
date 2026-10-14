-- Integrity evidence, human review and appeals (Stage 6, slice 9). A flag is evidence for a person to weigh: what
-- was seen (staff only), a plain explanation (safe for the candidate to read), and the version of the rule that
-- raised it. Only staff decide. A candidate may appeal a confirmed flag, and the appeal is reviewed by a staff
-- member other than the one who confirmed it. Nothing here is a verdict by software, and no AI-text detector is
-- ever a rule (kit 08).

create table integrity_flags (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    exam_id uuid not null references exams (id),
    session_id uuid not null references exam_sessions (id),
    problem_label text not null default '',
    kind text not null,
    rule_version int not null,
    evidence jsonb not null,
    explanation text not null,
    state text not null default 'unreviewed',
    decided_by uuid references users (id),
    decided_at timestamptz,
    decision_note text not null default '',
    created_at timestamptz not null,
    constraint integrity_flags_kind check (kind in ('similarity', 'large_paste', 'many_focus_losses')),
    constraint integrity_flags_state check (state in ('unreviewed', 'clear', 'needs_review', 'confirmed', 'dismissed')),
    constraint integrity_flags_evidence check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 8192),
    constraint integrity_flags_explanation check (char_length(explanation) between 1 and 1000 and explanation !~ '\x00'),
    constraint integrity_flags_note check (char_length(decision_note) <= 2000 and decision_note !~ '\x00'),
    constraint integrity_flags_decided check ((state = 'unreviewed') = (decided_by is null)),
    -- Raising again with the same rule finds the flag already there.
    unique (session_id, problem_label, kind, rule_version)
);
create index integrity_flags_exam on integrity_flags (exam_id, id);
create index integrity_flags_org on integrity_flags (org_id);
create index integrity_flags_decided_by on integrity_flags (decided_by);

create table integrity_appeals (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    flag_id uuid not null unique references integrity_flags (id),
    note text not null,
    state text not null default 'open',
    created_at timestamptz not null,
    reviewed_by uuid references users (id),
    reviewed_at timestamptz,
    review_note text not null default '',
    constraint integrity_appeals_state check (state in ('open', 'upheld', 'overturned')),
    constraint integrity_appeals_note check (char_length(note) between 1 and 2000 and note !~ '\x00'),
    constraint integrity_appeals_review_note check (char_length(review_note) <= 2000 and review_note !~ '\x00'),
    constraint integrity_appeals_reviewed check ((state = 'open') = (reviewed_by is null))
);
create index integrity_appeals_org on integrity_appeals (org_id);
create index integrity_appeals_reviewed_by on integrity_appeals (reviewed_by);

-- Flags and appeals are never deleted, and a flag's evidence, kind and owner never change.
create function integrity_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'integrity records are kept' using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'UPDATE' and tg_table_name = 'integrity_flags'
       and (new.evidence is distinct from old.evidence or new.kind <> old.kind or new.session_id <> old.session_id
            or new.explanation <> old.explanation or new.rule_version <> old.rule_version) then
        raise exception 'what a flag saw is never changed' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger integrity_flags_guard before update or delete on integrity_flags
    for each row execute function integrity_guard();
create trigger integrity_appeals_guard before delete on integrity_appeals
    for each row execute function integrity_guard();

alter table integrity_flags enable row level security;
alter table integrity_flags force row level security;
create policy integrity_flags_read on integrity_flags for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'));
alter table integrity_appeals enable row level security;
alter table integrity_appeals force row level security;
create policy integrity_appeals_read on integrity_appeals for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'));
grant select on integrity_flags, integrity_appeals to aura_app;

create function integrity_staff_exam(p_exam uuid) returns exams
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
    v_exam exams%rowtype;
begin
    select * into v_exam from exams where id = p_exam;
    if not found or app_org_role(v_exam.org_id) is null or app_org_role(v_exam.org_id) not in ('owner', 'admin') then
        raise exception 'no such exam' using errcode = 'no_data_found';
    end if;
    return v_exam;
end
$$;

-- Records what a rule saw. Idempotent: the same rule version on the same answer is raised once.
create function raise_integrity_flag(p_exam uuid, p_session uuid, p_label text, p_kind text, p_evidence jsonb,
                                     p_explanation text, p_rule_version int, p_now timestamptz)
    returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_exam exams%rowtype := integrity_staff_exam(p_exam);
    v_rows int;
begin
    if not exists (select 1 from exam_sessions where id = p_session and exam_id = p_exam) then
        raise exception 'no such sitting' using errcode = 'no_data_found';
    end if;
    insert into integrity_flags (org_id, exam_id, session_id, problem_label, kind, rule_version, evidence, explanation, created_at)
    values (v_exam.org_id, p_exam, p_session, p_label, p_kind, p_rule_version, p_evidence, p_explanation, p_now)
    on conflict (session_id, problem_label, kind, rule_version) do nothing;
    get diagnostics v_rows = row_count;
    return v_rows = 1;
end
$$;

-- A person's decision. From unreviewed any decision is allowed; needs_review is not final and leads to a decision;
-- a decision made is not remade here (a confirmed flag is reopened only by a successful appeal).
create function decide_integrity_flag(p_flag uuid, p_state text, p_note text, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_flag integrity_flags%rowtype;
begin
    select * into v_flag from integrity_flags where id = p_flag;
    if not found then
        raise exception 'no such flag' using errcode = 'no_data_found';
    end if;
    perform integrity_staff_exam(v_flag.exam_id);
    if p_state not in ('clear', 'needs_review', 'confirmed', 'dismissed') then
        raise exception 'unknown decision' using errcode = 'check_violation';
    end if;
    if v_flag.state not in ('unreviewed', 'needs_review') then
        raise exception 'this flag has been decided' using errcode = '55000';
    end if;
    update integrity_flags set state = p_state, decided_by = v_user, decided_at = p_now, decision_note = p_note
     where id = p_flag;
end
$$;

-- What a candidate may read: their own confirmed flags, with the plain explanation and not what was seen (the
-- evidence may involve other people).
create function my_integrity_flags(p_exam uuid)
    returns table (flag_id uuid, problem_label text, kind text, explanation text, rule_version int,
                   decided_at timestamptz, appeal_state text)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select f.id, f.problem_label, f.kind, f.explanation, f.rule_version, f.decided_at, a.state
      from integrity_flags f
      join exam_sessions s on s.id = f.session_id and s.user_id = app_user()
      left join integrity_appeals a on a.flag_id = f.id
     where f.exam_id = p_exam and f.state = 'confirmed'
     order by f.id limit 100
$$;

create function appeal_integrity_flag(p_flag uuid, p_note text, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_flag integrity_flags%rowtype;
begin
    select f.* into v_flag from integrity_flags f join exam_sessions s on s.id = f.session_id
     where f.id = p_flag and s.user_id = app_user() and f.state = 'confirmed';
    if not found then
        raise exception 'no such flag' using errcode = 'no_data_found';
    end if;
    if exists (select 1 from integrity_appeals where flag_id = p_flag) then
        raise exception 'this flag has been appealed' using errcode = '55000';
    end if;
    insert into integrity_appeals (org_id, flag_id, note, created_at) values (v_flag.org_id, p_flag, p_note, p_now);
end
$$;

-- The appeal is decided by staff other than the person who confirmed the flag. Overturning dismisses the flag.
create function review_integrity_appeal(p_appeal uuid, p_outcome text, p_note text, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_appeal integrity_appeals%rowtype;
    v_flag integrity_flags%rowtype;
begin
    select * into v_appeal from integrity_appeals where id = p_appeal;
    if not found then
        raise exception 'no such appeal' using errcode = 'no_data_found';
    end if;
    select * into v_flag from integrity_flags where id = v_appeal.flag_id;
    perform integrity_staff_exam(v_flag.exam_id);
    if p_outcome not in ('upheld', 'overturned') then
        raise exception 'unknown outcome' using errcode = 'check_violation';
    end if;
    if v_appeal.state <> 'open' then
        raise exception 'this appeal has been reviewed' using errcode = '55000';
    end if;
    if v_flag.decided_by = v_user then
        raise exception 'an appeal is reviewed by someone other than the person who decided' using errcode = '42501';
    end if;
    update integrity_appeals set state = p_outcome, reviewed_by = v_user, reviewed_at = p_now, review_note = p_note
     where id = p_appeal;
    if p_outcome = 'overturned' then
        update integrity_flags set state = 'dismissed' where id = v_flag.id;
    end if;
end
$$;

revoke all on function integrity_staff_exam(uuid), raise_integrity_flag(uuid, uuid, text, text, jsonb, text, int, timestamptz),
    decide_integrity_flag(uuid, text, text, timestamptz), my_integrity_flags(uuid),
    appeal_integrity_flag(uuid, text, timestamptz), review_integrity_appeal(uuid, text, text, timestamptz) from public;
grant execute on function raise_integrity_flag(uuid, uuid, text, text, jsonb, text, int, timestamptz),
    decide_integrity_flag(uuid, text, text, timestamptz), my_integrity_flags(uuid),
    appeal_integrity_flag(uuid, text, timestamptz), review_integrity_appeal(uuid, text, text, timestamptz) to aura_app;
