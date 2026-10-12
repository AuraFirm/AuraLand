-- Who may touch which task (Stage 4A, authoring workspace). Until now every setter and reviewer of an
-- organization could read every task of it. For work that is sold to customers that is too wide:
--   * owners and admins see and change every task of their organization (unchanged);
--   * a setter sees and changes only tasks they created or were assigned;
--   * a reviewer sees and reviews only tasks they were assigned;
--   * plain members still see "org" tasks and released versions (unchanged).
-- Owners and admins assign people; a person is assigned to a task, not to a role in it.

create table task_assignments (
    task_id uuid not null,
    org_id uuid not null,
    user_id uuid not null references users (id) on delete cascade,
    assigned_by uuid not null references users (id),
    created_at timestamptz not null,
    primary key (task_id, user_id),
    foreign key (task_id, org_id) references tasks (id, org_id) on delete cascade
);
create index task_assignments_user on task_assignments (user_id, task_id);

-- Did the current person create this task, or were they assigned to it? The functions read tables as
-- their owner so that the policies using them do not recurse into each other.
create function app_task_staff(p_task uuid) returns boolean language sql stable security definer
    set search_path = pg_catalog, public as $$
    select exists (select 1 from tasks t where t.id = p_task and t.created_by = app_user())
        or exists (select 1 from task_assignments a where a.task_id = p_task and a.user_id = app_user())
$$;
-- The same for assignments alone, for the policies on tasks themselves: a row just inserted by the
-- current statement is not visible to a stable function, so "created by me" is tested inline there.
create function app_task_assigned(p_task uuid) returns boolean language sql stable security definer
    set search_path = pg_catalog, public as $$
    select exists (select 1 from task_assignments a where a.task_id = p_task and a.user_id = app_user())
$$;
create function app_version_staff(p_version uuid) returns boolean language sql stable security definer
    set search_path = pg_catalog, public as $$
    select exists (select 1 from task_versions v where v.id = p_version and app_task_staff(v.task_id))
$$;
revoke all on function app_task_staff(uuid), app_task_assigned(uuid), app_version_staff(uuid) from public;
grant execute on function app_task_staff(uuid), app_task_assigned(uuid), app_version_staff(uuid) to aura_app;

-- Assigning is an owner's or admin's decision, and only a setter or reviewer of the same organization
-- can be assigned. The function checks both itself.
create function assign_task_staff(p_task uuid, p_user uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
begin
    select org_id into v_org from tasks where id = p_task;
    if v_org is null or app_org_role(v_org) is null or app_org_role(v_org) not in ('owner', 'admin') then
        raise exception 'no such task' using errcode = 'no_data_found';
    end if;
    if not exists (select 1 from memberships where org_id = v_org and user_id = p_user and role in ('setter', 'reviewer')) then
        raise exception 'only a setter or reviewer of the organization can be assigned' using errcode = 'check_violation';
    end if;
    insert into task_assignments (task_id, org_id, user_id, assigned_by, created_at)
    values (p_task, v_org, p_user, app_user(), p_now) on conflict do nothing;
end
$$;
create function unassign_task_staff(p_task uuid, p_user uuid) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
begin
    select org_id into v_org from tasks where id = p_task;
    if v_org is null or app_org_role(v_org) is null or app_org_role(v_org) not in ('owner', 'admin') then
        raise exception 'no such task' using errcode = 'no_data_found';
    end if;
    delete from task_assignments where task_id = p_task and user_id = p_user;
    if not found then
        raise exception 'no such assignment' using errcode = 'no_data_found';
    end if;
end
$$;
revoke all on function assign_task_staff(uuid, uuid, timestamptz), unassign_task_staff(uuid, uuid) from public;
grant execute on function assign_task_staff(uuid, uuid, timestamptz), unassign_task_staff(uuid, uuid) to aura_app;

alter table task_assignments enable row level security;
alter table task_assignments force row level security;
create policy task_assignments_read on task_assignments for select to aura_app
    using (user_id = app_user() or app_org_role(org_id) in ('owner', 'admin'));
grant select on task_assignments to aura_app;

-- The narrower reading and writing rules. Each policy is the one from migration 0012 with the
-- setter and reviewer clauses limited to tasks the person is staff on.
drop policy tasks_read on tasks;
create policy tasks_read on tasks for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')
           or (app_org_role(org_id) in ('setter', 'reviewer') and (created_by = app_user() or app_task_assigned(id)))
           or (visibility = 'org' and app_org_role(org_id) is not null));
drop policy tasks_update on tasks;
create policy tasks_update on tasks for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'setter' and (created_by = app_user() or app_task_assigned(id))))
    with check (app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'setter' and (created_by = app_user() or app_task_assigned(id))));

drop policy task_versions_read on task_versions;
create policy task_versions_read on task_versions for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')
           or (app_org_role(org_id) in ('setter', 'reviewer') and app_task_staff(task_id))
           or (state = 'released' and exists (select 1 from tasks t where t.id = task_id)));
drop policy task_versions_insert on task_versions;
create policy task_versions_insert on task_versions for insert to aura_app
    with check ((app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'setter' and app_task_staff(task_id)))
                and created_by = app_user() and state = 'draft');
drop policy task_versions_write on task_versions;
create policy task_versions_write on task_versions for update to aura_app
    using ((app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'setter' and app_task_staff(task_id)))
           and state in ('draft', 'uploaded'))
    with check ((app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'setter' and app_task_staff(task_id)))
                and state in ('draft', 'uploaded', 'in_review', 'rejected'));
drop policy task_versions_review on task_versions;
create policy task_versions_review on task_versions for update to aura_app
    using ((app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'reviewer' and app_task_staff(task_id)))
           and state in ('in_review', 'validating', 'validated', 'released'))
    with check ((app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'reviewer' and app_task_staff(task_id)))
                and state in ('uploaded', 'rejected', 'validating', 'validated', 'released', 'retired')
                and (state <> 'released' or released_by = app_user()));

drop policy task_reviews_read on task_reviews;
create policy task_reviews_read on task_reviews for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')
           or (app_org_role(org_id) in ('setter', 'reviewer') and app_version_staff(task_version_id)));
drop policy task_reviews_insert on task_reviews;
create policy task_reviews_insert on task_reviews for insert to aura_app
    with check ((app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'reviewer' and app_version_staff(task_version_id)))
                and reviewer_id = app_user());

drop policy bundle_uploads_read on bundle_uploads;
create policy bundle_uploads_read on bundle_uploads for select to aura_app
    using (started_by = app_user() or app_org_role(org_id) in ('owner', 'admin')
           or (app_org_role(org_id) = 'setter' and app_version_staff(task_version_id)));
drop policy bundle_uploads_insert on bundle_uploads;
create policy bundle_uploads_insert on bundle_uploads for insert to aura_app
    with check (started_by = app_user()
                and (app_org_role(org_id) in ('owner', 'admin') or (app_org_role(org_id) = 'setter' and app_version_staff(task_version_id))));
