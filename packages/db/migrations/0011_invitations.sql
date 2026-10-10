-- Invitations to join an organization. An invitation names an email address, not a person: whoever
-- signs in with that verified address and holds the secret link can accept. The link's secret is
-- stored only as an HMAC (like sign-in links), the invitation is single-use, expires after 7 days,
-- and can be revoked. Owners invite admins and members; admins invite members.
--
-- Two more database rules arrive with it: a personal space never has a second member, and an
-- organization has at most 5,000 members.

create table org_invitations (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id) on delete cascade,
    email citext not null,
    role text not null,
    token_hash bytea not null unique,
    invited_by uuid not null references users (id),
    created_at timestamptz not null,
    expires_at timestamptz not null,
    accepted_at timestamptz,
    revoked_at timestamptz,
    constraint org_invitations_email check (email::text = lower(email::text) and char_length(email::text) between 3 and 254),
    constraint org_invitations_role check (role in ('admin', 'member')),
    constraint org_invitations_token_hash_size check (octet_length(token_hash) = 32),
    constraint org_invitations_expiry check (expires_at > created_at and expires_at <= created_at + interval '8 days'),
    constraint org_invitations_one_end check (accepted_at is null or revoked_at is null)
);
create index org_invitations_org on org_invitations (org_id, created_at, id);
create index org_invitations_email on org_invitations (email);

-- An invitation that has been accepted or revoked never changes again.
create function org_invitations_forward_only() returns trigger language plpgsql as $$
begin
    if old.accepted_at is not null or old.revoked_at is not null then
        raise exception 'a finished invitation does not change' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger org_invitations_forward_only before update on org_invitations
    for each row execute function org_invitations_forward_only();

-- At most 100 pending invitations per organization; simultaneous ones take turns.
create function org_invitations_cap() returns trigger language plpgsql as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('invitations:' || new.org_id::text, 0));
    if (select count(*) from org_invitations
        where org_id = new.org_id and accepted_at is null and revoked_at is null
          and expires_at > new.created_at) >= 100 then
        raise exception 'an organization may have at most 100 pending invitations' using errcode = 'check_violation';
    end if;
    if (select kind from orgs where id = new.org_id) = 'personal' then
        raise exception 'a personal space cannot invite people' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger org_invitations_cap before insert on org_invitations
    for each row execute function org_invitations_cap();

alter table org_invitations enable row level security;
alter table org_invitations force row level security;
create policy org_invitations_identity on org_invitations for all to aura_auth using (true) with check (true);
create policy org_invitations_manage_read on org_invitations for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'));
-- Owners may invite admins; admins may invite members only. Always as themselves.
create policy org_invitations_manage_insert on org_invitations for insert to aura_app
    with check (invited_by = nullif(current_setting('app.user_id', true), '')::uuid
                and ((role = 'member' and app_org_role(org_id) in ('owner', 'admin'))
                     or (role = 'admin' and app_org_role(org_id) = 'owner')));
create policy org_invitations_manage_revoke on org_invitations for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin')) with check (app_org_role(org_id) in ('owner', 'admin'));

grant select (id, org_id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at)
    on org_invitations to aura_app;
grant insert (org_id, email, role, token_hash, invited_by, created_at, expires_at) on org_invitations to aura_app;
grant update (revoked_at) on org_invitations to aura_app;
grant select on org_invitations to aura_auth;
grant update (accepted_at) on org_invitations to aura_auth;

-- A personal space has exactly one member, its owner. The check also holds the lock the organization's
-- other membership rules use, so it cannot race a second insert.
create function memberships_limits() returns trigger language plpgsql as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('org-members:' || new.org_id::text, 0));
    if exists (select 1 from orgs where id = new.org_id and kind = 'personal')
       and exists (select 1 from memberships where org_id = new.org_id) then
        raise exception 'a personal space has only its owner' using errcode = 'check_violation';
    end if;
    if (select count(*) from memberships where org_id = new.org_id) >= 5000 then
        raise exception 'an organization may have at most 5000 members' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger memberships_limits before insert on memberships
    for each row execute function memberships_limits();
