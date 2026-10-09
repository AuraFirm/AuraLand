-- Users and profiles. The email is stored exactly as the API normalizes it (lowercase), and the
-- database refuses anything else, so the same mailbox can never exist under two spellings.
-- The request context (set_config 'app.user_id') comes from packages/db/src/context.ts.

create function set_updated_at() returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end
$$;

create table users (
    id uuid primary key default uuidv7(),
    email citext not null unique,
    email_verified_at timestamptz,
    status text not null default 'active' constraint users_status_check check (status in ('active', 'suspended')),
    platform_role text not null default 'none'
        constraint users_platform_role_check check (platform_role in ('none', 'admin')),
    deletion_requested_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint users_email_lowercase check (email::text = lower(email::text)),
    constraint users_email_length check (char_length(email::text) between 3 and 254)
);
create trigger users_updated_at before update on users for each row execute function set_updated_at();

create table profiles (
    user_id uuid primary key references users (id) on delete cascade,
    handle citext not null unique constraint profiles_handle_check check (handle::text ~ '^[a-z0-9_]{3,24}$'),
    display_name text not null constraint profiles_display_name_check check (char_length(display_name) between 1 and 80),
    -- Privacy by default (docs/kit/09): a new profile is reachable by link but not listed.
    visibility text not null default 'unlisted'
        constraint profiles_visibility_check check (visibility in ('public', 'unlisted', 'private')),
    locale text not null default 'en' constraint profiles_locale_check check (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on profiles for each row execute function set_updated_at();

alter table users enable row level security;
alter table users force row level security;
alter table profiles enable row level security;
alter table profiles force row level security;

-- A person sees and edits only their own user row; the identity role sees all rows because it must
-- find users before anyone is logged in. The "nullif" turns the unset context into NULL, which
-- matches no row.
create policy users_self_read on users for select to aura_app
    using (id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy users_self_update on users for update to aura_app
    using (id = nullif(current_setting('app.user_id', true), '')::uuid)
    with check (id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy users_identity on users for all to aura_auth using (true) with check (true);

create policy profiles_read on profiles for select to aura_app
    using (visibility = 'public' or user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy profiles_self_update on profiles for update to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
    with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy profiles_identity on profiles for all to aura_auth using (true) with check (true);

-- Column-level grants: the application may change only what a person may change about themselves.
-- Status, platform role, email and verification are set by identity code and administrators.
grant select on users to aura_app;
grant update (deletion_requested_at) on users to aura_app;
grant select, insert, update on users to aura_auth;
grant select on profiles to aura_app;
grant update (handle, display_name, visibility, locale) on profiles to aura_app;
grant select, insert, update on profiles to aura_auth;
