-- Contests (Stage 5, ADR 0031). A contest belongs to a host organization, uses released task versions as
-- problems, and has people register for it. The rule that matters most is who may read a problem and
-- submit to it without belonging to the task's organization: a registered person, from the start until
-- the end, for exactly the contest's own problems. It lives here, in the database.

create table contests (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    slug citext not null,
    title text not null,
    format text not null,
    rules jsonb not null,
    visibility text not null default 'public',
    ai_policy text not null default 'none',
    rated boolean not null default false,
    assurance_level smallint not null default 0,
    state text not null default 'draft',
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    freeze_at timestamptz,
    finalized_at timestamptz,
    created_by uuid not null references users (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (org_id, slug),
    unique (id, org_id),
    constraint contests_slug check (slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    constraint contests_title check (char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]'),
    constraint contests_format check (format in ('icpc', 'ioi')),
    constraint contests_rules check (jsonb_typeof(rules) = 'object' and rules ->> 'format' = format),
    constraint contests_visibility check (visibility in ('public', 'unlisted', 'private')),
    constraint contests_ai_policy check (ai_policy in ('none', 'allowed_logged', 'agents_only')),
    -- Identity proofs are Stage 6 and 7: only level 0 exists.
    constraint contests_assurance check (assurance_level = 0),
    constraint contests_state check (state in ('draft', 'scheduled', 'running', 'frozen', 'ended', 'finalized')),
    constraint contests_window check (ends_at > starts_at and ends_at <= starts_at + interval '7 days'
                                       and ends_at >= starts_at + interval '5 minutes'),
    constraint contests_freeze check (freeze_at is null or (freeze_at > starts_at and freeze_at < ends_at)),
    constraint contests_finalized check ((state = 'finalized') = (finalized_at is not null))
);
create index contests_org on contests (org_id, starts_at desc, id desc);
create index contests_public on contests (starts_at desc, id desc) where visibility = 'public' and state <> 'draft';
create index contests_open on contests (state, starts_at) where state in ('scheduled', 'running', 'frozen', 'ended');
create index contests_created_by on contests (created_by);
create trigger contests_updated_at before update on contests
    for each row execute function set_updated_at();

create table contest_problems (
    contest_id uuid not null,
    org_id uuid not null,
    label text not null,
    task_version_id uuid not null,
    task_org_id uuid not null,
    points int not null default 100,
    primary key (contest_id, label),
    unique (contest_id, task_version_id),
    foreign key (contest_id, org_id) references contests (id, org_id) on delete cascade,
    foreign key (task_version_id, task_org_id) references task_versions (id, org_id),
    constraint contest_problems_label check (label ~ '^[A-Z][A-Z0-9]{0,2}$'),
    constraint contest_problems_points check (points between 1 and 1000)
);
create index contest_problems_version on contest_problems (task_version_id, task_org_id);

create table registrations (
    contest_id uuid not null references contests (id) on delete cascade,
    user_id uuid not null references users (id),
    created_at timestamptz not null,
    primary key (contest_id, user_id)
);
create index registrations_user on registrations (user_id, created_at desc);

-- ---- the guards -------------------------------------------------------------------------------

-- A contest is hosted by a real organization, not a personal space.
create function contests_guard() returns trigger language plpgsql security definer
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
    if new.state <> old.state and not (old.state || '>' || new.state) = any (array[
        'draft>scheduled', 'scheduled>running', 'running>frozen', 'running>ended', 'frozen>ended', 'ended>finalized']) then
        raise exception 'a contest cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger contests_guard before insert or update on contests
    for each row execute function contests_guard();

-- The problem set is the host's to arrange while the contest is a draft, and fixed after.
create function contest_problems_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    v_state text;
    v_version task_versions%rowtype;
    v_task_visibility text;
    v_task_org_kind text;
begin
    select state into v_state from contests where id = coalesce(new.contest_id, old.contest_id);
    if v_state is distinct from 'draft' then
        raise exception 'the problems of a published contest do not change' using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'DELETE' then
        return old;
    end if;
    select * into v_version from task_versions where id = new.task_version_id and org_id = new.task_org_id;
    if not found or v_version.state <> 'released' then
        raise exception 'a contest uses released versions only' using errcode = 'check_violation';
    end if;
    -- The host's own tasks, or public tasks of a platform organization (the problem bank).
    if new.task_org_id <> new.org_id then
        select t.visibility, o.kind into v_task_visibility, v_task_org_kind
          from tasks t join orgs o on o.id = t.org_id where t.id = v_version.task_id;
        if v_task_org_kind is distinct from 'platform' or v_task_visibility is distinct from 'public' then
            raise exception 'a contest uses its host''s problems or the platform bank' using errcode = 'check_violation';
        end if;
    end if;
    if (select count(*) from contest_problems where contest_id = new.contest_id) >= 36 and tg_op = 'INSERT' then
        raise exception 'a contest has at most 36 problems' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger contest_problems_guard before insert or update or delete on contest_problems
    for each row execute function contest_problems_guard();

-- A version in a running or finished-but-open contest must stay released: retiring it would break the
-- submissions the contest is still taking or about to rate.
create function task_versions_retire_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    if new.state = 'retired' and old.state = 'released' and exists (
        select 1 from contest_problems p join contests c on c.id = p.contest_id
         where p.task_version_id = old.id and c.state in ('scheduled', 'running', 'frozen', 'ended')
    ) then
        raise exception 'a version used by a live contest cannot be retired' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger task_versions_retire_guard before update on task_versions
    for each row execute function task_versions_retire_guard();

-- ---- row-level security -----------------------------------------------------------------------

alter table contests enable row level security;
alter table contests force row level security;
alter table contest_problems enable row level security;
alter table contest_problems force row level security;
alter table registrations enable row level security;
alter table registrations force row level security;

-- Drafts are the host staff's. A published contest is visible to everyone when public or unlisted (the
-- listing query asks for public only), and to the host's members when private.
create policy contests_read on contests for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin', 'setter', 'reviewer')
           or (state <> 'draft' and (visibility in ('public', 'unlisted') or app_org_role(org_id) is not null)));
create policy contests_insert on contests for insert to aura_app
    with check (app_org_role(org_id) in ('owner', 'admin') and created_by = app_user());
create policy contests_update on contests for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin') and state = 'draft')
    with check (app_org_role(org_id) in ('owner', 'admin') and state = 'draft');
create policy contests_worker on contests for select to aura_worker using (true);

-- The problem list is the host staff's until the contest starts; from then on it is as visible as the
-- contest. (Reading a problem's statement is a different, narrower right, below.)
create policy contest_problems_read on contest_problems for select to aura_app
    using (exists (select 1 from contests c where c.id = contest_id
                   and (app_org_role(c.org_id) in ('owner', 'admin', 'setter', 'reviewer')
                        or c.state in ('running', 'frozen', 'ended', 'finalized'))));
create policy contest_problems_write on contest_problems for all to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'))
    with check (app_org_role(org_id) in ('owner', 'admin'));
create policy contest_problems_worker on contest_problems for select to aura_worker using (true);

create policy registrations_read on registrations for select to aura_app
    using (user_id = app_user()
           or exists (select 1 from contests c where c.id = contest_id and app_org_role(c.org_id) in ('owner', 'admin')));
create policy registrations_worker on registrations for select to aura_worker using (true);

grant select on contests to aura_app;
grant insert (org_id, slug, title, format, rules, visibility, ai_policy, rated, starts_at, ends_at, freeze_at, created_by)
    on contests to aura_app;
grant update (title, rules, visibility, ai_policy, rated, starts_at, ends_at, freeze_at) on contests to aura_app;
grant select on contest_problems to aura_app;
grant insert (contest_id, org_id, label, task_version_id, task_org_id, points) on contest_problems to aura_app;
grant update (label, points) on contest_problems to aura_app;
grant delete on contest_problems to aura_app;
grant select on registrations to aura_app;
grant select on contests, contest_problems, registrations to aura_worker;

-- ---- who may read a problem ---------------------------------------------------------------------

-- Does the current person take part in a contest that is under way (or over) and uses this version? The
-- statement of a problem is theirs to read from the start until the contest is finalized, never before.
create function app_reads_contest_problem(p_version uuid) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select exists (
        select 1 from contest_problems p
          join contests c on c.id = p.contest_id
          join registrations r on r.contest_id = c.id and r.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         where p.task_version_id = p_version and c.state in ('running', 'frozen', 'ended', 'finalized'))
$$;
revoke all on function app_reads_contest_problem(uuid) from public;
grant execute on function app_reads_contest_problem(uuid) to aura_app;

create policy task_versions_contest_read on task_versions for select to aura_app
    using (state = 'released' and app_reads_contest_problem(id));

-- ---- registering and moving a contest ----------------------------------------------------------

-- Anyone signed in may register for a published contest until it ends, except people who could know the
-- answers: the staff of the host and of the organizations of the problems.
create function register_for_contest(p_contest uuid, p_now timestamptz) returns text
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_contest contests%rowtype;
    v_org uuid;
begin
    if v_user is null then
        raise exception 'sign in to register' using errcode = 'insufficient_privilege';
    end if;
    select * into v_contest from contests where id = p_contest;
    if not found or v_contest.state not in ('scheduled', 'running', 'frozen') or p_now >= v_contest.ends_at
       or (v_contest.visibility = 'private' and app_org_role(v_contest.org_id) is null) then
        raise exception 'no such contest open for registration' using errcode = 'no_data_found';
    end if;
    for v_org in select distinct o from (select v_contest.org_id as o union select task_org_id from contest_problems
                                          where contest_id = p_contest) orgs loop
        if app_org_role(v_org) in ('owner', 'admin', 'setter', 'reviewer') then
            raise exception 'organizers and problem authors do not compete' using errcode = 'check_violation';
        end if;
    end loop;
    insert into registrations (contest_id, user_id, created_at) values (p_contest, v_user, p_now)
    on conflict do nothing;
    return case when found then 'registered' else 'already' end;
end
$$;

create function publish_contest(p_contest uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_contest contests%rowtype;
begin
    select * into v_contest from contests where id = p_contest for update;
    if not found or app_org_role(v_contest.org_id) is null or app_org_role(v_contest.org_id) not in ('owner', 'admin')
       or v_contest.state <> 'draft' then
        raise exception 'no such draft contest' using errcode = 'no_data_found';
    end if;
    if p_now >= v_contest.starts_at then
        raise exception 'a contest is published before it starts' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from contest_problems where contest_id = p_contest) then
        raise exception 'a contest needs at least one problem' using errcode = 'check_violation';
    end if;
    update contests set state = 'scheduled' where id = p_contest;
end
$$;

create function finalize_contest(p_contest uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_contest contests%rowtype;
begin
    select * into v_contest from contests where id = p_contest for update;
    if not found or app_org_role(v_contest.org_id) is null or app_org_role(v_contest.org_id) not in ('owner', 'admin')
       or v_contest.state <> 'ended' then
        raise exception 'no such ended contest' using errcode = 'no_data_found';
    end if;
    update contests set state = 'finalized', finalized_at = p_now where id = p_contest;
end
$$;

-- The clock moves contests: scheduled to running at the start, running to frozen at the freeze, and either
-- to ended at the end. Idempotent; a contest that was skipped (a stopped worker) catches up through every
-- state it passed. Returns what moved, for the audit trail.
create function advance_contests(p_now timestamptz) returns table (contest_id uuid, from_state text, to_state text)
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_contest contests%rowtype;
    v_state text;
    v_next text;
begin
    for v_contest in select * from contests where state in ('scheduled', 'running', 'frozen') and starts_at <= p_now
                      order by starts_at, id limit 200 for update skip locked loop
        v_state := v_contest.state;
        loop
            v_next := case
                when v_state = 'scheduled' and p_now >= v_contest.starts_at then 'running'
                when v_state = 'running' and p_now >= v_contest.ends_at then 'ended'
                when v_state = 'running' and v_contest.freeze_at is not null and p_now >= v_contest.freeze_at then 'frozen'
                when v_state = 'frozen' and p_now >= v_contest.ends_at then 'ended'
                else null end;
            exit when v_next is null;
            update contests set state = v_next where id = v_contest.id;
            contest_id := v_contest.id; from_state := v_state; to_state := v_next;
            return next;
            v_state := v_next;
        end loop;
    end loop;
end
$$;

revoke all on function register_for_contest(uuid, timestamptz), publish_contest(uuid, timestamptz),
    finalize_contest(uuid, timestamptz), advance_contests(timestamptz) from public;
grant execute on function register_for_contest(uuid, timestamptz), publish_contest(uuid, timestamptz),
    finalize_contest(uuid, timestamptz) to aura_app;
grant execute on function advance_contests(timestamptz) to aura_worker;
