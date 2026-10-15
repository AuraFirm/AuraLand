-- Re-issuing after a key is revoked (Stage 7, ADR 0033 decision 8; kit 08). A credential signed by a key that was
-- revoked stops verifying. The runbook's answer is to sign the same credential again with the active key: same id,
-- same place in the revocation list, same claims, a new signature. That is the one case where the signed text may
-- change, so the guard allows it only through this function and only for a credential whose key is revoked.

alter table credentials add column reissued_at timestamptz;

create or replace function credentials_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'credentials are kept' using errcode = 'insufficient_privilege';
    end if;
    if new.id <> old.id or new.subject_user_id <> old.subject_user_id or new.issuer_org_id <> old.issuer_org_id
       or new.kind <> old.kind or new.event_id <> old.event_id or new.assurance_level <> old.assurance_level
       or new.claim <> old.claim
       or new.status_list <> old.status_list or new.status_index <> old.status_index
       or new.issued_at <> old.issued_at or new.expires_at is distinct from old.expires_at then
        raise exception 'what was signed never changes' using errcode = 'insufficient_privilege';
    end if;
    if (new.vc_jwt <> old.vc_jwt or new.kid <> old.kid)
       and current_setting('aura.reissue', true) is distinct from 'on' then
        raise exception 'what was signed never changes' using errcode = 'insufficient_privilege';
    end if;
    if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
        raise exception 'a revocation is not undone' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;

-- Credentials whose signing key was revoked and that are not themselves revoked: the ones to sign again.
create function credentials_needing_reissue(p_limit int) returns table (id uuid, vc_jwt text)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select c.id, c.vc_jwt from credentials c join signing_keys k on k.kid = c.kid
     where k.status = 'revoked' and c.revoked_at is null order by c.id limit least(p_limit, 1000)
$$;

create function reissue_credential(p_id uuid, p_jwt text, p_kid text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    if not exists (select 1 from credentials c join signing_keys k on k.kid = c.kid
                    where c.id = p_id and k.status = 'revoked' and c.revoked_at is null)
       or not exists (select 1 from signing_keys where kid = p_kid and status = 'active') then
        raise exception 'only a credential whose key was revoked is signed again, with the active key'
            using errcode = 'object_not_in_prerequisite_state';
    end if;
    perform set_config('aura.reissue', 'on', true);
    update credentials set vc_jwt = p_jwt, kid = p_kid, reissued_at = p_now where id = p_id;
    perform set_config('aura.reissue', 'off', true);
end
$$;

revoke all on function credentials_needing_reissue(int), reissue_credential(uuid, text, text, timestamptz) from public;
grant execute on function credentials_needing_reissue(int), reissue_credential(uuid, text, text, timestamptz) to aura_worker;
