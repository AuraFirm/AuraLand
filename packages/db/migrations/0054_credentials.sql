-- Credentials (Stage 7, ADR 0033): what the platform signed about a person's event. One per (person, kind, event). The
-- signed JWT is the credential; the row is our record of it and the person's controls over it. The row holds no email:
-- the holder is a user id that only the holder (and staff of the host) can read.

create sequence credential_status_slots minvalue 0 start 0;

create table credentials (
    id uuid primary key,
    subject_user_id uuid not null references users (id),
    issuer_org_id uuid not null references orgs (id),
    kind text not null,
    event_id uuid not null,
    assurance_level smallint not null,
    claim jsonb not null,
    vc_jwt text not null,
    kid text not null references signing_keys (kid),
    status_list int not null,
    status_index int not null,
    visibility text not null default 'private',
    issued_at timestamptz not null,
    expires_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text not null default '',
    unique (subject_user_id, kind, event_id),
    unique (status_list, status_index),
    constraint credentials_kind check (kind in ('contest_rank', 'exam_result')),
    constraint credentials_assurance check (assurance_level between 0 and 3),
    constraint credentials_visibility check (visibility in ('private', 'link', 'public')),
    constraint credentials_slot check (status_list >= 0 and status_index between 0 and 131071),
    constraint credentials_claim check (jsonb_typeof(claim) = 'object' and pg_column_size(claim) <= 2048),
    constraint credentials_jwt check (char_length(vc_jwt) between 100 and 8192),
    constraint credentials_reason check (char_length(revoke_reason) <= 500 and revoke_reason !~ '\x00'),
    constraint credentials_revoked check (revoked_at is not null or revoke_reason = '')
);
create index credentials_issuer_org on credentials (issuer_org_id, id);
create index credentials_kid on credentials (kid);

-- A credential is never deleted, and what was signed never changes; only the person's visibility and its revocation do.
create function credentials_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'credentials are kept' using errcode = 'insufficient_privilege';
    end if;
    if new.id <> old.id or new.subject_user_id <> old.subject_user_id or new.issuer_org_id <> old.issuer_org_id
       or new.kind <> old.kind or new.event_id <> old.event_id or new.assurance_level <> old.assurance_level
       or new.claim <> old.claim or new.vc_jwt <> old.vc_jwt or new.kid <> old.kid
       or new.status_list <> old.status_list or new.status_index <> old.status_index
       or new.issued_at <> old.issued_at or new.expires_at is distinct from old.expires_at then
        raise exception 'what was signed never changes' using errcode = 'insufficient_privilege';
    end if;
    if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
        raise exception 'a revocation is not undone' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger credentials_guard before update or delete on credentials
    for each row execute function credentials_guard();

alter table credentials enable row level security;
alter table credentials force row level security;
create policy credentials_own on credentials for select to aura_app using (subject_user_id = app_user());
create policy credentials_worker on credentials for select to aura_worker using (true);
grant select on credentials to aura_app, aura_worker;

-- The next free place in the revocation lists. A place taken by an attempt that did not become a credential stays
-- unused, which is harmless: an unused bit is never read.
create function reserve_credential_status_slot() returns table (status_list int, status_index int)
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_slot bigint := nextval('public.credential_status_slots');
begin
    return query select (v_slot / 131072)::int, (v_slot % 131072)::int;
end
$$;

-- Records a signed credential. Idempotent: the same (person, kind, event) is recorded once, and a second call reports
-- that it already was.
create function insert_credential(p_id uuid, p_subject uuid, p_org uuid, p_kind text, p_event uuid, p_assurance int,
                                  p_claim jsonb, p_jwt text, p_kid text, p_list int, p_index int,
                                  p_issued timestamptz, p_expires timestamptz)
    returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_rows int;
begin
    insert into credentials (id, subject_user_id, issuer_org_id, kind, event_id, assurance_level, claim, vc_jwt, kid,
                             status_list, status_index, issued_at, expires_at)
    values (p_id, p_subject, p_org, p_kind, p_event, p_assurance, p_claim, p_jwt, p_kid, p_list, p_index, p_issued, p_expires)
    on conflict (subject_user_id, kind, event_id) do nothing;
    get diagnostics v_rows = row_count;
    return v_rows = 1;
end
$$;

revoke all on function reserve_credential_status_slot(), insert_credential(uuid, uuid, uuid, text, uuid, int, jsonb, text, text, int, int, timestamptz, timestamptz) from public;
grant execute on function reserve_credential_status_slot(),
    insert_credential(uuid, uuid, uuid, text, uuid, int, jsonb, text, text, int, int, timestamptz, timestamptz) to aura_worker;
