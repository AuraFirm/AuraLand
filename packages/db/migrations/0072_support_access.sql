-- Consented support access (Stage 9, slice 10). Support staff (platform administrators) can look at a person's account summary only
-- while that person has an active, unexpired, unrevoked grant they made themselves. A look is read-only, is recorded in the
-- same statement that returns the data (so there is no look without a record), is visible to the person, and is refused for
-- other platform administrators and for anyone who is in the middle of an exam sitting.
-- This is deliberately NOT "become the user": nothing here lets staff act as someone.

create table support_grants (
    id uuid primary key default uuidv7(),
    user_id uuid not null references users (id),
    created_at timestamptz not null,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    constraint support_grants_window check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
);
create index support_grants_user on support_grants (user_id, id desc);
alter table support_grants enable row level security;
alter table support_grants force row level security;
create policy support_grants_own on support_grants for select to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
grant select on support_grants to aura_app;

create table support_views (
    id uuid primary key default uuidv7(),
    grant_id uuid not null references support_grants (id),
    admin_id uuid not null references users (id),
    viewed_at timestamptz not null
);
create index support_views_grant on support_views (grant_id, id desc);
create index support_views_admin on support_views (admin_id);
create trigger support_views_guard before update or delete on support_views for each row execute function ledger_guard();
alter table support_views enable row level security;
alter table support_views force row level security;
-- The person sees who looked (the staff member's id and when); staff do not read this table directly.
create policy support_views_own on support_views for select to aura_app
    using (exists (select 1 from support_grants g where g.id = grant_id
                    and g.user_id = nullif(current_setting('app.user_id', true), '')::uuid));
grant select on support_views to aura_app;

-- One grant at a time: a new one replaces an older one still running.
create function grant_support_access(p_hours int, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_id uuid;
begin
    if v_user is null then
        raise exception 'sign in first' using errcode = 'insufficient_privilege';
    end if;
    if p_hours not between 1 and 24 then
        raise exception 'a grant lasts 1 to 24 hours' using errcode = 'check_violation';
    end if;
    update support_grants set revoked_at = p_now where user_id = v_user and revoked_at is null and expires_at > p_now;
    insert into support_grants (user_id, created_at, expires_at) values (v_user, p_now, p_now + make_interval(hours => p_hours))
    returning id into v_id;
    return v_id;
end
$$;

create function revoke_support_access(p_now timestamptz) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_count int;
begin
    update support_grants set revoked_at = p_now
     where user_id = nullif(current_setting('app.user_id', true), '')::uuid and revoked_at is null and expires_at > p_now;
    get diagnostics v_count = row_count;
    return v_count;
end
$$;

-- A summary of the person's account, recorded as seen by this staff member. Errors say nothing about why, except the same words.
create function support_overview(p_target uuid, p_now timestamptz) returns jsonb
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_admin uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_grant uuid;
begin
    if v_admin is null or not exists (select 1 from users where id = v_admin and platform_role = 'admin') then
        raise exception 'only support staff may do this' using errcode = 'insufficient_privilege';
    end if;
    select g.id into v_grant from support_grants g
      join users u on u.id = g.user_id and u.platform_role = 'none'
     where g.user_id = p_target and g.revoked_at is null and g.expires_at > p_now
       and not exists (select 1 from exam_sessions s where s.user_id = p_target and s.state in ('consented', 'started'))
     order by g.id desc limit 1;
    if v_grant is null then
        raise exception 'no consented access' using errcode = 'no_data_found';
    end if;
    insert into support_views (grant_id, admin_id, viewed_at) values (v_grant, v_admin, p_now);
    return jsonb_build_object(
        'email', (select email::text from users where id = p_target),
        'status', (select status from users where id = p_target),
        'created_at', (select created_at from users where id = p_target),
        'organizations', coalesce((select jsonb_agg(jsonb_build_object('name', o.name, 'kind', o.kind, 'role', m.role) order by o.name)
            from memberships m join orgs o on o.id = m.org_id where m.user_id = p_target), '[]'::jsonb),
        'sessions', coalesce((select jsonb_agg(jsonb_build_object('auth_method', s.auth_method, 'created_at', s.created_at,
                'last_seen_at', s.last_seen_at) order by s.created_at desc)
            from (select * from sessions where user_id = p_target and revoked_at is null and absolute_expires_at > p_now
                   order by created_at desc limit 10) s), '[]'::jsonb),
        'recent_actions', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'at', a.at) order by a.seq desc)
            from (select action, at, seq from audit_log where actor_user_id = p_target order by seq desc limit 20) a), '[]'::jsonb));
end
$$;
revoke all on function grant_support_access(int, timestamptz), revoke_support_access(timestamptz), support_overview(uuid, timestamptz) from public;
grant execute on function grant_support_access(int, timestamptz), revoke_support_access(timestamptz), support_overview(uuid, timestamptz) to aura_app;
