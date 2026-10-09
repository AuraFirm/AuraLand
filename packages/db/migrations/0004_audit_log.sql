-- Append-only, hash-chained audit log (docs/kit/05, docs/kit/08 section 13).
-- Each row stores the hash of the previous row, and its own hash covers that value plus its
-- contents, so changing or removing any row breaks every hash after it. Deleting only the newest
-- rows cannot be seen from inside the database, so the chain head must also be kept outside it.

create table audit_log (
    seq bigint primary key,
    at timestamptz not null default now(),
    actor_user_id uuid,
    actor_kind text not null constraint audit_log_actor_kind
        check (actor_kind in ('user', 'api_key', 'anonymous', 'system', 'worker')),
    org_id uuid,
    action text not null constraint audit_log_action_format
        check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and char_length(action) <= 100),
    target text constraint audit_log_target
        check (target is null or (char_length(target) <= 200 and target !~ '[[:cntrl:]]')),
    ip inet,
    detail jsonb not null default '{}'::jsonb constraint audit_log_detail_size check (pg_column_size(detail) <= 4096),
    prev_hash bytea not null constraint audit_log_prev_hash_size check (octet_length(prev_hash) = 32),
    hash bytea not null constraint audit_log_hash_size check (octet_length(hash) = 32)
);

create sequence audit_log_seq as bigint;

-- Every field is written as "<length>:<value>" so no field can bleed into the next one.
create function audit_canonical(
    p_seq bigint, p_at timestamptz, p_actor_user_id uuid, p_actor_kind text, p_org_id uuid,
    p_action text, p_target text, p_ip inet, p_detail jsonb
) returns bytea language sql immutable set search_path = pg_catalog as $$
    select convert_to(string_agg(length(v) || ':' || v, '' order by ord), 'UTF8')
    from unnest(array[
        p_seq::text,
        (extract(epoch from p_at) * 1000000)::bigint::text,
        coalesce(p_actor_user_id::text, ''),
        p_actor_kind,
        coalesce(p_org_id::text, ''),
        p_action,
        coalesce(p_target, ''),
        coalesce(host(p_ip), ''),
        coalesce(p_detail::text, '')
    ]) with ordinality as t (v, ord)
$$;

-- SECURITY DEFINER because the writer is an application role that row-level security stops from
-- seeing earlier rows, yet the chain needs the previous hash. The advisory lock makes writers take
-- turns, and the sequence value is taken after the lock, so seq order is commit order.
create function audit_log_chain() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
declare
    previous bytea;
begin
    perform pg_advisory_xact_lock(7281990002);
    select hash into previous from audit_log order by seq desc limit 1;
    new.seq := nextval('audit_log_seq');
    new.prev_hash := coalesce(previous, decode(repeat('00', 32), 'hex'));
    new.hash := sha256(new.prev_hash || audit_canonical(
        new.seq, new.at, new.actor_user_id, new.actor_kind, new.org_id,
        new.action, new.target, new.ip, new.detail));
    return new;
end
$$;
create trigger audit_log_chain_insert before insert on audit_log for each row execute function audit_log_chain();

create function audit_log_forbid() returns trigger language plpgsql as $$
begin
    raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end
$$;
create trigger audit_log_append_only before update or delete on audit_log for each row execute function audit_log_forbid();
create trigger audit_log_no_truncate before truncate on audit_log for each statement execute function audit_log_forbid();

-- Returns the sequence number of the first row whose hash or link does not recompute, or NULL.
create function audit_chain_first_bad() returns bigint language sql stable security definer
    set search_path = pg_catalog, public as $$
    select t.seq from (
        select a.seq, a.prev_hash, a.hash,
               lag(a.hash) over (order by a.seq) as linked_prev,
               sha256(a.prev_hash || audit_canonical(
                   a.seq, a.at, a.actor_user_id, a.actor_kind, a.org_id,
                   a.action, a.target, a.ip, a.detail)) as recomputed
        from audit_log a
    ) t
    where t.hash <> t.recomputed
       or t.prev_hash <> coalesce(t.linked_prev, decode(repeat('00', 32), 'hex'))
    order by t.seq limit 1
$$;

create function audit_chain_head() returns table (seq bigint, hash bytea) language sql stable security definer
    set search_path = pg_catalog, public as $$
    select a.seq, a.hash from audit_log a order by a.seq desc limit 1
$$;
revoke all on function audit_chain_first_bad(), audit_chain_head() from public;

-- Row-level security is enabled but not forced: the chain trigger runs as the table owner and must
-- read every row. The application roles are not the owner, so the policies below bind them.
alter table audit_log enable row level security;

-- A writer may log only as itself (or as nobody, when nobody is logged in). The identity role logs
-- on behalf of people who are not yet authenticated, so it is not tied to a user.
create policy audit_insert_app on audit_log for insert to aura_app
    with check (actor_user_id is not distinct from nullif(current_setting('app.user_id', true), '')::uuid);
create policy audit_insert_identity on audit_log for insert to aura_auth with check (true);
create policy audit_read_app on audit_log for select to aura_app
    using (
        actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
        or org_id = any (string_to_array(nullif(current_setting('app.org_ids', true), ''), ',')::uuid[])
    );

grant select, insert on audit_log to aura_app;
grant insert on audit_log to aura_auth;
