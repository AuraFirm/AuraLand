-- Comments on a task version (Stage 4A, authoring workspace). People who work on a task talk about a
-- version here instead of in mail, so the discussion stays with the work and with the audit trail.
--   * owners and admins read and write on every version; setters and reviewers on versions of tasks
--     they made or were assigned (migration 0024); nobody else, plain members included;
--   * a comment never changes and is never deleted: a correction is a new comment;
--   * threads are one level deep: a reply points to a top-level comment of the same version.

create table version_comments (
    id uuid primary key default uuidv7(),
    org_id uuid not null,
    task_version_id uuid not null,
    author_id uuid not null references users (id),
    parent_id uuid references version_comments (id),
    body text not null,
    created_at timestamptz not null,
    foreign key (task_version_id, org_id) references task_versions (id, org_id),
    constraint version_comments_body check (char_length(body) between 1 and 8000 and octet_length(body) <= 32768 and body !~ '\x00')
);
create index version_comments_version on version_comments (task_version_id, created_at, id);
create index version_comments_parent on version_comments (parent_id) where parent_id is not null;

create function version_comments_guard() returns trigger language plpgsql as $$
declare
    v_parent version_comments%rowtype;
begin
    if tg_op <> 'INSERT' then
        raise exception 'a comment never changes and is never deleted' using errcode = 'insufficient_privilege';
    end if;
    if new.parent_id is not null then
        select * into v_parent from version_comments where id = new.parent_id;
        if not found or v_parent.task_version_id <> new.task_version_id or v_parent.parent_id is not null then
            raise exception 'a reply goes to a top-level comment of the same version' using errcode = 'check_violation';
        end if;
    end if;
    return new;
end
$$;
create trigger version_comments_guard before insert or update or delete on version_comments
    for each row execute function version_comments_guard();

alter table version_comments enable row level security;
alter table version_comments force row level security;
create policy version_comments_read on version_comments for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')
           or (app_org_role(org_id) in ('setter', 'reviewer') and app_version_staff(task_version_id)));
create policy version_comments_insert on version_comments for insert to aura_app
    with check (author_id = app_user()
                and (app_org_role(org_id) in ('owner', 'admin')
                     or (app_org_role(org_id) in ('setter', 'reviewer') and app_version_staff(task_version_id))));
grant select on version_comments to aura_app;
grant insert (org_id, task_version_id, author_id, parent_id, body, created_at) on version_comments to aura_app;
