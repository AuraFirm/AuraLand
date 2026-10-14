-- Unfreezing a scoreboard and rejudging a contest submission (Stage 5, slice 7a; ADR 0031).
--   * unfreeze_contest ends the freeze for the public board once the contest has ended; finalizing does it
--     too (a finalized board shows everything). Only the host's owners and admins, and only once;
--   * rejudge_contest_submission puts a finished contest submission (judged, or failed by the system) back
--     on the judge queue. The old verdict stays in force on the scoreboard until the new one replaces it, so
--     the board never flickers; `previous_verdict` and `previous_score` carry it, `rejudge_count` counts it.
--     Only the host's owners and admins may ask, never after the contest is finalized (ratings are computed
--     from the finalized board).
-- The submission guard still refuses every other change to a finished submission.

alter table contests add column unfrozen_at timestamptz;
alter table contests add constraint contests_unfrozen check (
    unfrozen_at is null or (freeze_at is not null and state in ('ended', 'finalized') and unfrozen_at >= ends_at));

create or replace function contests_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    v_kind text;
begin
    if tg_op = 'INSERT' then
        select kind into v_kind from orgs where id = new.org_id;
        if v_kind is null or v_kind = 'personal' then
            raise exception 'a contest is hosted by an organization, not a personal space' using errcode = 'check_violation';
        end if;
        if new.state <> 'draft' then
            raise exception 'a contest starts as a draft' using errcode = 'check_violation';
        end if;
        return new;
    end if;
    if new.id <> old.id or new.org_id <> old.org_id or new.slug <> old.slug or new.created_by <> old.created_by
       or new.format <> old.format then
        raise exception 'a contest keeps its host, address, author and format' using errcode = 'insufficient_privilege';
    end if;
    -- Everything the participants rely on is fixed once the contest leaves draft.
    if old.state <> 'draft' and (new.rules <> old.rules or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at
        or new.freeze_at is distinct from old.freeze_at or new.visibility <> old.visibility
        or new.rated <> old.rated or new.ai_policy <> old.ai_policy or new.title <> old.title) then
        raise exception 'a published contest does not change' using errcode = 'insufficient_privilege';
    end if;
    if old.unfrozen_at is not null and new.unfrozen_at is distinct from old.unfrozen_at then
        raise exception 'a scoreboard is unfrozen once' using errcode = 'insufficient_privilege';
    end if;
    if new.state <> old.state and not (old.state || '>' || new.state) = any (array[
        'draft>scheduled', 'scheduled>running', 'running>frozen', 'running>ended', 'frozen>ended', 'ended>finalized']) then
        raise exception 'a contest cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;

create function unfreeze_contest(p_contest uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_contest contests%rowtype;
begin
    select * into v_contest from contests where id = p_contest for update;
    if not found or app_org_role(v_contest.org_id) is null or app_org_role(v_contest.org_id) not in ('owner', 'admin')
       or v_contest.state <> 'ended' or v_contest.freeze_at is null or v_contest.unfrozen_at is not null then
        raise exception 'no such frozen, ended contest' using errcode = 'no_data_found';
    end if;
    update contests set unfrozen_at = greatest(p_now, ends_at) where id = p_contest;
end
$$;

create or replace function finalize_contest(p_contest uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_contest contests%rowtype;
begin
    select * into v_contest from contests where id = p_contest for update;
    if not found or app_org_role(v_contest.org_id) is null or app_org_role(v_contest.org_id) not in ('owner', 'admin')
       or v_contest.state <> 'ended' then
        raise exception 'no such ended contest' using errcode = 'no_data_found';
    end if;
    -- A finalized board shows everything: finalizing lifts a freeze that was not lifted already.
    update contests set state = 'finalized', finalized_at = p_now,
           unfrozen_at = case when freeze_at is null then null else coalesce(unfrozen_at, greatest(p_now, ends_at)) end
     where id = p_contest;
end
$$;

alter table submissions add column rejudge_count integer not null default 0;
alter table submissions add column previous_verdict text;
alter table submissions add column previous_score numeric(9, 3);
alter table submissions add constraint submissions_rejudge check (
    rejudge_count >= 0 and (rejudge_count > 0 or previous_verdict is null)
    and (previous_verdict is null or previous_verdict in ('AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'CE', 'PARTIAL', 'SE'))
    and (previous_score is null or previous_score between 0 and 1000000));

create or replace function submissions_guard() returns trigger language plpgsql as $$
declare
    v_rejudge boolean;
begin
    if tg_op = 'INSERT' then
        if new.state <> 'queued' or new.verdict is not null then
            raise exception 'a submission starts queued' using errcode = 'check_violation';
        end if;
        if not exists (select 1 from task_versions where id = new.task_version_id and org_id = new.org_id and state = 'released') then
            raise exception 'only a released version accepts submissions' using errcode = 'check_violation';
        end if;
        return new;
    end if;
    -- The one way out of a finished state: a contest submission goes back to the queue for a rejudge, with the
    -- count raised by one, the verdict handed to previous_verdict and nothing else about the result kept.
    v_rejudge := old.state in ('judged', 'failed_system') and new.state = 'queued' and old.context_kind = 'contest'
        and new.rejudge_count = old.rejudge_count + 1 and new.verdict is null and new.score is null
        and new.judged_at is null
        and new.previous_verdict is not distinct from old.verdict and new.previous_score is not distinct from old.score;
    if old.state in ('judged', 'failed_system', 'cancelled') and not v_rejudge then
        raise exception 'a finished submission does not change' using errcode = 'insufficient_privilege';
    end if;
    if new.source <> old.source or new.source_sha256 <> old.source_sha256 or new.user_id <> old.user_id
       or new.task_version_id <> old.task_version_id or new.language <> old.language then
        raise exception 'a submission keeps its source, owner, task and language' using errcode = 'insufficient_privilege';
    end if;
    if not v_rejudge and (new.rejudge_count <> old.rejudge_count
       or new.previous_verdict is distinct from old.previous_verdict or new.previous_score is distinct from old.previous_score) then
        raise exception 'only a rejudge changes the rejudge record' using errcode = 'insufficient_privilege';
    end if;
    if new.state <> old.state and not v_rejudge and not (old.state || '>' || new.state) = any (array[
        'queued>judging', 'queued>cancelled', 'judging>judged', 'judging>failed_system',
        'judging>queued']) then
        raise exception 'a submission cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;

create function rejudge_contest_submission(p_submission uuid, p_now timestamptz, p_ready_max int) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_sub submissions%rowtype;
    v_contest contests%rowtype;
    v_job uuid;
begin
    select * into v_sub from submissions where id = p_submission and context_kind = 'contest' for update;
    if not found then
        raise exception 'no such contest submission' using errcode = 'no_data_found';
    end if;
    select * into v_contest from contests where id = v_sub.context_id;
    if app_org_role(v_contest.org_id) is null or app_org_role(v_contest.org_id) not in ('owner', 'admin') then
        raise exception 'no such contest submission' using errcode = 'no_data_found';
    end if;
    if v_contest.state = 'finalized' or v_sub.state not in ('judged', 'failed_system') then
        raise exception 'this submission cannot be rejudged now' using errcode = 'object_not_in_prerequisite_state';
    end if;
    if (select count(*) from jobs where queue = 'judge' and state = 'ready') >= p_ready_max then
        raise exception 'the judge queue is full' using errcode = 'configuration_limit_exceeded';
    end if;
    delete from verdict_details where submission_id = p_submission;
    update submissions set state = 'queued', verdict = null, score = null, judged_at = null, updated_at = p_now,
           rejudge_count = rejudge_count + 1, previous_verdict = v_sub.verdict, previous_score = v_sub.score
     where id = p_submission;
    insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
    values ('judge.tier1', v_sub.org_id, jsonb_build_object('submission_id', p_submission), 'judge', 1, 5, p_now,
            'submission:' || p_submission::text || ':rejudge:' || (v_sub.rejudge_count + 1)::text, p_now, p_now)
    returning id into v_job;
    return v_job;
end
$$;

-- The scoreboard reads a submission under rejudge by its old verdict until the new one lands.
create or replace function scoreboard_stamp(p_contest uuid) returns text
    language sql stable security definer set search_path = pg_catalog, public as $$
    select c.state || ':' || coalesce(c.unfrozen_at::text, '') || ':' || count(s.id)::text || ':'
           || coalesce(max(s.updated_at)::text, '')
      from contests c
      left join submissions s on s.context_id = c.id and (s.state = 'judged' or s.previous_verdict is not null)
     where c.id = p_contest
     group by c.state, c.unfrozen_at
$$;

create or replace function scoreboard_input(p_contest uuid) returns jsonb
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
    v_contest contests%rowtype;
    v_result jsonb;
begin
    select * into v_contest from contests where id = p_contest;
    if not found or v_contest.state not in ('running', 'frozen', 'ended', 'finalized') then
        raise exception 'no scoreboard for this contest' using errcode = 'P0002';
    end if;
    select jsonb_build_object(
        'contest_id', v_contest.id,
        'org_id', v_contest.org_id,
        'format', v_contest.rules ->> 'format',
        'penalty_minutes_per_wrong', coalesce((v_contest.rules ->> 'penalty_minutes_per_wrong')::int, 0),
        'starts_at_ms', (extract(epoch from v_contest.starts_at) * 1000)::bigint,
        'ends_at_ms', (extract(epoch from v_contest.ends_at) * 1000)::bigint,
        -- Once unfrozen the freeze no longer hides anything: the public board is the whole truth.
        'freeze_at_ms', case when v_contest.unfrozen_at is null
                             then (extract(epoch from v_contest.freeze_at) * 1000)::bigint end,
        'stamp', scoreboard_stamp(p_contest),
        'problems', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'points', points) order by label)
                                from contest_problems where contest_id = p_contest), '[]'::jsonb),
        'registrants', coalesce((select jsonb_agg(jsonb_build_object(
                'user_id', r.user_id, 'order', r.ord - 1,
                'handle', case when p.visibility = 'public' then p.handle::text end,
                'display_name', case when p.visibility = 'public' then p.display_name end) order by r.ord)
            from (select user_id, row_number() over (order by created_at, user_id) as ord
                    from registrations where contest_id = p_contest) r
            left join profiles p on p.user_id = r.user_id), '[]'::jsonb),
        'events', coalesce((select jsonb_agg(jsonb_build_object(
                'user_id', s.user_id, 'label', cp.label,
                'submitted_at_ms', (extract(epoch from s.created_at) * 1000)::bigint,
                'verdict', coalesce(s.verdict, s.previous_verdict),
                'score', case when s.verdict is not null then s.score else s.previous_score end) order by s.created_at, s.id)
            from submissions s
            join contest_problems cp on cp.contest_id = p_contest and cp.task_version_id = s.task_version_id
            where s.context_id = p_contest and (s.state = 'judged' or s.previous_verdict is not null)), '[]'::jsonb))
    into v_result;
    return v_result;
end
$$;

revoke all on function unfreeze_contest(uuid, timestamptz), rejudge_contest_submission(uuid, timestamptz, int) from public;
grant execute on function unfreeze_contest(uuid, timestamptz), rejudge_contest_submission(uuid, timestamptz, int) to aura_app;
