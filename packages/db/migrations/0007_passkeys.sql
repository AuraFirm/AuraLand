-- Passkeys (WebAuthn credentials) and the one-time challenges used to register and use them.
--
-- A passkey row holds the public key only; the private key never leaves the person's device. The
-- application role may list and rename or delete its own passkeys but cannot read the public key
-- or the counter, so no screen or export can ever show them. The identity role does the
-- verification work and is the only one that records usage.

create table passkeys (
    id uuid primary key default uuidv7(),
    user_id uuid not null references users (id) on delete cascade,
    credential_id bytea not null unique,
    public_key bytea not null,
    -- The signature counter reported by the authenticator. Many report 0 forever, which is allowed;
    -- one that ever goes backwards is rejected (here and in the verifier).
    counter bigint not null default 0,
    transports text[] not null default '{}',
    device_type text not null,
    backed_up boolean not null,
    name text not null,
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    constraint passkeys_credential_id_size check (octet_length(credential_id) between 16 and 1023),
    constraint passkeys_public_key_size check (octet_length(public_key) between 16 and 4096),
    constraint passkeys_counter_range check (counter between 0 and 4294967295),
    constraint passkeys_transports check (transports <@ array['usb', 'nfc', 'ble', 'hybrid', 'internal', 'smart-card']::text[]),
    constraint passkeys_device_type check (device_type in ('singleDevice', 'multiDevice')),
    constraint passkeys_name check (char_length(name) between 1 and 80 and name !~ '[[:cntrl:]]')
);
create index passkeys_user on passkeys (user_id, created_at, id);

-- The cap is a database rule, not only an application check, so two simultaneous registrations
-- cannot both slip under it. The advisory lock makes them take turns per user.
create function passkeys_cap() returns trigger language plpgsql as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('passkeys:' || new.user_id::text, 0));
    if (select count(*) from passkeys where user_id = new.user_id) >= 20 then
        raise exception 'a user may hold at most 20 passkeys' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger passkeys_cap before insert on passkeys for each row execute function passkeys_cap();

create function passkeys_counter_forward() returns trigger language plpgsql as $$
begin
    if new.counter < old.counter then
        raise exception 'a passkey counter can only move forward' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger passkeys_counter_forward before update on passkeys
    for each row execute function passkeys_counter_forward();

alter table passkeys enable row level security;
alter table passkeys force row level security;
create policy passkeys_identity on passkeys for all to aura_auth using (true) with check (true);
create policy passkeys_self on passkeys for all to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
    with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

grant select (id, user_id, transports, device_type, backed_up, name, created_at, last_used_at)
    on passkeys to aura_app;
grant update (name) on passkeys to aura_app;
grant delete on passkeys to aura_app;
grant select, insert on passkeys to aura_auth;
grant update (counter, backed_up, last_used_at) on passkeys to aura_auth;

-- One-time challenges. A registration challenge belongs to the signed-in person who asked; a login
-- challenge belongs to nobody yet. Each is used once, within five minutes. The value is random and
-- is handed to the browser anyway, so it is stored as is; it is useless without a matching signature.
create table webauthn_challenges (
    id uuid primary key default uuidv7(),
    challenge text not null unique,
    purpose text not null,
    user_id uuid references users (id) on delete cascade,
    created_at timestamptz not null,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    constraint webauthn_challenges_challenge_format check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
    constraint webauthn_challenges_purpose check (purpose in ('register', 'login')),
    constraint webauthn_challenges_owner check ((purpose = 'register') = (user_id is not null)),
    constraint webauthn_challenges_expiry check (expires_at > created_at and expires_at <= created_at + interval '5 minutes')
);
create index webauthn_challenges_created on webauthn_challenges (created_at);

create function webauthn_challenges_once() returns trigger language plpgsql as $$
begin
    if old.consumed_at is not null then
        raise exception 'a challenge can be used once' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger webauthn_challenges_once before update on webauthn_challenges
    for each row execute function webauthn_challenges_once();

alter table webauthn_challenges enable row level security;
alter table webauthn_challenges force row level security;
create policy webauthn_challenges_identity on webauthn_challenges for all to aura_auth using (true) with check (true);
grant select, insert on webauthn_challenges to aura_auth;
grant update (consumed_at) on webauthn_challenges to aura_auth;
