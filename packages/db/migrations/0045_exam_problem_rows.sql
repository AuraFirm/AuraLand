-- A candidate reads an exam's problem list only in an exam whose sitting they have started (Stage 6, slice 3).
-- Migration 0044 keyed the rule to the task version, so a person who had started one exam could read another
-- exam's list of problems before starting it, when the other exam shared a version. The statement itself stays
-- keyed to the version (a person who has sat a problem may read it again); the list of an exam does not.

create function app_exam_started(p_exam uuid) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select exists (
        select 1 from exam_sessions s join exams e on e.id = s.exam_id
         where s.exam_id = p_exam and s.user_id = app_user() and s.started_at is not null
           and s.state in ('started', 'submitted', 'expired') and e.state in ('open', 'closed', 'released'))
$$;
revoke all on function app_exam_started(uuid) from public;
grant execute on function app_exam_started(uuid) to aura_app;

drop policy exam_problems_read on exam_problems;
create policy exam_problems_read on exam_problems for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin') or app_exam_started(exam_id));
