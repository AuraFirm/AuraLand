-- Enterprise single sign-on, part 2 (Stage 9, slice 6b): signing people in, joining them to the organization, and requiring it.
--
-- Rules the code and tests hold to:
--   * A person is the same person across sign-ins by (organization, the provider's subject), never by email alone; an existing
--     account is attached to a subject only when the id_token's verified email is in a domain the organization has proved it controls.
--   * A new account made this way joins the organization as an ordinary member, if the plan has room.
--   * When an organization enforces SSO, people whose email is in one of its verified domains can sign in only through SSO.
--     Owners of the organization are exempt, so a provider outage cannot lock everyone out.

alter table sessions drop constraint sessions_auth_method_check;
alter table sessions add constraint sessions_auth_method_check
    check (auth_method in ('email_link', 'email_code', 'passkey', 'github', 'google', 'sso'));

alter table sso_connections add column enforced boolean not null default false;
grant select (enforced) on sso_connections to aura_app;
-- The sign-in role reads connections (with the secret) and domains to run a sign-in; nobody else does.
create policy sso_connections_identity on sso_connections for select to aura_auth using (true);
create policy sso_domains_identity on sso_domains for select to aura_auth using (true);
grant select on sso_connections, sso_domains to aura_auth;

create table sso_identities (
    org_id uuid not null references orgs (id),
    subject text not null,
    user_id uuid not null references users (id) on delete cascade,
    created_at timestamptz not null,
    last_login_at timestamptz,
    primary key (org_id, subject),
    unique (org_id, user_id),
    constraint sso_identities_subject check (char_length(subject) between 1 and 255 and subject !~ '[[:cntrl:]]')
);
create index sso_identities_user on sso_identities (user_id);
alter table sso_identities enable row level security;
alter table sso_identities force row level security;
create policy sso_identities_identity on sso_identities for all to aura_auth using (true) with check (true);
grant select, insert on sso_identities to aura_auth;
grant update (last_login_at) on sso_identities to aura_auth;

-- One row per sign-in in flight, like oauth_flows: the state travels in the redirect, the verifier stays in a cookie, both are
-- kept as hashes; the nonce is kept as is because the id_token must carry it back. Used once, within ten minutes.
create table sso_flows (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    state_hash bytea not null unique,
    verifier_hash bytea not null,
    nonce text not null,
    created_at timestamptz not null,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    constraint sso_flows_state_hash_size check (octet_length(state_hash) = 32),
    constraint sso_flows_verifier_hash_size check (octet_length(verifier_hash) = 32),
    constraint sso_flows_nonce check (nonce ~ '^[A-Za-z0-9_-]{43}$'),
    constraint sso_flows_expiry check (expires_at > created_at and expires_at <= created_at + interval '10 minutes')
);
create index sso_flows_org on sso_flows (org_id);
create index sso_flows_created on sso_flows (created_at);
create function sso_flows_once() returns trigger language plpgsql as $$
begin
    if old.consumed_at is not null then
        raise exception 'a single sign-on flow can be used once' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger sso_flows_once before update on sso_flows for each row execute function sso_flows_once();
alter table sso_flows enable row level security;
alter table sso_flows force row level security;
create policy sso_flows_identity on sso_flows for all to aura_auth using (true) with check (true);
grant select, insert on sso_flows to aura_auth;
grant update (consumed_at) on sso_flows to aura_auth;

-- Which organization's provider signs this address in: the one that proved its domain, and has a connection.
create function sso_org_for_email(p_email text) returns uuid
    language sql stable security definer set search_path = pg_catalog, public as $$
    select d.org_id from sso_domains d join sso_connections c on c.org_id = d.org_id
     where d.verified_at is not null and d.domain = lower(split_part(p_email, '@', 2))
$$;

-- Puts the person in the organization as a member if they are not in it yet. 'full' when the plan has no room.
create function sso_join_org(p_org uuid, p_user uuid) returns text
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_members int;
    v_max int;
begin
    if exists (select 1 from memberships where org_id = p_org and user_id = p_user) then
        return 'member';
    end if;
    select count(*) into v_members from memberships where org_id = p_org;
    select p.members_max into v_max from plans p
     where p.key = coalesce((select c.plan from customers c where c.org_id = p_org), 'free');
    if v_members >= coalesce(v_max, 0) then
        return 'full';
    end if;
    insert into memberships (org_id, user_id, role) values (p_org, p_user, 'member');
    return 'joined';
end
$$;

-- Whether the plan has room for one more member, asked BEFORE an account is made so that a full organization leaves no stray account.
create function sso_org_has_room(p_org uuid) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select (select count(*) from memberships where org_id = p_org) < coalesce(
        (select p.members_max from plans p
          where p.key = coalesce((select c.plan from customers c where c.org_id = p_org), 'free')), 0)
$$;

-- True when this way of signing in is not allowed for this person: their address is in a domain of an organization that enforces
-- SSO, they are not an owner of that organization, and they are not signing in with SSO.
create function sso_blocks_sign_in(p_user uuid, p_method text) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select p_method <> 'sso' and exists (
        select 1 from users u
          join sso_domains d on d.domain = lower(split_part(u.email::text, '@', 2)) and d.verified_at is not null
          join sso_connections c on c.org_id = d.org_id and c.enforced
         where u.id = p_user
           and not exists (select 1 from memberships m where m.org_id = d.org_id and m.user_id = p_user and m.role = 'owner'))
$$;
revoke all on function sso_org_for_email(text), sso_join_org(uuid, uuid), sso_org_has_room(uuid), sso_blocks_sign_in(uuid, text) from public;
grant execute on function sso_org_for_email(text), sso_join_org(uuid, uuid), sso_org_has_room(uuid), sso_blocks_sign_in(uuid, text) to aura_auth;

-- Turning enforcement on needs a verified domain, and an administrator who has themselves signed in through SSO (so they cannot lock
-- themselves out by switching it on before it works).
create function set_sso_enforced(p_org uuid, p_enforced boolean) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    perform webhook_owner_only(p_org);
    if not exists (select 1 from sso_connections where org_id = p_org) then
        raise exception 'no such connection' using errcode = 'no_data_found';
    end if;
    if p_enforced then
        if not exists (select 1 from sso_domains where org_id = p_org and verified_at is not null) then
            raise exception 'verify a domain first' using errcode = 'object_not_in_prerequisite_state';
        end if;
        if not exists (select 1 from sso_identities where org_id = p_org and user_id = v_user) then
            raise exception 'sign in through single sign-on yourself first' using errcode = 'object_not_in_prerequisite_state';
        end if;
    end if;
    update sso_connections set enforced = p_enforced where org_id = p_org;
end
$$;
revoke all on function set_sso_enforced(uuid, boolean) from public;
grant execute on function set_sso_enforced(uuid, boolean) to aura_app;
grant select (org_id, subject, user_id) on sso_identities to aura_app;
create policy sso_identities_self on sso_identities for select to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
