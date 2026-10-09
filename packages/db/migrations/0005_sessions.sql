-- Login sessions. Only a SHA-256 hash of the secret token is stored, so a database read cannot be
-- turned into a working login. All times are supplied by the caller (the service's injected clock),
-- which is what makes session behavior testable in simulation.

create table sessions (
    id uuid primary key default uuidv7(),
    user_id uuid not null references users (id) on delete cascade,
    token_hash bytea not null unique constraint sessions_token_hash_size check (octet_length(token_hash) = 32),
    auth_method text not null
        constraint sessions_auth_method_check check (auth_method in ('email_link', 'email_code', 'passkey', 'github', 'google')),
    -- Decided at creation: administrators and organization owners get the shorter idle timeout.
    privileged boolean not null,
    created_at timestamptz not null,
    last_seen_at timestamptz not null,
    idle_expires_at timestamptz not null,
    absolute_expires_at timestamptz not null,
    -- When the user last proved presence with a passkey; privileged actions need it to be recent.
    step_up_at timestamptz,
    revoked_at timestamptz,
    revoked_reason text constraint sessions_revoked_reason_check check (
        revoked_reason in ('logout', 'logout_all', 'rotated', 'evicted', 'admin', 'privilege_change', 'account_suspended')),
    -- Only the network part of the address (/24 for IPv4, /48 for IPv6): enough to notice a new
    -- location, too coarse to identify a person.
    ip_network cidr,
    user_agent text constraint sessions_user_agent_length check (char_length(user_agent) <= 200),
    constraint sessions_times_ordered check (
        created_at <= last_seen_at and created_at < absolute_expires_at and idle_expires_at <= absolute_expires_at),
    constraint sessions_revoked_pair check ((revoked_at is null) = (revoked_reason is null))
);
create index sessions_user_active on sessions (user_id, created_at) where revoked_at is null;

-- Once revoked, always revoked: the time and the reason can no longer change.
create function sessions_revoke_once() returns trigger language plpgsql as $$
begin
    if old.revoked_at is not null
       and (new.revoked_at is distinct from old.revoked_at or new.revoked_reason is distinct from old.revoked_reason) then
        raise exception 'a revoked session cannot be changed' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger sessions_revoke_once before update on sessions for each row execute function sessions_revoke_once();

alter table sessions enable row level security;
alter table sessions force row level security;

create policy sessions_identity on sessions for all to aura_auth using (true) with check (true);
create policy sessions_self_read on sessions for select to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy sessions_self_revoke on sessions for update to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
    with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- The application can list and revoke a person's own sessions but never read a token hash. The
-- identity role creates and maintains sessions; it cannot rewrite who owns one or its secret.
grant select (id, user_id, auth_method, privileged, created_at, last_seen_at, idle_expires_at,
              absolute_expires_at, step_up_at, revoked_at, revoked_reason, ip_network, user_agent)
    on sessions to aura_app;
grant update (revoked_at, revoked_reason) on sessions to aura_app;
grant select, insert on sessions to aura_auth;
grant update (last_seen_at, idle_expires_at, step_up_at, revoked_at, revoked_reason) on sessions to aura_auth;
