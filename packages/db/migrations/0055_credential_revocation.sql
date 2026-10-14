-- Revoking a credential and remembering what has been published (Stage 7, ADR 0033). Revocation sets a time and a
-- reason; the public status list is rebuilt from these rows by the worker. A revocation is not undone (guard trigger of
-- 0054). Who may revoke: a platform administrator, or an owner or admin of the organization that issued it.

create function revoke_credential(p_id uuid, p_reason text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_credential credentials%rowtype;
begin
    select * into v_credential from credentials where id = p_id;
    -- coalesce: a person with no role in the organization has a null role, and a null must read as "no", not "maybe".
    if not found or v_user is null
       or not (exists (select 1 from users where id = v_user and platform_role = 'admin')
               or coalesce(app_org_role(v_credential.issuer_org_id) in ('owner', 'admin'), false)) then
        raise exception 'no such credential' using errcode = 'no_data_found';
    end if;
    if v_credential.revoked_at is not null then
        raise exception 'already revoked' using errcode = '55000';
    end if;
    if char_length(p_reason) not between 1 and 500 or p_reason ~ '\x00' then
        raise exception 'a revocation has a reason of 1 to 500 characters' using errcode = 'check_violation';
    end if;
    update credentials set revoked_at = p_now, revoke_reason = p_reason where id = p_id;
end
$$;

-- Issuers and administrators read the credentials they may revoke; holders already read their own.
create policy credentials_issuer on credentials for select to aura_app
    using (app_org_role(issuer_org_id) in ('owner', 'admin'));

-- What the worker has published as static files, by content digest, so unchanged documents are not written again.
create table passport_artifacts (
    name text primary key,
    digest bytea not null,
    published_at timestamptz not null,
    constraint passport_artifacts_name check (name ~ '^[a-z0-9._/-]{3,120}$')
);
alter table passport_artifacts enable row level security;
alter table passport_artifacts force row level security;
create policy passport_artifacts_worker on passport_artifacts for select to aura_worker using (true);
grant select on passport_artifacts to aura_worker;

create function record_passport_artifact(p_name text, p_digest bytea, p_now timestamptz) returns void
    language sql security definer set search_path = pg_catalog, public as $$
    insert into passport_artifacts (name, digest, published_at) values (p_name, p_digest, p_now)
    on conflict (name) do update set digest = excluded.digest, published_at = excluded.published_at
$$;

revoke all on function revoke_credential(uuid, text, timestamptz), record_passport_artifact(text, bytea, timestamptz) from public;
grant execute on function revoke_credential(uuid, text, timestamptz) to aura_app;
grant execute on function record_passport_artifact(text, bytea, timestamptz) to aura_worker;
