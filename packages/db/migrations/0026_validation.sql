-- Validation of task versions (Stage 4B, ADR 0029): judge nodes declare what kind of machine they are,
-- a validation job is queued when a reviewer asks for it, and the result is an immutable report. The
-- application role can neither start validation by a bare update nor mark a version validated: both
-- go through the two functions below, which keep the state, the job and the report in step.

-- A node's attestation is the operator's declaration at enrollment, recorded by a platform
-- administrator; it never changes. Only a 'production' node (reviewed sandbox, F32) may produce a
-- report that a customer is told is validated.
alter table node_enrollments add column attestation text not null default 'development',
    add constraint node_enrollments_attestation check (attestation in ('development', 'production'));
alter table judge_nodes add column attestation text not null default 'development',
    add constraint judge_nodes_attestation check (attestation in ('development', 'production'));

create or replace function judge_nodes_guard() returns trigger language plpgsql as $$
begin
    if old.state = 'revoked' then
        raise exception 'a revoked node stays revoked' using errcode = 'insufficient_privilege';
    end if;
    if new.public_key <> old.public_key or new.name <> old.name or new.attestation <> old.attestation then
        raise exception 'a node keeps its name, key and attestation' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;

drop function create_node_enrollment(bytea, timestamptz, interval);
create function create_node_enrollment(p_token_hash bytea, p_now timestamptz, p_ttl interval, p_attestation text)
    returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_id uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator may enroll judge nodes' using errcode = 'insufficient_privilege';
    end if;
    insert into node_enrollments (token_hash, created_by, created_at, expires_at, attestation)
    values (p_token_hash, v_user, p_now, p_now + p_ttl, p_attestation) returning id into v_id;
    return v_id;
end
$$;
revoke all on function create_node_enrollment(bytea, timestamptz, interval, text) from public;
grant execute on function create_node_enrollment(bytea, timestamptz, interval, text) to aura_app;

-- Reports. One row per finished validation attempt of a version. `checks` is a list of
-- {name, ok, detail}; `passed` must agree with it, so the database refuses a report whose summary
-- contradicts its checks. `observations` holds what the node saw (per solution and test), kept so a
-- report can be re-derived and audited. Nothing here is ever updated or deleted by a person.
create table validation_reports (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    task_version_id uuid not null,
    node_id uuid not null references judge_nodes (id),
    attestation text not null,
    checks jsonb not null,
    observations jsonb not null,
    passed boolean not null,
    created_at timestamptz not null,
    foreign key (task_version_id, org_id) references task_versions (id, org_id) on delete cascade,
    constraint validation_reports_attestation check (attestation in ('development', 'production')),
    constraint validation_reports_checks check (
        jsonb_typeof(checks) = 'array' and jsonb_array_length(checks) between 1 and 100),
    constraint validation_reports_size check (octet_length(observations::text) <= 1048576),
    constraint validation_reports_passed check (
        passed = not jsonb_path_exists(checks, '$[*] ? (@.ok != true)'))
);
create index validation_reports_version on validation_reports (task_version_id, created_at desc, id);
create index validation_reports_org on validation_reports (org_id);
create index validation_reports_node on validation_reports (node_id);

create function validation_reports_immutable() returns trigger language plpgsql as $$
begin
    raise exception 'a validation report is never changed or deleted' using errcode = 'insufficient_privilege';
end
$$;
-- Deleting a version or organization removes its reports by cascade; that is the only way they go.
create trigger validation_reports_no_update before update on validation_reports
    for each row execute function validation_reports_immutable();
create trigger validation_reports_no_delete before delete on validation_reports
    for each row when (pg_trigger_depth() = 0) execute function validation_reports_immutable();

alter table validation_reports enable row level security;
alter table validation_reports force row level security;
create policy validation_reports_read on validation_reports for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin') or app_version_staff(task_version_id));
grant select (id, org_id, task_version_id, attestation, checks, passed, created_at)
    on validation_reports to aura_app;

-- A version is marked validated only by settle_validation, and only with a passing report behind it.
create function task_versions_validated_needs_report() returns trigger language plpgsql as $$
begin
    if new.state = 'validated' and old.state <> 'validated' and not exists (
        select 1 from validation_reports r where r.task_version_id = new.id and r.passed
    ) then
        raise exception 'a version is validated only with a passing report' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger task_versions_validated_needs_report before update on task_versions
    for each row execute function task_versions_validated_needs_report();

-- The application role keeps its other moves but can no longer start validation (it would leave a
-- version validating with no job) or declare a version validated. The "using" side still lets it see
-- and release a validated version.
drop policy task_versions_review on task_versions;
create policy task_versions_review on task_versions for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin', 'reviewer')
           and state in ('in_review', 'validating', 'validated', 'released'))
    with check (app_org_role(org_id) in ('owner', 'admin', 'reviewer')
                and state in ('uploaded', 'rejected', 'released', 'retired')
                and (state <> 'released' or released_by = app_user()));

-- Asking for validation: the version moves to 'validating' and the job is queued in one step. The
-- caller must be an owner, admin or reviewer of the version's organization.
create function request_validation(p_version uuid, p_now timestamptz, p_ready_max int) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
    v_job uuid;
begin
    select org_id into v_org from task_versions where id = p_version and state = 'in_review' for update;
    if v_org is null or app_org_role(v_org) is null or app_org_role(v_org) not in ('owner', 'admin', 'reviewer') then
        raise exception 'no such version in review' using errcode = 'no_data_found';
    end if;
    if (select count(*) from jobs where queue = 'validate' and state = 'ready') >= p_ready_max then
        raise exception 'the validation queue is full' using errcode = 'configuration_limit_exceeded';
    end if;
    update task_versions set state = 'validating' where id = p_version;
    insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
    values ('task.validate', v_org, jsonb_build_object('task_version_id', p_version), 'validate', 5, 3, p_now,
            'validate:' || p_version::text || ':' || extract(epoch from p_now)::text, p_now, p_now)
    returning id into v_job;
    return v_job;
end
$$;
revoke all on function request_validation(uuid, timestamptz, int) from public;
grant execute on function request_validation(uuid, timestamptz, int) to aura_app;

-- Settling a validation: stores the report and moves the version, both or neither. The attestation is
-- read from the node's own row here, never taken from the caller, so a development node cannot sign
-- as production. Returns the report id, or null when the version is no longer being validated (a
-- late or duplicate result).
create function settle_validation(p_version uuid, p_node uuid, p_checks jsonb, p_observations jsonb, p_now timestamptz)
    returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
    v_attestation text;
    v_passed boolean;
    v_report uuid;
begin
    select org_id into v_org from task_versions where id = p_version and state = 'validating' for update;
    if v_org is null then
        return null;
    end if;
    select attestation into v_attestation from judge_nodes where id = p_node and state in ('active', 'draining');
    if v_attestation is null then
        raise exception 'only an enrolled, live node can report' using errcode = 'insufficient_privilege';
    end if;
    v_passed := not jsonb_path_exists(p_checks, '$[*] ? (@.ok != true)');
    insert into validation_reports (org_id, task_version_id, node_id, attestation, checks, observations, passed, created_at)
    values (v_org, p_version, p_node, v_attestation, p_checks, p_observations, v_passed, p_now)
    returning id into v_report;
    update task_versions set state = case when v_passed then 'validated' else 'uploaded' end
     where id = p_version;
    return v_report;
end
$$;
revoke all on function settle_validation(uuid, uuid, jsonb, jsonb, timestamptz) from public;
grant execute on function settle_validation(uuid, uuid, jsonb, jsonb, timestamptz) to aura_worker;
