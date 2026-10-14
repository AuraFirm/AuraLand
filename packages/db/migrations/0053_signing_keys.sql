-- Credential signing keys (Stage 7, ADR 0033). This table holds only PUBLIC keys and their lifecycle: the private key
-- lives in the signer (a KMS in production, an in-memory development signer in development and test) and never here.
-- A verifier needs every key that ever signed a credential that still verifies: active and retired keys publish; a
-- revoked key is published as revoked so its credentials show as invalid.

create table signing_keys (
    kid text primary key,
    alg text not null,
    public_jwk jsonb not null,
    environment text not null,
    status text not null default 'active',
    not_before timestamptz not null,
    retired_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text not null default '',
    created_by uuid references users (id),
    constraint signing_keys_kid check (kid ~ '^[A-Za-z0-9._-]{3,64}$'),
    constraint signing_keys_alg check (alg in ('ES256', 'EdDSA')),
    constraint signing_keys_env check (environment in ('development', 'production')),
    constraint signing_keys_status check (status in ('active', 'retired', 'revoked')),
    -- A public key only: a private member would be a leak, so the table refuses it.
    constraint signing_keys_public check (jsonb_typeof(public_jwk) = 'object' and not (public_jwk ? 'd')
        and pg_column_size(public_jwk) <= 1024),
    constraint signing_keys_dates check ((status = 'active') = (retired_at is null and revoked_at is null)
        or status <> 'active'),
    constraint signing_keys_reason check (char_length(revoke_reason) <= 500 and revoke_reason !~ '\x00')
);
create index signing_keys_created_by on signing_keys (created_by);
-- One signing key at a time per environment.
create unique index signing_keys_one_active on signing_keys (environment) where status = 'active';

-- Keys are never deleted, and what a key is never changes; its status only moves forward.
create function signing_keys_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'signing keys are kept' using errcode = 'insufficient_privilege';
    end if;
    if new.kid <> old.kid or new.alg <> old.alg or new.public_jwk <> old.public_jwk
       or new.environment <> old.environment or new.not_before <> old.not_before then
        raise exception 'what a key is never changes' using errcode = 'insufficient_privilege';
    end if;
    if new.status <> old.status and not (old.status || '>' || new.status) = any (array[
        'active>retired', 'active>revoked', 'retired>revoked']) then
        raise exception 'a key cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger signing_keys_guard before update or delete on signing_keys
    for each row execute function signing_keys_guard();

-- Public data: anyone may read the keys a verifier needs.
alter table signing_keys enable row level security;
alter table signing_keys force row level security;
create policy signing_keys_read on signing_keys for select to aura_app, aura_worker using (true);
grant select on signing_keys to aura_app, aura_worker;

-- The system registers the first key of an environment. A key already registered with the same public key is a
-- no-op; another active key means this is a rotation, which is a person's act.
create function register_signing_key(p_kid text, p_alg text, p_jwk jsonb, p_environment text, p_now timestamptz)
    returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_existing signing_keys%rowtype;
begin
    select * into v_existing from signing_keys where kid = p_kid;
    if found then
        if v_existing.public_jwk = p_jwk and v_existing.alg = p_alg and v_existing.environment = p_environment then
            return false;
        end if;
        raise exception 'this key id names a different key' using errcode = '55000';
    end if;
    if exists (select 1 from signing_keys where environment = p_environment and status = 'active') then
        raise exception 'an active key exists: rotate instead' using errcode = '55000';
    end if;
    insert into signing_keys (kid, alg, public_jwk, environment, not_before) values (p_kid, p_alg, p_jwk, p_environment, p_now);
    return true;
end
$$;

create function signing_keys_require_admin() returns uuid
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator manages signing keys' using errcode = 'insufficient_privilege';
    end if;
    return v_user;
end
$$;

-- Retires the active key and makes the new one active, in one step: there is never a moment with two or none.
create function rotate_signing_key(p_kid text, p_alg text, p_jwk jsonb, p_environment text, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := signing_keys_require_admin();
begin
    update signing_keys set status = 'retired', retired_at = p_now where environment = p_environment and status = 'active';
    insert into signing_keys (kid, alg, public_jwk, environment, not_before, created_by)
    values (p_kid, p_alg, p_jwk, p_environment, p_now, v_user);
end
$$;

-- A compromised key: its credentials stop verifying; they are re-issued under another key (runbook).
create function revoke_signing_key(p_kid text, p_reason text, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := signing_keys_require_admin();
begin
    update signing_keys set status = 'revoked', revoked_at = p_now, revoke_reason = p_reason
     where kid = p_kid and status in ('active', 'retired');
    if not found then
        raise exception 'no such key to revoke' using errcode = 'no_data_found';
    end if;
end
$$;

revoke all on function register_signing_key(text, text, jsonb, text, timestamptz), signing_keys_require_admin(),
    rotate_signing_key(text, text, jsonb, text, timestamptz), revoke_signing_key(text, text, timestamptz) from public;
grant execute on function register_signing_key(text, text, jsonb, text, timestamptz) to aura_worker;
grant execute on function rotate_signing_key(text, text, jsonb, text, timestamptz),
    revoke_signing_key(text, text, timestamptz) to aura_app;
