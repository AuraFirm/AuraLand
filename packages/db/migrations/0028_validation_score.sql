-- The ungameability score (Stage 4B, ADR 0029): a number from 0 to 100 computed by the control plane
-- from a node's observations, stored with the version of the formula that produced it so old reports
-- stay readable when the weights change. A report of a bundle that did not open has no score.
alter table validation_reports
    add column score numeric(5, 2),
    add column score_version smallint,
    add constraint validation_reports_score_range check (score between 0 and 100),
    add constraint validation_reports_score_pair check ((score is null) = (score_version is null)),
    add constraint validation_reports_score_version check (score_version >= 1);
grant select (score, score_version) on validation_reports to aura_app;

drop function settle_validation(uuid, uuid, jsonb, jsonb, timestamptz);
create function settle_validation(p_version uuid, p_node uuid, p_checks jsonb, p_observations jsonb,
                                  p_score numeric, p_score_version int, p_now timestamptz)
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
    insert into validation_reports (org_id, task_version_id, node_id, attestation, checks, observations, passed,
                                    score, score_version, created_at)
    values (v_org, p_version, p_node, v_attestation, p_checks, p_observations, v_passed,
            p_score, p_score_version, p_now)
    returning id into v_report;
    update task_versions set state = case when v_passed then 'validated' else 'uploaded' end
     where id = p_version;
    return v_report;
end
$$;
revoke all on function settle_validation(uuid, uuid, jsonb, jsonb, numeric, int, timestamptz) from public;
grant execute on function settle_validation(uuid, uuid, jsonb, jsonb, numeric, int, timestamptz) to aura_worker;
