-- Sign-in with GitHub or Google: the link between a person and their identity at the provider, and
-- the short-lived record of each sign-in attempt in flight.
--
-- A provider identity is (provider, the provider's own stable user id). The id, not the email, is
-- what identifies the person: emails change hands, ids do not. At most one identity per provider
-- per person. A person can see and unlink their own identities; only the identity role creates them.

create table oauth_identities (
    id uuid primary key default uuidv7(),
    user_id uuid not null references users (id) on delete cascade,
    provider text not null,
    provider_user_id text not null,
    -- The provider-verified email at the time of linking; kept for the person's own information.
    email_at_link citext,
    created_at timestamptz not null default now(),
    last_login_at timestamptz,
    constraint oauth_identities_provider check (provider in ('github', 'google')),
    constraint oauth_identities_provider_user_id check (char_length(provider_user_id) between 1 and 128 and provider_user_id !~ '[[:cntrl:]]'),
    constraint oauth_identities_email check (email_at_link is null or char_length(email_at_link::text) between 3 and 254),
    constraint oauth_identities_unique_identity unique (provider, provider_user_id),
    constraint oauth_identities_one_per_provider unique (user_id, provider)
);

alter table oauth_identities enable row level security;
alter table oauth_identities force row level security;
create policy oauth_identities_identity on oauth_identities for all to aura_auth using (true) with check (true);
create policy oauth_identities_self on oauth_identities for select to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy oauth_identities_self_delete on oauth_identities for delete to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
grant select (id, user_id, provider, email_at_link, created_at, last_login_at) on oauth_identities to aura_app;
grant delete on oauth_identities to aura_app;
grant select, insert on oauth_identities to aura_auth;
grant update (last_login_at) on oauth_identities to aura_auth;

-- One row per sign-in attempt. The state value travels in the redirect and the PKCE verifier stays in
-- a cookie; both are stored only as HMAC hashes. The callback must present both, so a callback
-- forwarded to another browser (login CSRF) cannot complete. "link" attempts belong to the
-- signed-in person who started them. Each row is used once, within ten minutes.
create table oauth_flows (
    id uuid primary key default uuidv7(),
    provider text not null,
    purpose text not null,
    user_id uuid references users (id) on delete cascade,
    state_hash bytea not null unique,
    verifier_hash bytea not null,
    created_at timestamptz not null,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    constraint oauth_flows_provider check (provider in ('github', 'google')),
    constraint oauth_flows_purpose check (purpose in ('login', 'link')),
    constraint oauth_flows_owner check ((purpose = 'link') = (user_id is not null)),
    constraint oauth_flows_state_hash_size check (octet_length(state_hash) = 32),
    constraint oauth_flows_verifier_hash_size check (octet_length(verifier_hash) = 32),
    constraint oauth_flows_expiry check (expires_at > created_at and expires_at <= created_at + interval '10 minutes')
);
create index oauth_flows_created on oauth_flows (created_at);

create function oauth_flows_once() returns trigger language plpgsql as $$
begin
    if old.consumed_at is not null then
        raise exception 'an oauth flow can be used once' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger oauth_flows_once before update on oauth_flows
    for each row execute function oauth_flows_once();

alter table oauth_flows enable row level security;
alter table oauth_flows force row level security;
create policy oauth_flows_identity on oauth_flows for all to aura_auth using (true) with check (true);
grant select, insert on oauth_flows to aura_auth;
grant update (consumed_at) on oauth_flows to aura_auth;
