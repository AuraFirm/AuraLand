-- Organizations and memberships: the first tenant data. An organization is the unit of isolation: a
-- person sees an organization only through a membership, in code and here in PostgreSQL.
--
-- Roles: owner (everything), admin (can remove plain members), member (can read, and leave).
-- Rules that must never break are database rules, not only application checks:
--   * an organization always keeps at least one owner (two simultaneous removals cannot empty it);
--   * a person belongs to at most 20 organizations;
--   * personal spaces have a reserved slug shape nobody else can take.
-- RLS is enabled but not forced on these two tables: the helper functions below are SECURITY DEFINER
-- and must read memberships to answer "what is my role here?", which the policies themselves need.
-- The application roles are not the owner, so the policies bind them fully.

create table orgs (
    id uuid primary key default uuidv7(),
    kind text not null,
    slug citext not null unique,
    name text not null,
    verification_state text not null default 'unverified',
    verified_at timestamptz,
    data_region text not null default 'eu',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint orgs_kind check (kind in ('personal', 'university', 'company', 'ai_lab', 'community', 'platform')),
    constraint orgs_slug_format check (slug::text ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' and char_length(slug::text) between 3 and 40),
    -- Personal spaces use "p-" plus ten hex digits, and nothing else may look like that.
    constraint orgs_personal_slug check ((kind = 'personal') = (slug::text ~ '^p-[0-9a-f]{10}$')),
    constraint orgs_name check (char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
    constraint orgs_verification_state check (verification_state in ('unverified', 'verified')),
    constraint orgs_verified_pair check ((verification_state = 'verified') = (verified_at is not null)),
    constraint orgs_data_region check (data_region in ('eu', 'us', 'ap'))
);
create trigger orgs_updated_at before update on orgs for each row execute function set_updated_at();

create table memberships (
    org_id uuid not null references orgs (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    role text not null,
    created_at timestamptz not null default now(),
    primary key (org_id, user_id),
    constraint memberships_role check (role in ('owner', 'admin', 'member'))
);
create index memberships_user on memberships (user_id, org_id);

-- What is the current person's role in this organization? Null when they are not a member.
create function app_org_role(p_org uuid) returns text language sql stable security definer
    set search_path = pg_catalog, public as $$
    select m.role from memberships m
    where m.org_id = p_org and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Do the current person and this other person share an organization?
create function app_shares_org(p_user uuid) returns boolean language sql stable security definer
    set search_path = pg_catalog, public as $$
    select exists (
        select 1 from memberships mine join memberships theirs on theirs.org_id = mine.org_id
        where mine.user_id = nullif(current_setting('app.user_id', true), '')::uuid
          and theirs.user_id = p_user)
$$;
revoke all on function app_org_role(uuid), app_shares_org(uuid) from public;
grant execute on function app_org_role(uuid), app_shares_org(uuid) to aura_app, aura_auth;

-- A person may belong to at most 20 organizations, personal space included. The lock makes
-- simultaneous joins take turns.
create function memberships_cap() returns trigger language plpgsql as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('memberships:' || new.user_id::text, 0));
    if (select count(*) from memberships where user_id = new.user_id) >= 20 then
        raise exception 'a person may belong to at most 20 organizations' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger memberships_cap before insert on memberships for each row execute function memberships_cap();

-- An organization keeps at least one owner. The lock serializes removals within one organization,
-- so two owners leaving at once cannot both pass the check. When the organization itself is being
-- deleted its row is already gone, and its memberships may go.
create function memberships_keep_owner() returns trigger language plpgsql as $$
begin
    if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner')
       and exists (select 1 from orgs where id = old.org_id) then
        perform pg_advisory_xact_lock(hashtextextended('org-owners:' || old.org_id::text, 0));
        if not exists (select 1 from memberships
                       where org_id = old.org_id and role = 'owner' and user_id <> old.user_id) then
            raise exception 'an organization must keep at least one owner' using errcode = 'check_violation';
        end if;
    end if;
    return case tg_op when 'DELETE' then old else new end;
end
$$;
create trigger memberships_keep_owner before update or delete on memberships
    for each row execute function memberships_keep_owner();

alter table orgs enable row level security;
alter table memberships enable row level security;

create policy orgs_identity on orgs for all to aura_auth using (true) with check (true);
create policy orgs_member_read on orgs for select to aura_app using (app_org_role(id) is not null);
create policy orgs_manage on orgs for update to aura_app
    using (app_org_role(id) in ('owner', 'admin')) with check (app_org_role(id) in ('owner', 'admin'));

create policy memberships_identity on memberships for all to aura_auth using (true) with check (true);
create policy memberships_member_read on memberships for select to aura_app
    using (app_org_role(org_id) is not null);
-- Only owners change roles. Leaving is always allowed (the owner rule above still applies); owners
-- remove anyone; admins remove plain members only.
create policy memberships_owner_update on memberships for update to aura_app
    using (app_org_role(org_id) = 'owner') with check (app_org_role(org_id) = 'owner');
create policy memberships_remove on memberships for delete to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid
           or app_org_role(org_id) = 'owner'
           or (app_org_role(org_id) = 'admin' and role = 'member'));

grant select on orgs to aura_app;
grant update (name) on orgs to aura_app;
grant select, insert on orgs to aura_auth;
grant update (verification_state, verified_at) on orgs to aura_auth;
grant select on memberships to aura_app;
grant update (role) on memberships to aura_app;
grant delete on memberships to aura_app;
grant select, insert on memberships to aura_auth;

-- People who share an organization may see each other's profile (handle and display name).
create policy profiles_org_read on profiles for select to aura_app using (app_shares_org(user_id));

-- Creating an organization is one atomic step with a fixed shape: the caller becomes its first owner.
-- It is a function, not direct inserts, because a person may not insert organizations or
-- memberships themselves (that would let them make themselves owner of anything).
create function create_org(p_kind text, p_slug text, p_name text, p_region text) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_org uuid;
begin
    if v_user is null then
        raise exception 'sign in to create an organization' using errcode = 'insufficient_privilege';
    end if;
    if p_kind not in ('university', 'company', 'ai_lab', 'community') then
        raise exception 'this kind of organization cannot be created here' using errcode = 'check_violation';
    end if;
    insert into orgs (kind, slug, name, data_region) values (p_kind, p_slug, p_name, p_region)
        returning id into v_org;
    insert into memberships (org_id, user_id, role) values (v_org, v_user, 'owner');
    return v_org;
end
$$;
revoke all on function create_org(text, text, text, text) from public;
grant execute on function create_org(text, text, text, text) to aura_app;

-- Every existing person gets a personal space. New people get theirs when the account is created.
insert into orgs (kind, slug, name)
select 'personal', 'p-' || substr(md5(u.id::text), 1, 10), 'Personal space' from users u;
insert into memberships (org_id, user_id, role)
select o.id, u.id, 'owner' from users u join orgs o on o.slug::text = 'p-' || substr(md5(u.id::text), 1, 10);
