-- Human attacks on a task version (Stage 4B, ADR 0029): after the machines, a person tries to pass the
-- task without solving it and records whether it held or was gamed, and how. Evidence for a reviewer's
-- decision; it does not change the version's state by itself.
--   * the attacker is an owner or admin of the organization, or a reviewer assigned to the task, and
--     never the person who made the version (an author does not attack their own work);
--   * only a version that is in review, being validated, validated or released can be attacked;
--   * a finding never changes and is never deleted: a correction is a new finding.

create table attack_findings (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    task_version_id uuid not null,
    author_id uuid not null references users (id),
    outcome text not null,
    method text not null,
    created_at timestamptz not null,
    foreign key (task_version_id, org_id) references task_versions (id, org_id),
    constraint attack_findings_outcome check (outcome in ('held', 'gamed')),
    constraint attack_findings_method check (char_length(method) between 1 and 4000 and octet_length(method) <= 16384 and method !~ '\x00')
);
create index attack_findings_version on attack_findings (task_version_id, created_at, id);
create index attack_findings_author on attack_findings (author_id);

create function attack_findings_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    v_version task_versions%rowtype;
begin
    if tg_op <> 'INSERT' then
        raise exception 'a finding never changes and is never deleted' using errcode = 'insufficient_privilege';
    end if;
    select * into v_version from task_versions where id = new.task_version_id;
    if v_version.created_by = new.author_id then
        raise exception 'nobody attacks their own version' using errcode = 'check_violation';
    end if;
    if v_version.state not in ('in_review', 'validating', 'validated', 'released') then
        raise exception 'a version in state % cannot be attacked', v_version.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger attack_findings_guard before insert or update or delete on attack_findings
    for each row execute function attack_findings_guard();

alter table attack_findings enable row level security;
alter table attack_findings force row level security;
create policy attack_findings_read on attack_findings for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')
           or (app_org_role(org_id) in ('setter', 'reviewer') and app_version_staff(task_version_id)));
create policy attack_findings_insert on attack_findings for insert to aura_app
    with check (author_id = app_user()
                and (app_org_role(org_id) in ('owner', 'admin')
                     or (app_org_role(org_id) = 'reviewer' and app_version_staff(task_version_id))));
grant select on attack_findings to aura_app;
grant insert (org_id, task_version_id, author_id, outcome, method, created_at) on attack_findings to aura_app;
