-- The instructor's live monitor (Stage 6, slice 7): one row per person who joined, with where they are, when they last
-- saved and how many of the signals a person might want to look at (never a verdict). Staff only.

create function exam_monitor_rows(p_exam uuid)
    returns table (session_id uuid, email text, name text, state text, started_at timestamptz, deadline_at timestamptz,
                   last_save_at timestamptz, saves bigint, problems_started bigint, focus_lost bigint, paste bigint,
                   fullscreen_exit bigint, offline bigint, last_event_at timestamptz, consented boolean)
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
    if not exists (select 1 from exams where id = p_exam and app_org_role(org_id) in ('owner', 'admin')) then
        raise exception 'no such exam' using errcode = 'no_data_found';
    end if;
    return query
    select s.id, u.email::text, coalesce(r.name, u.email::text), s.state, s.started_at, s.deadline_at,
           (select max(d.saved_at) from exam_drafts d where d.session_id = s.id),
           (select count(*) from exam_drafts d where d.session_id = s.id),
           (select count(distinct d.problem_label) from exam_drafts d where d.session_id = s.id),
           (select count(*) from telemetry_events t where t.session_id = s.id and t.kind = 'focus_lost'),
           (select count(*) from telemetry_events t where t.session_id = s.id and t.kind = 'paste'),
           (select count(*) from telemetry_events t where t.session_id = s.id and t.kind = 'fullscreen_exit'),
           (select count(*) from telemetry_events t where t.session_id = s.id and t.kind = 'offline'),
           (select max(t.ts) from telemetry_events t where t.session_id = s.id),
           s.consent_at is not null
      from exam_sessions s
      join users u on u.id = s.user_id
      left join exam_roster r on r.exam_id = s.exam_id and r.email = u.email
     where s.exam_id = p_exam
     order by u.email limit 5000;
end
$$;
revoke all on function exam_monitor_rows(uuid) from public;
grant execute on function exam_monitor_rows(uuid) to aura_app;
