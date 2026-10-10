-- API keys, passkey step-up challenges, and organization verification.
--
-- An API key is a long random secret shown once. Only its SHA-256 is stored (a 256-bit random
-- secret cannot be guessed offline, so a plain hash is the right tool), next to a short public
-- prefix used to find the row. Owners and admins of the organization manage its keys; the
-- application role can never read the hash.

create table api_keys (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id) on delete cascade,
    name text not null,
    prefix text not null unique,
    secret_hash bytea not null,
    scopes text[] not null,
    created_by uuid not null references users (id),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz,
    last_used_at timestamptz,
    constraint api_keys_name check (char_length(name) between 1 and 80 and name !~ '[[:cntrl:]]'),
    constraint api_keys_prefix check (prefix ~ '^[a-z0-9]{12}$'),
    constraint api_keys_secret_hash_size check (octet_length(secret_hash) = 32),
    constraint api_keys_scopes check (cardinality(scopes) between 1 and 8 and scopes <@ array['org:read']::text[]),
    constraint api_keys_expiry check (expires_at > created_at and expires_at <= created_at + interval '366 days')
);
create index api_keys_org on api_keys (org_id, created_at, id);

-- Revocation is one-way, and a key's secret and owner never change.
create function api_keys_forward_only() returns trigger language plpgsql as $$
begin
    if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
        raise exception 'a revoked key stays revoked' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger api_keys_forward_only before update on api_keys
    for each row execute function api_keys_forward_only();

-- At most 20 live keys per organization; simultaneous creations take turns.
create function api_keys_cap() returns trigger language plpgsql as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('api-keys:' || new.org_id::text, 0));
    if (select count(*) from api_keys
        where org_id = new.org_id and revoked_at is null and expires_at > now()) >= 20 then
        raise exception 'an organization may have at most 20 live API keys' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger api_keys_cap before insert on api_keys for each row execute function api_keys_cap();

alter table api_keys enable row level security;
alter table api_keys force row level security;
create policy api_keys_identity on api_keys for all to aura_auth using (true) with check (true);
create policy api_keys_manage_read on api_keys for select to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'));
create policy api_keys_manage_insert on api_keys for insert to aura_app
    with check (app_org_role(org_id) in ('owner', 'admin')
                and created_by = nullif(current_setting('app.user_id', true), '')::uuid);
create policy api_keys_manage_revoke on api_keys for update to aura_app
    using (app_org_role(org_id) in ('owner', 'admin'))
    with check (app_org_role(org_id) in ('owner', 'admin'));

grant select (id, org_id, name, prefix, scopes, created_by, created_at, expires_at, revoked_at, last_used_at)
    on api_keys to aura_app;
grant insert (org_id, name, prefix, secret_hash, scopes, created_by, expires_at) on api_keys to aura_app;
grant update (revoked_at) on api_keys to aura_app;
grant select on api_keys to aura_auth;
grant update (last_used_at) on api_keys to aura_auth;

-- A request authenticated by an API key may read its own organization (and nothing else yet).
create policy orgs_key_read on orgs for select to aura_app
    using (current_setting('app.actor_kind', true) = 'api_key'
           and id = any (string_to_array(nullif(current_setting('app.org_ids', true), ''), ',')::uuid[]));

-- Passkey step-up: a third kind of challenge, owned by the signed-in person like registration.
alter table webauthn_challenges drop constraint webauthn_challenges_purpose;
alter table webauthn_challenges drop constraint webauthn_challenges_owner;
alter table webauthn_challenges add constraint webauthn_challenges_purpose
    check (purpose in ('register', 'login', 'step_up'));
alter table webauthn_challenges add constraint webauthn_challenges_owner
    check ((purpose in ('register', 'step_up')) = (user_id is not null));

-- Organization verification is a platform administrator's decision. The function checks the caller's
-- platform role itself, so the rule holds even if a route forgets to.
create function verify_org(p_org uuid) returns void language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator may verify an organization' using errcode = 'insufficient_privilege';
    end if;
    update orgs set verification_state = 'verified', verified_at = now() where id = p_org;
    if not found then
        raise exception 'no such organization' using errcode = 'no_data_found';
    end if;
end
$$;
revoke all on function verify_org(uuid) from public;
grant execute on function verify_org(uuid) to aura_app;
