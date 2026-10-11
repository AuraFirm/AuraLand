-- Submissions: source code sent to a released task, and the verdict that comes back (Stage 3).
-- Rules that must never break are database rules:
--   * a submission is for a released version of a task in one organization (composite key);
--   * it starts queued; its state only moves forward (queued -> judging -> judged | failed_system,
--     or queued -> cancelled), and a verdict exists exactly when it is judged;
--   * once judged it never changes; the source and its hash never change at all;
--   * its owner and their organization's owners and admins can read it, nobody else.
-- The people who run the judge write verdicts through the worker role; participants only create.

create table submissions (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    user_id uuid not null references users (id),
    task_version_id uuid not null,
    context_kind text not null default 'practice',
    language text not null,
    source text not null,
    source_sha256 bytea not null,
    source_bytes int not null,
    state text not null default 'queued',
    verdict text,
    score numeric(9, 3),
    judged_at timestamptz,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    foreign key (task_version_id, org_id) references task_versions (id, org_id),
    unique (id, org_id),
    constraint submissions_context check (context_kind in ('practice')),
    constraint submissions_language check (language ~ '^[a-z][a-z0-9_+.-]{0,31}$'),
    constraint submissions_source_size check (source_bytes between 1 and 262144 and octet_length(source) = source_bytes),
    constraint submissions_source_text check (source !~ '\x00'),
    constraint submissions_hash_size check (octet_length(source_sha256) = 32),
    constraint submissions_state check (state in ('queued', 'judging', 'judged', 'failed_system', 'cancelled')),
    constraint submissions_verdict check (verdict is null or verdict in ('AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'CE', 'PARTIAL', 'SE')),
    constraint submissions_judged_pair check ((state = 'judged') = (verdict is not null)),
    constraint submissions_judged_at check ((state in ('judged', 'failed_system')) = (judged_at is not null)),
    constraint submissions_score check (score is null or score between 0 and 1000000)
);
create index submissions_user on submissions (user_id, created_at desc, id desc);
create index submissions_version on submissions (task_version_id, created_at desc, id desc);
create index submissions_org on submissions (org_id, created_at desc, id desc);

create table verdict_details (
    submission_id uuid not null,
    org_id uuid not null,
    test_id text not null,
    verdict text not null,
    cpu_ms int not null,
    wall_ms int not null,
    memory_kib int not null,
    checker_msg text,
    primary key (submission_id, test_id),
    foreign key (submission_id, org_id) references submissions (id, org_id) on delete cascade,
    constraint verdict_details_verdict check (verdict in ('AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'CE', 'SE')),
    constraint verdict_details_numbers check (cpu_ms between 0 and 3600000 and wall_ms between 0 and 3600000 and memory_kib between 0 and 8388608),
    constraint verdict_details_test_id check (test_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
    constraint verdict_details_msg check (checker_msg is null or (char_length(checker_msg) <= 2048 and checker_msg !~ '[[:cntrl:]]'))
);

create function submissions_guard() returns trigger language plpgsql as $$
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
    if old.state in ('judged', 'failed_system', 'cancelled') then
        raise exception 'a finished submission does not change' using errcode = 'insufficient_privilege';
    end if;
    if new.source <> old.source or new.source_sha256 <> old.source_sha256 or new.user_id <> old.user_id
       or new.task_version_id <> old.task_version_id or new.language <> old.language then
        raise exception 'a submission keeps its source, owner, task and language' using errcode = 'insufficient_privilege';
    end if;
    if new.state <> old.state and not (old.state || '>' || new.state) = any (array[
        'queued>judging', 'queued>cancelled', 'judging>judged', 'judging>failed_system',
        'judging>queued']) then
        raise exception 'a submission cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger submissions_guard before insert or update on submissions
    for each row execute function submissions_guard();

alter table submissions enable row level security;
alter table submissions force row level security;
alter table verdict_details enable row level security;
alter table verdict_details force row level security;

create policy submissions_read on submissions for select to aura_app
    using (user_id = app_user() or app_org_role(org_id) in ('owner', 'admin'));
create policy submissions_insert on submissions for insert to aura_app
    with check (user_id = app_user() and app_org_role(org_id) is not null);
create policy submissions_worker on submissions for all to aura_worker using (true) with check (true);

create policy verdict_details_read on verdict_details for select to aura_app
    using (exists (select 1 from submissions s where s.id = submission_id));
create policy verdict_details_worker on verdict_details for all to aura_worker using (true) with check (true);

grant select (id, org_id, user_id, task_version_id, context_kind, language, source, source_bytes, state,
              verdict, score, judged_at, created_at, updated_at) on submissions to aura_app;
grant insert (org_id, user_id, task_version_id, language, source, source_sha256, source_bytes, created_at, updated_at)
    on submissions to aura_app;
grant select, insert, update on submissions to aura_worker;
grant select on verdict_details to aura_app;
grant select, insert on verdict_details to aura_worker;

-- Putting a submission on the judge queue is part of creating it: this runs inside the request's
-- transaction as the function owner, checks the caller owns the submission, and refuses when the
-- queue is already long (load shedding). The job names only the submission; the node fetches the rest.
create function enqueue_judge_job(p_submission uuid, p_now timestamptz, p_ready_max int) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    job_id uuid;
    owner uuid;
    submitted_org uuid;
begin
    select user_id, org_id into owner, submitted_org from submissions where id = p_submission and state = 'queued';
    if owner is null or owner is distinct from app_user() then
        raise exception 'not your queued submission' using errcode = 'insufficient_privilege';
    end if;
    if (select count(*) from jobs where queue = 'judge' and state = 'ready') >= p_ready_max then
        raise exception 'the judge queue is full' using errcode = 'configuration_limit_exceeded';
    end if;
    insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
    values ('judge.tier1', submitted_org, jsonb_build_object('submission_id', p_submission), 'judge', 5, 5, p_now,
            'submission:' || p_submission::text, p_now, p_now)
    returning id into job_id;
    return job_id;
end
$$;
revoke all on function enqueue_judge_job(uuid, timestamptz, int) from public;
grant execute on function enqueue_judge_job(uuid, timestamptz, int) to aura_app;
