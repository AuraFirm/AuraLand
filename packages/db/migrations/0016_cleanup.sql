-- Housekeeping for the worker (Stage 3). Short-lived rows (sessions, sign-in challenges, OAuth flows,
-- passkey challenges, rate-limit windows, finished uploads and jobs, old invitations) are removed
-- after a grace period. The work is done by SECURITY DEFINER functions so the worker role needs no
-- table privileges beyond the queue; each delete is bounded, so one pass is never unbounded.
--
-- cleanup_expired(now): deletes and returns the counts as JSON.
-- expired_uploads(now, limit): unfinished uploads past their expiry, so the worker can abort the
--   storage side; close_upload(id, now): marks one finished.

create function cleanup_expired(p_now timestamptz) returns jsonb language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    batch constant int := 1000;
    result jsonb := '{}'::jsonb;
    n int;
begin
    with doomed as (select id from sessions
                    where least(absolute_expires_at, coalesce(revoked_at, absolute_expires_at)) < p_now - interval '7 days'
                    limit batch)
    delete from sessions s using doomed d where s.id = d.id;
    get diagnostics n = row_count; result := result || jsonb_build_object('sessions', n);

    with doomed as (select id from login_challenges
                    where greatest(link_expires_at, code_expires_at) < p_now - interval '1 day' limit batch)
    delete from login_challenges t using doomed d where t.id = d.id;
    get diagnostics n = row_count; result := result || jsonb_build_object('login_challenges', n);

    with doomed as (select id from webauthn_challenges where expires_at < p_now - interval '1 day' limit batch)
    delete from webauthn_challenges t using doomed d where t.id = d.id;
    get diagnostics n = row_count; result := result || jsonb_build_object('webauthn_challenges', n);

    with doomed as (select id from oauth_flows where expires_at < p_now - interval '1 day' limit batch)
    delete from oauth_flows t using doomed d where t.id = d.id;
    get diagnostics n = row_count; result := result || jsonb_build_object('oauth_flows', n);

    with doomed as (select id from org_invitations
                    where least(expires_at, coalesce(accepted_at, expires_at), coalesce(revoked_at, expires_at))
                          < p_now - interval '30 days' limit batch)
    delete from org_invitations t using doomed d where t.id = d.id;
    get diagnostics n = row_count; result := result || jsonb_build_object('org_invitations', n);

    with doomed as (select key_hash, window_start from rate_limit_counters
                    where window_start < p_now - interval '2 days' limit batch)
    delete from rate_limit_counters t using doomed d
        where t.key_hash = d.key_hash and t.window_start = d.window_start;
    get diagnostics n = row_count; result := result || jsonb_build_object('rate_limit_counters', n);

    with doomed as (select id from bundle_uploads where finished_at < p_now - interval '30 days' limit batch)
    delete from bundle_uploads t using doomed d where t.id = d.id;
    get diagnostics n = row_count; result := result || jsonb_build_object('bundle_uploads', n);

    with doomed as (select id from jobs
                    where (state = 'done' and updated_at < p_now - interval '7 days')
                       or (state = 'dead' and updated_at < p_now - interval '30 days') limit batch)
    delete from jobs t using doomed d where t.id = d.id;
    get diagnostics n = row_count; result := result || jsonb_build_object('jobs', n);
    return result;
end
$$;

create function expired_uploads(p_now timestamptz, p_limit int)
    returns table (id uuid, org_id uuid, storage_upload_id text)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select u.id, u.org_id, u.storage_upload_id from bundle_uploads u
    where u.finished_at is null and u.expires_at < p_now
    order by u.expires_at, u.id limit least(greatest(p_limit, 1), 200)
$$;

create function close_upload(p_id uuid, p_now timestamptz) returns boolean
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    update bundle_uploads set finished_at = p_now where id = p_id and finished_at is null;
    return found;
end
$$;

revoke all on function cleanup_expired(timestamptz), expired_uploads(timestamptz, int),
    close_upload(uuid, timestamptz) from public;
grant execute on function cleanup_expired(timestamptz), expired_uploads(timestamptz, int),
    close_upload(uuid, timestamptz) to aura_worker;
