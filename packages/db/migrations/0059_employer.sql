-- Employer access to public credentials (Stage 7, ADR 0033 decision 11). Narrow on purpose: an employer is a company
-- organization that a platform administrator has approved; its members, with a fresh passkey check, may search the
-- credentials their holders made PUBLIC (which name no one) and open a report on one; every report is logged and the
-- holder can see which organization looked, when and why. Nothing here reaches private or link-only credentials.

create table employer_orgs (
    org_id uuid primary key references orgs (id),
    approved_by uuid not null references users (id),
    approved_at timestamptz not null,
    revoked_at timestamptz
);
create index employer_orgs_approved_by on employer_orgs (approved_by);
alter table employer_orgs enable row level security;
alter table employer_orgs force row level security;
create policy employer_orgs_read on employer_orgs for select to aura_app using (app_org_role(org_id) is not null);
grant select on employer_orgs to aura_app;

create function approve_employer_org(p_org uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator approves employers' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from orgs where id = p_org and kind = 'company') then
        raise exception 'no such company' using errcode = 'no_data_found';
    end if;
    insert into employer_orgs (org_id, approved_by, approved_at) values (p_org, v_user, p_now)
    on conflict (org_id) do update set approved_by = excluded.approved_by, approved_at = excluded.approved_at, revoked_at = null;
end
$$;

create function revoke_employer_org(p_org uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator revokes employers' using errcode = 'insufficient_privilege';
    end if;
    update employer_orgs set revoked_at = p_now where org_id = p_org and revoked_at is null;
    if not found then
        raise exception 'no such employer' using errcode = 'no_data_found';
    end if;
end
$$;

-- Who looked at a credential: one row per report opened. Written only by employer_report.
create table credential_views (
    id uuid primary key default uuidv7(),
    credential_id uuid not null references credentials (id),
    viewer_org_id uuid not null references orgs (id),
    viewer_user_id uuid not null references users (id),
    purpose text not null,
    viewed_at timestamptz not null,
    constraint credential_views_purpose check (purpose in ('hiring_screening', 'verification'))
);
create index credential_views_credential on credential_views (credential_id, id);
create index credential_views_org on credential_views (viewer_org_id);
create index credential_views_user on credential_views (viewer_user_id);
create function credential_views_guard() returns trigger language plpgsql as $$
begin
    raise exception 'the record of who looked is kept as it was' using errcode = 'insufficient_privilege';
end
$$;
create trigger credential_views_guard before update or delete on credential_views
    for each row execute function credential_views_guard();
alter table credential_views enable row level security;
alter table credential_views force row level security;
-- An employer sees only its own organization's views. A holder reads who looked through my_credential_views, which leaves out
-- the person; the table itself is not theirs to select.
create policy credential_views_employer on credential_views for select to aura_app
    using (app_org_role(viewer_org_id) is not null);
grant select on credential_views to aura_app;

create function employer_is_approved(p_org uuid) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select app_org_role(p_org) is not null
       and exists (select 1 from employer_orgs e where e.org_id = p_org and e.revoked_at is null)
$$;

-- Anonymous listing of public credentials: no holder, only what the credential says.
create function employer_search(p_org uuid, p_kind text, p_after uuid, p_limit int)
    returns table (id uuid, kind text, claim jsonb, assurance_level int, issued_at timestamptz, expires_at timestamptz)
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
    if not employer_is_approved(p_org) then
        raise exception 'no such employer' using errcode = 'no_data_found';
    end if;
    return query
    select c.id, c.kind, c.claim, c.assurance_level::int, c.issued_at, c.expires_at
      from credentials c
     where c.visibility = 'public' and c.revoked_at is null and (c.expires_at is null or c.expires_at > now())
       and (p_kind is null or c.kind = p_kind) and (p_after is null or c.id < p_after)
     order by c.id desc limit least(greatest(p_limit, 1), 100);
end
$$;

-- Opens a report: checks the employer, finds the credential only if it is public, and records the look in the same
-- statement, so there is no report without a log.
create function employer_report(p_org uuid, p_credential uuid, p_purpose text, p_now timestamptz)
    returns table (id uuid, kind text, claim jsonb, assurance_level int, vc_jwt text, issued_at timestamptz,
                   expires_at timestamptz, revoked_at timestamptz)
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not employer_is_approved(p_org) then
        raise exception 'no such employer' using errcode = 'no_data_found';
    end if;
    if p_purpose not in ('hiring_screening', 'verification') then
        raise exception 'unknown purpose' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from credentials c where c.id = p_credential and c.visibility = 'public') then
        raise exception 'no such credential' using errcode = 'no_data_found';
    end if;
    insert into credential_views (credential_id, viewer_org_id, viewer_user_id, purpose, viewed_at)
    values (p_credential, p_org, v_user, p_purpose, p_now);
    return query
    select c.id, c.kind, c.claim, c.assurance_level::int, c.vc_jwt, c.issued_at, c.expires_at, c.revoked_at
      from credentials c where c.id = p_credential;
end
$$;

-- What a holder sees of who looked: the organization's name, the purpose and the time; not the person who looked.
create function my_credential_views(p_credential uuid)
    returns table (org_name text, purpose text, viewed_at timestamptz)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select o.name, v.purpose, v.viewed_at
      from credential_views v
      join credentials c on c.id = v.credential_id and c.subject_user_id = app_user()
      join orgs o on o.id = v.viewer_org_id
     where v.credential_id = p_credential
     order by v.id desc limit 200
$$;

revoke all on function approve_employer_org(uuid, timestamptz), revoke_employer_org(uuid, timestamptz),
    employer_is_approved(uuid), employer_search(uuid, text, uuid, int),
    employer_report(uuid, uuid, text, timestamptz), my_credential_views(uuid) from public;
grant execute on function approve_employer_org(uuid, timestamptz), revoke_employer_org(uuid, timestamptz),
    employer_search(uuid, text, uuid, int), employer_report(uuid, uuid, text, timestamptz),
    my_credential_views(uuid) to aura_app;
