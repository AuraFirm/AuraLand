-- Tasks and their versions (Stage 2). A task is a named problem owned by one organization; a task
-- version is one immutable-once-released snapshot of it: a spec, a statement and a bundle that is
-- known only by its size and SHA-256 (the storage key is derived from the organization and the hash,
-- so it is not a column and cannot leak through one).
--
-- Rules that must never break are database rules, not only application checks:
--   * a released version cannot change, except to be retired; neither can its bundle fields once set;
--   * states move only along the allowed pairs (the application state machine mirrors this list);
--   * at most one version per task is released, and at most one is being validated;
--   * a version's creator never reviews it, and never releases it;
--   * a release needs an approving review, and a waived release is marked as such;
--   * version numbers are gapless per task, and the counts per organization and per task are capped.
-- Reading: people with a content role (owner, admin, setter, reviewer) see everything of their
-- organization's tasks; plain members see released versions of tasks whose visibility is "org".

alter table memberships drop constraint memberships_role;
alter table memberships add constraint memberships_role
    check (role in ('owner', 'admin', 'setter', 'reviewer', 'member'));

create table tasks (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id) on delete cascade,
    slug citext not null,
    kind text not null,
    visibility text not null default 'private',
    title text not null,
    created_by uuid not null references users (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (org_id, slug),
    unique (id, org_id),
    constraint tasks_slug_format check (slug::text ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' and char_length(slug::text) between 3 and 40),
    constraint tasks_kind check (kind in ('algorithmic', 'function', 'repo_env', 'sql', 'agent_env')),
    constraint tasks_visibility check (visibility in ('private', 'org', 'public', 'licensed')),
    constraint tasks_title check (char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]')
);
create trigger tasks_updated_at before update on tasks for each row execute function set_updated_at();

-- The guards below run as the table owner: counts and numbering must not depend on which rows the
-- caller's row-level security lets them see.
-- Kind and the owning organization never change after creation. At most 1,000 tasks per organization;
-- simultaneous creations take turns.
create function tasks_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    if tg_op = 'INSERT' then
        perform pg_advisory_xact_lock(hashtextextended('tasks:' || new.org_id::text, 0));
        if (select count(*) from tasks where org_id = new.org_id) >= 1000 then
            raise exception 'an organization may have at most 1000 tasks' using errcode = 'check_violation';
        end if;
    elsif new.kind <> old.kind or new.org_id <> old.org_id or new.slug <> old.slug then
        raise exception 'a task keeps its kind, slug and organization' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger tasks_guard before insert or update on tasks for each row execute function tasks_guard();

create table task_versions (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    task_id uuid not null,
    seq int not null,
    state text not null default 'draft',
    spec jsonb,
    statement text,
    bundle_bytes bigint,
    bundle_sha256 bytea,
    waived boolean not null default false,
    created_by uuid not null references users (id),
    released_by uuid references users (id),
    released_at timestamptz,
    -- When the version last entered review. Set by the guard trigger, never by a person. A release
    -- needs an approval from this stint, so an approval cannot outlive the content it approved.
    submitted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (task_id, org_id) references tasks (id, org_id) on delete cascade,
    unique (task_id, seq),
    unique (id, org_id),
    constraint task_versions_seq check (seq between 1 and 100),
    constraint task_versions_state check (state in ('draft', 'uploaded', 'in_review', 'validating', 'validated', 'released', 'retired', 'rejected')),
    constraint task_versions_spec_size check (spec is null or pg_column_size(spec) <= 262144),
    constraint task_versions_statement_size check (statement is null or (octet_length(statement) between 1 and 65536 and statement !~ '\x00')),
    constraint task_versions_bundle_size check (bundle_bytes is null or bundle_bytes between 1 and 67108864),
    constraint task_versions_bundle_hash check (bundle_sha256 is null or octet_length(bundle_sha256) = 32),
    constraint task_versions_bundle_pair check ((bundle_bytes is null) = (bundle_sha256 is null)),
    -- Pair assertions with the state machine: what each state must already have.
    constraint task_versions_bundle_present check (
        state in ('draft', 'rejected') or bundle_sha256 is not null),
    constraint task_versions_draft_empty check (state <> 'draft' or bundle_sha256 is null),
    constraint task_versions_content_present check (
        state in ('draft', 'uploaded', 'rejected') or (spec is not null and statement is not null)),
    constraint task_versions_release_pair check (
        (state in ('released', 'retired')) = (released_at is not null and released_by is not null)),
    constraint task_versions_submitted check (state in ('draft', 'uploaded', 'rejected') or submitted_at is not null),
    constraint task_versions_waiver check (not waived or state in ('released', 'retired')),
    constraint task_versions_no_self_release check (released_by is null or released_by <> created_by)
);
create index task_versions_task on task_versions (task_id, seq);
create index task_versions_org_state on task_versions (org_id, state, id);
create index task_versions_created_by on task_versions (created_by);
create unique index task_versions_one_released on task_versions (task_id) where state = 'released';
create unique index task_versions_one_validating on task_versions (task_id) where state = 'validating';
create trigger task_versions_updated_at before update on task_versions
    for each row execute function set_updated_at();

create table task_reviews (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    task_version_id uuid not null,
    reviewer_id uuid not null references users (id),
    outcome text not null,
    comment text,
    created_at timestamptz not null default now(),
    foreign key (task_version_id, org_id) references task_versions (id, org_id) on delete cascade,
    constraint task_reviews_outcome check (outcome in ('approved', 'changes_requested', 'rejected')),
    constraint task_reviews_comment check (comment is null or (char_length(comment) between 1 and 4000 and comment !~ '\x00'))
);
create index task_reviews_version on task_reviews (task_version_id, created_at, id);
create index task_reviews_reviewer on task_reviews (reviewer_id);

create table bundle_uploads (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    task_version_id uuid not null,
    started_by uuid not null references users (id),
    storage_upload_id text not null,
    expected_bytes bigint not null,
    expected_sha256 bytea not null,
    part_bytes int not null,
    part_count int not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    finished_at timestamptz,
    foreign key (task_version_id, org_id) references task_versions (id, org_id) on delete cascade,
    constraint bundle_uploads_bytes check (expected_bytes between 1 and 67108864),
    constraint bundle_uploads_hash check (octet_length(expected_sha256) = 32),
    constraint bundle_uploads_parts check (part_count between 1 and 100 and part_bytes >= 8388608
        and (part_count::bigint * part_bytes) >= expected_bytes
        and ((part_count - 1)::bigint * part_bytes) < expected_bytes),
    constraint bundle_uploads_storage_id check (char_length(storage_upload_id) between 1 and 1024),
    constraint bundle_uploads_lifetime check (expires_at > created_at and expires_at <= created_at + interval '1 hour 1 minute')
);
create index bundle_uploads_version on bundle_uploads (task_version_id, created_at, id);
create index bundle_uploads_person on bundle_uploads (started_by, created_at, id) where finished_at is null;

-- At most 5 unfinished, unexpired uploads per person; simultaneous starts take turns.
create function bundle_uploads_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('uploads:' || new.started_by::text, 0));
    if (select count(*) from bundle_uploads
        where started_by = new.started_by and finished_at is null and expires_at > new.created_at) >= 5 then
        raise exception 'a person may have at most 5 unfinished uploads' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger bundle_uploads_guard before insert on bundle_uploads
    for each row execute function bundle_uploads_guard();

-- An upload ends once. After that the row is evidence and does not change.
create function bundle_uploads_forward_only() returns trigger language plpgsql as $$
begin
    if old.finished_at is not null then
        raise exception 'a finished upload does not change' using errcode = 'insufficient_privilege';
    end if;
    if new.expected_bytes <> old.expected_bytes or new.expected_sha256 <> old.expected_sha256
       or new.storage_upload_id <> old.storage_upload_id or new.task_version_id <> old.task_version_id then
        raise exception 'an upload keeps its declared size, hash and storage id' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger bundle_uploads_forward_only before update on bundle_uploads
    for each row execute function bundle_uploads_forward_only();

-- Versions: numbering, caps, allowed moves, immutability and the release rules, in one place so the
-- list of allowed state pairs can be read at a glance. The application state machine (rules.ts)
-- encodes the same pairs and a test compares the two.
create function task_versions_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    allowed text[] := array[
        'draft>uploaded', 'uploaded>in_review', 'in_review>uploaded', 'in_review>rejected',
        'in_review>validating', 'in_review>released', 'validating>validated', 'validating>uploaded',
        'validated>released', 'released>retired', 'uploaded>rejected',
        'draft>rejected'];
begin
    if tg_op = 'INSERT' then
        perform pg_advisory_xact_lock(hashtextextended('versions:' || new.task_id::text, 0));
        if new.state <> 'draft' then
            raise exception 'a version starts as a draft' using errcode = 'check_violation';
        end if;
        if new.seq <> coalesce((select max(seq) from task_versions where task_id = new.task_id), 0) + 1 then
            raise exception 'version numbers are consecutive' using errcode = 'check_violation';
        end if;
        return new;
    end if;

    -- A released version is frozen: the only change is retiring it.
    if old.state in ('released', 'retired', 'rejected') then
        if old.state = 'released' and new.state = 'retired'
           and (to_jsonb(new) - 'state' - 'updated_at') = (to_jsonb(old) - 'state' - 'updated_at') then
            return new;
        end if;
        raise exception 'a % version does not change', old.state using errcode = 'insufficient_privilege';
    end if;

    if new.id <> old.id or new.task_id <> old.task_id or new.org_id <> old.org_id
       or new.seq <> old.seq or new.created_by <> old.created_by then
        raise exception 'a version keeps its identity' using errcode = 'insufficient_privilege';
    end if;
    -- The bundle is set once, at the move out of draft, and never replaced.
    if old.bundle_sha256 is not null and (new.bundle_sha256 <> old.bundle_sha256 or new.bundle_bytes <> old.bundle_bytes) then
        raise exception 'a bundle is never replaced; make a new version' using errcode = 'insufficient_privilege';
    end if;
    if new.state <> old.state and not (old.state || '>' || new.state) = any (allowed) then
        raise exception 'a version cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    new.submitted_at := case when new.state = 'in_review' and old.state <> 'in_review' then now()
                             else old.submitted_at end;
    if new.state = 'released' then
        if new.waived <> (old.state = 'in_review') then
            raise exception 'a release is waived exactly when it skipped validation' using errcode = 'check_violation';
        end if;
        if not exists (select 1 from task_reviews
                       where task_version_id = new.id and outcome = 'approved' and reviewer_id <> new.created_by
                         and created_at >= old.submitted_at) then
            raise exception 'a release needs an approving review' using errcode = 'check_violation';
        end if;
    end if;
    return new;
end
$$;
create trigger task_versions_guard before insert or update on task_versions
    for each row execute function task_versions_guard();

-- Versions are never deleted by a person. They go with their task or organization, and a released
-- version only goes with its task (which the application role cannot delete either).
create function task_versions_no_delete() returns trigger language plpgsql as $$
begin
    if old.state in ('released', 'retired') and exists (select 1 from tasks where id = old.task_id) then
        raise exception 'a released version cannot be deleted' using errcode = 'insufficient_privilege';
    end if;
    return old;
end
$$;
create trigger task_versions_no_delete before delete on task_versions
    for each row execute function task_versions_no_delete();

-- Reviews are decisions about a version that is in review, by someone other than its creator.
create function task_reviews_guard() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    version task_versions;
begin
    select * into version from task_versions where id = new.task_version_id;
    if version.created_by = new.reviewer_id then
        raise exception 'nobody reviews their own version' using errcode = 'check_violation';
    end if;
    if version.state <> 'in_review' then
        raise exception 'only a version in review can be reviewed' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger task_reviews_guard before insert on task_reviews
    for each row execute function task_reviews_guard();

alter table tasks enable row level security;
alter table tasks force row level security;
alter table task_versions enable row level security;
alter table task_versions force row level security;
alter table task_reviews enable row level security;
alter table task_reviews force row level security;
alter table bundle_uploads enable row level security;
alter table bundle_uploads force row level security;

create function app_user() returns uuid language sql stable
    set search_path = pg_catalog, public as $$
    select nullif(current_setting('app.user_id', true), '')::uuid
$$;
grant execute on function app_user() to aura_app, aura_auth;

-- Tasks: content roles read everything of their organization; any member reads "org" tasks.
create policy tasks_read on tasks for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin', 'setter', 'reviewer')
           or (visibility = 'org' and app_org_role(org_id) is not null));
create policy tasks_insert on tasks for insert to aura_app
    with check (app_org_role(org_id) in ('owner', 'admin', 'setter') and created_by = app_user());
create policy tasks_update on tasks for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin', 'setter'))
    with check (app_org_role(org_id) in ('owner', 'admin', 'setter'));

-- Versions: content roles see all; plain members see released versions of tasks they can see.
create policy task_versions_read on task_versions for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin', 'setter', 'reviewer')
           or (state = 'released' and exists (select 1 from tasks t where t.id = task_id)));
create policy task_versions_insert on task_versions for insert to aura_app
    with check (app_org_role(org_id) in ('owner', 'admin', 'setter') and created_by = app_user()
                and state = 'draft');
-- Writers change a version while it is theirs to edit and may submit it; reviewers move it onward.
create policy task_versions_write on task_versions for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin', 'setter') and state in ('draft', 'uploaded'))
    with check (app_org_role(org_id) in ('owner', 'admin', 'setter')
                and state in ('draft', 'uploaded', 'in_review', 'rejected'));
create policy task_versions_review on task_versions for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin', 'reviewer')
           and state in ('in_review', 'validating', 'validated', 'released'))
    with check (app_org_role(org_id) in ('owner', 'admin', 'reviewer')
                and state in ('uploaded', 'rejected', 'validating', 'validated', 'released', 'retired')
                and (state <> 'released' or released_by = app_user()));

create policy task_reviews_read on task_reviews for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin', 'setter', 'reviewer'));
create policy task_reviews_insert on task_reviews for insert to aura_app
    with check (app_org_role(org_id) in ('owner', 'admin', 'reviewer') and reviewer_id = app_user());

create policy bundle_uploads_read on bundle_uploads for select to aura_app
    using (started_by = app_user() or app_org_role(org_id) in ('owner', 'admin', 'setter'));
create policy bundle_uploads_insert on bundle_uploads for insert to aura_app
    with check (started_by = app_user() and app_org_role(org_id) in ('owner', 'admin', 'setter'));
create policy bundle_uploads_finish on bundle_uploads for update to aura_app
    using (started_by = app_user()) with check (started_by = app_user());

grant select on tasks to aura_app;
grant insert (org_id, slug, kind, visibility, title, created_by) on tasks to aura_app;
grant update (title, visibility) on tasks to aura_app;
grant select on task_versions to aura_app;
grant insert (org_id, task_id, seq, spec, statement, created_by) on task_versions to aura_app;
grant update (state, spec, statement, bundle_bytes, bundle_sha256, waived, released_by, released_at)
    on task_versions to aura_app;
grant select on task_reviews to aura_app;
grant insert (org_id, task_version_id, reviewer_id, outcome, comment) on task_reviews to aura_app;
grant select on bundle_uploads to aura_app;
grant insert (org_id, task_version_id, started_by, storage_upload_id, expected_bytes, expected_sha256,
              part_bytes, part_count, expires_at) on bundle_uploads to aura_app;
grant update (finished_at) on bundle_uploads to aura_app;
