-- SCIM provisioning (Stage 9, slice 6c): an organization's identity provider creates and deactivates people through a bearer token.
-- Only people whose email is in a domain the organization has proved it controls can be provisioned. Deprovisioning removes the
-- membership (never an owner's) and ends the person's single sign-on sessions; it also stops them signing in through SSO again.
-- The requests come from a machine with no session, so the functions below are the whole interface and run for the worker role.

create table scim_tokens (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    token_hash bytea not null unique,
    created_by uuid not null references users (id),
    created_at timestamptz not null,
    last_used_at timestamptz,
    revoked_at timestamptz,
    constraint scim_tokens_hash check (octet_length(token_hash) = 32)
);
create index scim_tokens_org on scim_tokens (org_id);
create index scim_tokens_created_by on scim_tokens (created_by);
alter table scim_tokens enable row level security;
alter table scim_tokens force row level security;
create policy scim_tokens_read on scim_tokens for select to aura_app
    using (coalesce(app_org_role(org_id) in ('owner', 'admin'), false));
create policy scim_tokens_worker on scim_tokens for select to aura_worker using (true);
grant select (id, org_id, created_by, created_at, last_used_at, revoked_at) on scim_tokens to aura_app;
grant select on scim_tokens to aura_worker;

create table scim_users (
    org_id uuid not null references orgs (id),
    user_id uuid not null references users (id) on delete cascade,
    external_id text,
    active boolean not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    primary key (org_id, user_id),
    unique (org_id, external_id),
    constraint scim_users_external check (external_id is null or char_length(external_id) between 1 and 255)
);
create index scim_users_user on scim_users (user_id);
alter table scim_users enable row level security;
alter table scim_users force row level security;
create policy scim_users_read on scim_users for select to aura_app
    using (coalesce(app_org_role(org_id) in ('owner', 'admin'), false));
create policy scim_users_worker on scim_users for select to aura_worker using (true);
create policy scim_users_identity on scim_users for select to aura_auth using (true);
grant select on scim_users to aura_app, aura_worker, aura_auth;

create function create_scim_token(p_org uuid, p_hash bytea, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_id uuid;
begin
    perform webhook_owner_only(p_org);
    if not coalesce((select scim from org_entitlements(p_org)), false) then
        raise exception 'this plan does not include provisioning' using errcode = 'feature_not_supported';
    end if;
    if (select count(*) from scim_tokens where org_id = p_org and revoked_at is null) >= 5 then
        raise exception 'too many tokens' using errcode = 'program_limit_exceeded';
    end if;
    insert into scim_tokens (org_id, token_hash, created_by, created_at)
    values (p_org, p_hash, nullif(current_setting('app.user_id', true), '')::uuid, p_now) returning id into v_id;
    return v_id;
end
$$;

create function revoke_scim_token(p_id uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
begin
    select org_id into v_org from scim_tokens where id = p_id and revoked_at is null;
    if v_org is null then
        raise exception 'no such token' using errcode = 'no_data_found';
    end if;
    perform webhook_owner_only(v_org);
    update scim_tokens set revoked_at = p_now where id = p_id;
end
$$;
revoke all on function create_scim_token(uuid, bytea, timestamptz), revoke_scim_token(uuid, timestamptz) from public;
grant execute on function create_scim_token(uuid, bytea, timestamptz), revoke_scim_token(uuid, timestamptz) to aura_app;

-- The organization a token belongs to, or null: unknown, revoked, or the organization is no longer on a plan with provisioning.
create function scim_authenticate(p_hash bytea, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
    v_id uuid;
begin
    select id, org_id into v_id, v_org from scim_tokens where token_hash = p_hash and revoked_at is null;
    if v_org is null then
        return null;
    end if;
    if not coalesce((select p.scim from plans p
                      where p.key = coalesce((select c.plan from customers c where c.org_id = v_org), 'free')), false) then
        return null;
    end if;
    update scim_tokens set last_used_at = p_now where id = v_id;
    return v_org;
end
$$;

-- Creates (or finds) the account for an address in one of the organization's verified domains and puts it in the organization.
-- outcome: created | exists | wrong_domain | full
create function scim_provision(p_org uuid, p_email text, p_external text, p_active boolean, p_now timestamptz)
    returns table (user_id uuid, outcome text)
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid;
    v_created boolean := false;
    v_handle text;
    v_personal uuid;
begin
    if not exists (select 1 from sso_domains d where d.org_id = p_org and d.verified_at is not null
                      and d.domain = lower(split_part(p_email, '@', 2))) then
        return query select null::uuid, 'wrong_domain'::text;
        return;
    end if;
    select u.id into v_user from users u where u.email = p_email;
    if v_user is not null and exists (select 1 from scim_users s where s.org_id = p_org and s.user_id = v_user) then
        return query select v_user, 'exists'::text;
        return;
    end if;
    if p_active and not exists (select 1 from memberships m where m.org_id = p_org and m.user_id = coalesce(v_user, gen_random_uuid()))
       and (select count(*) from memberships where org_id = p_org) >= coalesce((select p.members_max from plans p
            where p.key = coalesce((select c.plan from customers c where c.org_id = p_org), 'free')), 0) then
        return query select null::uuid, 'full'::text;
        return;
    end if;
    if v_user is null then
        insert into users (email, email_verified_at) values (p_email, p_now) returning id into v_user;
        v_handle := 'user_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
        insert into profiles (user_id, handle, display_name) values (v_user, v_handle, v_handle);
        insert into orgs (kind, slug, name) values ('personal', 'p-' || substr(v_handle, 6), 'Personal space') returning id into v_personal;
        insert into memberships (org_id, user_id, role) values (v_personal, v_user, 'owner');
        v_created := true;
    end if;
    if p_active then
        insert into memberships (org_id, user_id, role) values (p_org, v_user, 'member') on conflict do nothing;
    end if;
    insert into scim_users (org_id, user_id, external_id, active, created_at, updated_at)
    values (p_org, v_user, p_external, p_active, p_now, p_now);
    return query select v_user, case when v_created then 'created' else 'linked' end;
end
$$;

-- Switches a provisioned person on or off. Off: leave the organization (an owner never does) and end their single sign-on sessions.
create function scim_set_active(p_org uuid, p_user uuid, p_active boolean, p_now timestamptz) returns text
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    if not exists (select 1 from scim_users where org_id = p_org and user_id = p_user) then
        return 'missing';
    end if;
    if p_active then
        if not exists (select 1 from memberships where org_id = p_org and user_id = p_user)
           and (select count(*) from memberships where org_id = p_org) >= coalesce((select p.members_max from plans p
                where p.key = coalesce((select c.plan from customers c where c.org_id = p_org), 'free')), 0) then
            return 'full';
        end if;
        insert into memberships (org_id, user_id, role) values (p_org, p_user, 'member') on conflict do nothing;
    else
        delete from memberships where org_id = p_org and user_id = p_user and role <> 'owner';
        update sessions set revoked_at = p_now, revoked_reason = 'admin'
         where user_id = p_user and auth_method = 'sso' and revoked_at is null;
    end if;
    update scim_users set active = p_active, updated_at = p_now where org_id = p_org and user_id = p_user;
    return 'ok';
end
$$;

-- Forget a provisioned person (SCIM DELETE): deactivate, then drop the record so they could be provisioned again.
create function scim_remove(p_org uuid, p_user uuid, p_now timestamptz) returns boolean
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    if scim_set_active(p_org, p_user, false, p_now) = 'missing' then
        return false;
    end if;
    delete from scim_users where org_id = p_org and user_id = p_user;
    return true;
end
$$;

create function scim_list(p_org uuid, p_email text, p_start int, p_count int)
    returns table (user_id uuid, email text, external_id text, active boolean, created_at timestamptz, updated_at timestamptz, total bigint)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select s.user_id, u.email::text, s.external_id, s.active, s.created_at, s.updated_at, count(*) over ()
      from scim_users s join users u on u.id = s.user_id
     where s.org_id = p_org and (p_email is null or u.email = p_email)
     order by s.created_at, s.user_id offset greatest(p_start - 1, 0) limit least(greatest(p_count, 0), 100)
$$;

-- For the sign-in role: a person the identity provider deprovisioned cannot come back in through single sign-on.
create function sso_scim_inactive(p_org uuid, p_user uuid) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select exists (select 1 from scim_users where org_id = p_org and user_id = p_user and not active)
$$;
revoke all on function scim_authenticate(bytea, timestamptz), scim_provision(uuid, text, text, boolean, timestamptz),
    scim_set_active(uuid, uuid, boolean, timestamptz), scim_remove(uuid, uuid, timestamptz), scim_list(uuid, text, int, int),
    sso_scim_inactive(uuid, uuid) from public;
grant execute on function scim_authenticate(bytea, timestamptz), scim_provision(uuid, text, text, boolean, timestamptz),
    scim_set_active(uuid, uuid, boolean, timestamptz), scim_remove(uuid, uuid, timestamptz), scim_list(uuid, text, int, int) to aura_worker;
grant execute on function sso_scim_inactive(uuid, uuid) to aura_auth;

create function scim_get(p_org uuid, p_user uuid)
    returns table (user_id uuid, email text, external_id text, active boolean, created_at timestamptz, updated_at timestamptz)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select s.user_id, u.email::text, s.external_id, s.active, s.created_at, s.updated_at
      from scim_users s join users u on u.id = s.user_id where s.org_id = p_org and s.user_id = p_user
$$;
revoke all on function scim_get(uuid, uuid) from public;
grant execute on function scim_get(uuid, uuid) to aura_worker;
