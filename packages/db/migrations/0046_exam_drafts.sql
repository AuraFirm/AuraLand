-- Autosave (Stage 6, slice 4; ADR 0032 decision 4 and its amendment). A candidate's work arrives as full
-- snapshots with an increasing per-problem `seq`. The one function that stores a save takes the injected clock
-- and refuses at or after the session's deadline; it acknowledges only after the row is committed (the caller's
-- transaction), so an acknowledged save is never lost, and nothing is stored after the deadline.
--   seq greater than the last: stored. The same seq with the same content as the last: acknowledged again
--   (a repeated request). Anything else: a conflict that names the last seq so the client can continue.

create table exam_drafts (
    session_id uuid not null references exam_sessions (id),
    org_id uuid not null,
    problem_label text not null,
    seq int not null,
    language text not null,
    content text not null,
    content_sha256 bytea not null,
    saved_at timestamptz not null,
    primary key (session_id, problem_label, seq),
    constraint exam_drafts_seq check (seq >= 1),
    constraint exam_drafts_label check (problem_label ~ '^[A-Z][A-Z0-9]{0,2}$'),
    constraint exam_drafts_language check (language ~ '^[a-z][a-z0-9_+.-]{0,31}$'),
    constraint exam_drafts_content check (octet_length(content) <= 262144 and content !~ '\x00'),
    constraint exam_drafts_hash check (octet_length(content_sha256) = 32)
);
create index exam_drafts_org on exam_drafts (org_id);
create index exam_drafts_recent on exam_drafts (session_id, saved_at);

-- A save is never changed or removed (the replay and the integrity review rely on it).
create function exam_drafts_guard() returns trigger language plpgsql as $$
begin
    raise exception 'a saved draft never changes' using errcode = 'insufficient_privilege';
end
$$;
create trigger exam_drafts_guard before update or delete on exam_drafts
    for each row execute function exam_drafts_guard();

alter table exam_drafts enable row level security;
alter table exam_drafts force row level security;
create policy exam_drafts_read on exam_drafts for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')
           or exists (select 1 from exam_sessions s where s.id = session_id and s.user_id = app_user()));
create policy exam_drafts_worker on exam_drafts for select to aura_worker using (true);
grant select on exam_drafts to aura_app, aura_worker;

-- Error codes for the route: 55000 the sitting is not under way or its time is over; P0002 no such session or
-- problem; 40001 a conflict (the hint says the last seq); 54000 too many saves a minute or in all; 22001 too large.
create function save_exam_draft(p_exam uuid, p_label text, p_seq int, p_language text, p_content text, p_now timestamptz)
    returns table (acked_seq int, deadline_at timestamptz)
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_session exam_sessions%rowtype;
    v_last int;
    v_last_hash bytea;
    v_hash bytea;
begin
    select * into v_session from exam_sessions where exam_id = p_exam and user_id = v_user for update;
    if not found or not exists (select 1 from exam_problems where exam_id = p_exam and label = p_label) then
        raise exception 'no such session or problem' using errcode = 'no_data_found';
    end if;
    if v_session.state <> 'started' or p_now >= v_session.deadline_at then
        raise exception 'the sitting is not under way' using errcode = '55000';
    end if;
    if octet_length(p_content) > 262144 or p_content ~ '\x00' then
        raise exception 'a draft is at most 256 KiB of text' using errcode = '22001';
    end if;
    v_hash := sha256(convert_to(p_content, 'UTF8'));
    select seq, content_sha256 into v_last, v_last_hash from exam_drafts
     where session_id = v_session.id and problem_label = p_label order by seq desc limit 1;
    v_last := coalesce(v_last, 0);
    if p_seq <= v_last then
        if p_seq = v_last and v_hash = v_last_hash then
            acked_seq := v_last; deadline_at := v_session.deadline_at;
            return next;
            return;
        end if;
        raise exception 'sequence conflict' using errcode = '40001', hint = v_last::text;
    end if;
    if (select count(*) from exam_drafts where session_id = v_session.id and saved_at > p_now - interval '1 minute') >= 60
       or (select count(*) from exam_drafts where session_id = v_session.id and problem_label = p_label) >= 20000 then
        raise exception 'too many saves' using errcode = '54000';
    end if;
    insert into exam_drafts (session_id, org_id, problem_label, seq, language, content, content_sha256, saved_at)
    values (v_session.id, v_session.org_id, p_label, p_seq, p_language, p_content, v_hash, p_now);
    acked_seq := p_seq; deadline_at := v_session.deadline_at;
    return next;
end
$$;
revoke all on function save_exam_draft(uuid, text, int, text, text, timestamptz) from public;
grant execute on function save_exam_draft(uuid, text, int, text, text, timestamptz) to aura_app;
