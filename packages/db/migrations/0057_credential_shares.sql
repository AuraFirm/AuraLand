-- The holder's controls over a credential (Stage 7, ADR 0033): who may see it, and links that show it to one person
-- without making it public. A link is a secret in a URL; only a hash of it is kept, and it dies at an expiry or when
-- the holder revokes it. Credentials start private.

create function set_credential_visibility(p_id uuid, p_visibility text) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    if p_visibility not in ('private', 'link', 'public') then
        raise exception 'unknown visibility' using errcode = 'check_violation';
    end if;
    update credentials set visibility = p_visibility where id = p_id and subject_user_id = app_user();
    if not found then
        raise exception 'no such credential' using errcode = 'no_data_found';
    end if;
end
$$;

create table credential_shares (
    id uuid primary key default uuidv7(),
    credential_id uuid not null references credentials (id),
    subject_user_id uuid not null references users (id),
    token_hash bytea not null unique,
    created_at timestamptz not null,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    constraint credential_shares_hash check (octet_length(token_hash) = 32),
    constraint credential_shares_window check (expires_at > created_at and expires_at <= created_at + interval '30 days')
);
create index credential_shares_credential on credential_shares (credential_id, id);
create index credential_shares_subject on credential_shares (subject_user_id);

-- A share is never deleted; it only ends. Nothing about it changes except its revocation.
create function credential_shares_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'shares are kept' using errcode = 'insufficient_privilege';
    end if;
    if new.id <> old.id or new.credential_id <> old.credential_id or new.subject_user_id <> old.subject_user_id
       or new.token_hash <> old.token_hash or new.created_at <> old.created_at or new.expires_at <> old.expires_at
       or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
        raise exception 'a share only ends' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger credential_shares_guard before update or delete on credential_shares
    for each row execute function credential_shares_guard();

alter table credential_shares enable row level security;
alter table credential_shares force row level security;
create policy credential_shares_own on credential_shares for select to aura_app using (subject_user_id = app_user());
create policy credential_shares_worker on credential_shares for select to aura_worker using (true);
grant select on credential_shares to aura_app, aura_worker;

-- Five live links per credential at most: enough to share with several people, too few to lose track of.
create function create_credential_share(p_credential uuid, p_token_hash bytea, p_days int, p_now timestamptz)
    returns table (share_id uuid, expires_at timestamptz)
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_id uuid;
    v_expires timestamptz := p_now + make_interval(days => p_days);
begin
    if not exists (select 1 from credentials where id = p_credential and subject_user_id = app_user()) then
        raise exception 'no such credential' using errcode = 'no_data_found';
    end if;
    if p_days not between 1 and 30 then
        raise exception 'a link lasts 1 to 30 days' using errcode = 'check_violation';
    end if;
    if (select count(*) from credential_shares s
         where s.credential_id = p_credential and s.revoked_at is null and s.expires_at > p_now) >= 5 then
        raise exception 'five links are live already' using errcode = '54000';
    end if;
    insert into credential_shares (credential_id, subject_user_id, token_hash, created_at, expires_at)
    values (p_credential, app_user(), p_token_hash, p_now, v_expires) returning id into v_id;
    return query select v_id, v_expires;
end
$$;

create function revoke_credential_share(p_share uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    update credential_shares set revoked_at = coalesce(revoked_at, p_now)
     where id = p_share and subject_user_id = app_user();
    if not found then
        raise exception 'no such link' using errcode = 'no_data_found';
    end if;
end
$$;

revoke all on function set_credential_visibility(uuid, text), create_credential_share(uuid, bytea, int, timestamptz),
    revoke_credential_share(uuid, timestamptz) from public;
grant execute on function set_credential_visibility(uuid, text), create_credential_share(uuid, bytea, int, timestamptz),
    revoke_credential_share(uuid, timestamptz) to aura_app;
