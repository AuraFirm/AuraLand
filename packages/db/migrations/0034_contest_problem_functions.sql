-- Problems reach a contest through two functions only (Stage 5). The function looks up the version's
-- organization itself, because the organizer cannot read a platform-bank version directly, and it checks
-- everything the guard trigger checks, so a refusal reads as a plain "no such" rather than a leak of
-- which versions exist.

drop policy contest_problems_write on contest_problems;
revoke insert, update, delete on contest_problems from aura_app;

create function add_contest_problem(p_contest uuid, p_label text, p_version uuid, p_points int)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_contest contests%rowtype;
    v_org uuid;
begin
    select * into v_contest from contests where id = p_contest;
    if not found or app_org_role(v_contest.org_id) is null or app_org_role(v_contest.org_id) not in ('owner', 'admin') then
        raise exception 'no such contest' using errcode = 'no_data_found';
    end if;
    -- The host's own released versions, or released versions of public tasks of a platform organization.
    select v.org_id into v_org
      from task_versions v join tasks t on t.id = v.task_id join orgs o on o.id = v.org_id
     where v.id = p_version and v.state = 'released'
       and (v.org_id = v_contest.org_id or (o.kind = 'platform' and t.visibility = 'public'));
    if v_org is null then
        raise exception 'no such released version for this contest' using errcode = 'no_data_found';
    end if;
    insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id, points)
    values (p_contest, v_contest.org_id, p_label, p_version, v_org, p_points);
end
$$;

create function remove_contest_problem(p_contest uuid, p_label text) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
begin
    select org_id into v_org from contests where id = p_contest;
    if v_org is null or app_org_role(v_org) is null or app_org_role(v_org) not in ('owner', 'admin') then
        raise exception 'no such contest' using errcode = 'no_data_found';
    end if;
    delete from contest_problems where contest_id = p_contest and label = p_label;
    if not found then
        raise exception 'no such problem' using errcode = 'no_data_found';
    end if;
end
$$;
revoke all on function add_contest_problem(uuid, text, uuid, int), remove_contest_problem(uuid, text) from public;
grant execute on function add_contest_problem(uuid, text, uuid, int), remove_contest_problem(uuid, text) to aura_app;
