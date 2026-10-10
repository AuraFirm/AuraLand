-- Email sign-in challenges and rate-limit counters. Both are touched only by the identity role.
--
-- A challenge is one request to sign in by email. It carries three secrets, none stored in clear:
-- a link token, an 8-digit code and a browser-binding value (kept in a cookie), each as an
-- HMAC-SHA-256 under a server secret, because a short code hashed without a secret could be
-- brute-forced offline from a leaked database. Whichever of link or code is used first consumes the
-- challenge for both. Failed code guesses are counted in the same statement that checks them.

create table login_challenges (
    id uuid primary key default uuidv7(),
    email citext not null,
    binding_hash bytea not null unique,
    link_hash bytea not null unique,
    code_hash bytea not null,
    created_at timestamptz not null,
    link_expires_at timestamptz not null,
    code_expires_at timestamptz not null,
    code_attempts smallint not null default 0,
    consumed_at timestamptz,
    consumed_by text,
    constraint login_challenges_email_lowercase check (email::text = lower(email::text) and char_length(email::text) between 3 and 254),
    constraint login_challenges_binding_hash_size check (octet_length(binding_hash) = 32),
    constraint login_challenges_link_hash_size check (octet_length(link_hash) = 32),
    constraint login_challenges_code_hash_size check (octet_length(code_hash) = 32),
    constraint login_challenges_expiry check (link_expires_at > created_at and code_expires_at > created_at),
    constraint login_challenges_attempts check (code_attempts between 0 and 5),
    constraint login_challenges_consumed_by check (consumed_by in ('link', 'code')),
    constraint login_challenges_consumed_pair check ((consumed_at is null) = (consumed_by is null))
);
create index login_challenges_created on login_challenges (created_at);

-- Only forward: attempts never fall, and a consumed challenge never changes again.
create function login_challenges_forward_only() returns trigger language plpgsql as $$
begin
    if new.code_attempts < old.code_attempts
       or (old.consumed_at is not null
           and (new.consumed_at is distinct from old.consumed_at
                or new.consumed_by is distinct from old.consumed_by
                or new.code_attempts <> old.code_attempts)) then
        raise exception 'a login challenge can only move forward' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger login_challenges_forward_only before update on login_challenges
    for each row execute function login_challenges_forward_only();

alter table login_challenges enable row level security;
alter table login_challenges force row level security;
create policy login_challenges_identity on login_challenges for all to aura_auth using (true) with check (true);
grant select, insert on login_challenges to aura_auth;
grant update (code_attempts, consumed_at, consumed_by) on login_challenges to aura_auth;

-- Fixed-window counters for the strict rate-limit class. The key is a hash of the class and the
-- identifier (an address or an email), so the table holds no personal data in readable form.
create table rate_limit_counters (
    key_hash bytea not null,
    window_start timestamptz not null,
    count integer not null,
    primary key (key_hash, window_start),
    constraint rate_limit_counters_key_size check (octet_length(key_hash) = 32),
    constraint rate_limit_counters_count check (count >= 1)
);
alter table rate_limit_counters enable row level security;
alter table rate_limit_counters force row level security;
create policy rate_limit_counters_identity on rate_limit_counters for all to aura_auth using (true) with check (true);
grant select, insert on rate_limit_counters to aura_auth;
grant update (count) on rate_limit_counters to aura_auth;
