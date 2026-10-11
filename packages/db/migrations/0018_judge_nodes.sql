-- Judge nodes and their enrollment (Stage 3). A node is a machine that runs untrusted code; it holds
-- only its own Ed25519 key. It enrolls once with a single-use token that a platform administrator
-- creates, then signs every request. Nonces of signed requests are kept briefly so a captured request
-- cannot be replayed.
--
-- All of this is reached through the worker role (the API acts for the node after checking its
-- signature) or through the SECURITY DEFINER functions below, which check the platform role themselves.

create table judge_nodes (
    id uuid primary key default uuidv7(),
    name text not null unique,
    public_key bytea not null unique,
    state text not null default 'enrolled',
    tiers smallint[] not null default '{1}',
    agent_version text,
    created_at timestamptz not null,
    last_seen_at timestamptz,
    canary_ok_at timestamptz,
    constraint judge_nodes_name check (name ~ '^[a-z][a-z0-9-]{1,62}$'),
    constraint judge_nodes_key_size check (octet_length(public_key) = 32),
    constraint judge_nodes_state check (state in ('enrolled', 'active', 'draining', 'revoked')),
    constraint judge_nodes_tiers check (cardinality(tiers) between 1 and 2 and tiers <@ array[1, 2]::smallint[]),
    constraint judge_nodes_version check (agent_version is null or char_length(agent_version) between 1 and 64)
);

create table node_enrollments (
    id uuid primary key default uuidv7(),
    token_hash bytea not null unique,
    created_by uuid not null references users (id),
    created_at timestamptz not null,
    expires_at timestamptz not null,
    used_at timestamptz,
    used_by uuid references judge_nodes (id),
    constraint node_enrollments_hash_size check (octet_length(token_hash) = 32),
    constraint node_enrollments_expiry check (expires_at > created_at and expires_at <= created_at + interval '1 day'),
    constraint node_enrollments_used_pair check ((used_at is null) = (used_by is null))
);
create index node_enrollments_creator on node_enrollments (created_by);

create table node_nonces (
    node_id uuid not null references judge_nodes (id) on delete cascade,
    nonce bytea not null,
    seen_at timestamptz not null,
    primary key (node_id, nonce),
    constraint node_nonces_size check (octet_length(nonce) between 12 and 64)
);
create index node_nonces_seen on node_nonces (seen_at);

create function judge_nodes_guard() returns trigger language plpgsql as $$
begin
    if old.state = 'revoked' then
        raise exception 'a revoked node stays revoked' using errcode = 'insufficient_privilege';
    end if;
    if new.public_key <> old.public_key or new.name <> old.name then
        raise exception 'a node keeps its name and key' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger judge_nodes_guard before update on judge_nodes
    for each row execute function judge_nodes_guard();

alter table judge_nodes enable row level security;
alter table judge_nodes force row level security;
alter table node_enrollments enable row level security;
alter table node_enrollments force row level security;
alter table node_nonces enable row level security;
alter table node_nonces force row level security;
create policy judge_nodes_worker on judge_nodes for all to aura_worker using (true) with check (true);
create policy node_enrollments_worker on node_enrollments for all to aura_worker using (true) with check (true);
create policy node_nonces_worker on node_nonces for all to aura_worker using (true) with check (true);
grant select, insert, update on judge_nodes to aura_worker;
grant select, update on node_enrollments to aura_worker;
grant select, insert on node_nonces to aura_worker;

-- Creating an enrollment and revoking a node are platform administrators' decisions; the functions
-- check the role themselves, so the rule holds even if a route forgets to.
create function create_node_enrollment(p_token_hash bytea, p_now timestamptz, p_ttl interval) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_id uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator may enroll judge nodes' using errcode = 'insufficient_privilege';
    end if;
    insert into node_enrollments (token_hash, created_by, created_at, expires_at)
    values (p_token_hash, v_user, p_now, p_now + p_ttl) returning id into v_id;
    return v_id;
end
$$;

create function revoke_judge_node(p_node uuid) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator may revoke judge nodes' using errcode = 'insufficient_privilege';
    end if;
    update judge_nodes set state = 'revoked' where id = p_node and state <> 'revoked';
    if not found then
        raise exception 'no such active node' using errcode = 'no_data_found';
    end if;
end
$$;
revoke all on function create_node_enrollment(bytea, timestamptz, interval), revoke_judge_node(uuid) from public;
grant execute on function create_node_enrollment(bytea, timestamptz, interval), revoke_judge_node(uuid) to aura_app;

-- Housekeeping learns about the new short-lived rows (nonces after 10 minutes, finished or expired
-- enrollments after 7 days). The rest of the function is unchanged from migration 0016.
create or replace function cleanup_expired(p_now timestamptz) returns jsonb language plpgsql security definer
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

    with doomed as (select node_id, nonce from node_nonces where seen_at < p_now - interval '10 minutes' limit batch)
    delete from node_nonces t using doomed d where t.node_id = d.node_id and t.nonce = d.nonce;
    get diagnostics n = row_count; result := result || jsonb_build_object('node_nonces', n);

    with doomed as (select id from node_enrollments
                    where least(expires_at, coalesce(used_at, expires_at)) < p_now - interval '7 days' limit batch)
    delete from node_enrollments t using doomed d where t.id = d.id;
    get diagnostics n = row_count; result := result || jsonb_build_object('node_enrollments', n);
    return result;
end
$$;
