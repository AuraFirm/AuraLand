-- Per-delivery watermarks (Stage 4C, ADR 0030). Placing an order no longer queues the manifest build at
-- once: it queues one watermark job per ordered version, a judge node rewrites each bundle with the
-- delivery's tag, and the manifest build is queued when the last one is recorded.
--
-- The tag is derived here, by the database, from the delivery's secret watermark id and the version, with
-- SHA-256: nobody who lacks the watermark id can compute another delivery's tag, and the tag is stored with
-- the result so a leak can be traced without any key. Its top bit is always 1 (a marker; see
-- packages/bundle/src/watermark.ts), so it carries 31 bits of identity.

create function delivery_tag(p_watermark text, p_version uuid) returns bigint
    language sql immutable set search_path = pg_catalog, public as $$
    select 2147483648::bigint
         | ((get_byte(h, 0)::bigint & 127) << 24) | (get_byte(h, 1)::bigint << 16)
         | (get_byte(h, 2)::bigint << 8) | get_byte(h, 3)::bigint
      from (select sha256(convert_to('aura-wm-tag:' || p_watermark || ':' || p_version::text, 'UTF8')) as h) s
$$;

-- What was actually delivered for each ordered version. The bundle is the original when the version has
-- no carrier (no safe place for a mark), otherwise the rewritten one. Append-only; written only by
-- record_delivery_bundle.
create table delivery_bundles (
    delivery_id uuid not null,
    customer_org_id uuid not null,
    task_version_id uuid not null,
    task_org_id uuid not null,
    tag bigint not null,
    source_sha256 bytea not null,
    sha256 bytea not null,
    bytes bigint not null,
    answers_marked boolean not null,
    solutions_marked boolean not null,
    -- Whether the node re-ran the harness on the rewritten bundle and saw the same verdicts as on the
    -- original. False only for tasks the harness cannot run (custom checkers), where the only change is a
    -- comment line in a solution file.
    verdicts_checked boolean not null,
    node_id uuid not null references judge_nodes (id),
    attestation text not null,
    created_at timestamptz not null,
    primary key (delivery_id, task_version_id),
    foreign key (delivery_id, customer_org_id) references deliveries (id, customer_org_id),
    foreign key (task_version_id, task_org_id) references task_versions (id, org_id),
    constraint delivery_bundles_hashes check (octet_length(source_sha256) = 32 and octet_length(sha256) = 32),
    constraint delivery_bundles_size check (bytes between 1 and 67108864),
    constraint delivery_bundles_tag check (tag between 2147483648 and 4294967295),
    constraint delivery_bundles_attestation check (attestation in ('development', 'production')),
    -- The bytes are unchanged exactly when nothing was marked.
    constraint delivery_bundles_marks check ((sha256 = source_sha256) = (not answers_marked and not solutions_marked))
);
create index delivery_bundles_tag on delivery_bundles (tag);
create index delivery_bundles_node on delivery_bundles (node_id);
create index delivery_bundles_version on delivery_bundles (task_version_id, task_org_id);

create function delivery_bundles_append_only() returns trigger language plpgsql as $$
begin
    raise exception 'a delivered bundle record never changes' using errcode = 'insufficient_privilege';
end
$$;
create trigger delivery_bundles_no_update before update on delivery_bundles
    for each row execute function delivery_bundles_append_only();
create trigger delivery_bundles_no_delete before delete on delivery_bundles
    for each row when (pg_trigger_depth() = 0) execute function delivery_bundles_append_only();

alter table delivery_bundles enable row level security;
alter table delivery_bundles force row level security;
-- Platform administrators read them (the leak trace is theirs); nobody else needs the tag.
create policy delivery_bundles_admin_read on delivery_bundles for select to aura_app
    using (app_is_platform_admin());
grant select (delivery_id, customer_org_id, task_version_id, source_sha256, sha256, bytes, answers_marked,
              solutions_marked, verdicts_checked, attestation, created_at)
    on delivery_bundles to aura_app;
grant select (tag) on delivery_bundles to aura_app;

-- Placing an order creates its delivery (pending) and one watermark job per ordered version, atomically.
-- The watermark id comes from the caller's random source so tests can inject it. The manifest build is
-- queued by record_delivery_bundle once every version has its delivered bundle.
create or replace function place_order(p_order uuid, p_watermark text, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_order orders%rowtype;
    v_delivery uuid;
    v_item record;
begin
    perform orders_require_admin();
    select * into v_order from orders where id = p_order for update;
    if not found or v_order.state <> 'draft' then
        raise exception 'no such draft order' using errcode = 'no_data_found';
    end if;
    if not exists (select 1 from order_items where order_id = p_order) then
        raise exception 'an order needs at least one version' using errcode = 'check_violation';
    end if;
    update orders set state = 'placed', placed_at = p_now, updated_at = p_now where id = p_order;
    insert into deliveries (order_id, customer_org_id, watermark_id, expires_at, created_at)
    values (p_order, v_order.customer_org_id, p_watermark, p_now + make_interval(days => v_order.delivery_days), p_now)
    returning id into v_delivery;
    for v_item in select task_version_id from order_items where order_id = p_order order by task_version_id loop
        insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
        values ('delivery.watermark', v_order.customer_org_id,
                jsonb_build_object('delivery_id', v_delivery, 'task_version_id', v_item.task_version_id),
                'watermark', 5, 3, p_now, 'watermark:' || v_delivery::text || ':' || v_item.task_version_id::text,
                p_now, p_now);
    end loop;
    return v_delivery;
end
$$;

-- What a node needs to watermark one ordered version, for a delivery that is still pending; null when
-- the job has nothing to do (revoked, built, unknown, or the version is not in the order).
create function watermark_job_input(p_delivery uuid, p_version uuid) returns jsonb
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
    v_delivery deliveries%rowtype;
    v_row record;
begin
    select * into v_delivery from deliveries where id = p_delivery and state = 'pending';
    if not found then
        return null;
    end if;
    select v.org_id, encode(v.bundle_sha256, 'hex') as sha, v.bundle_bytes, v.spec into v_row
      from order_items i join task_versions v on v.id = i.task_version_id and v.org_id = i.task_org_id
     where i.order_id = v_delivery.order_id and i.task_version_id = p_version and v.state = 'released';
    if not found then
        return null;
    end if;
    return jsonb_build_object('delivery_id', p_delivery, 'task_org_id', v_row.org_id, 'bundle_sha256', v_row.sha,
                              'bundle_bytes', v_row.bundle_bytes, 'spec', v_row.spec,
                              'tag', delivery_tag(v_delivery.watermark_id, p_version));
end
$$;

-- Records the delivered bundle of one ordered version. The tag is computed here, never taken from the
-- node; the source hash must be the version's own; the attestation is read from the node's row. When it
-- was the last missing version, the manifest build is queued. Returns 'recorded', 'already' (a retried
-- job) or 'gone' (the delivery is no longer pending).
create function record_delivery_bundle(
    p_delivery uuid, p_version uuid, p_source bytea, p_sha bytea, p_bytes bigint,
    p_answers boolean, p_solutions boolean, p_checked boolean, p_node uuid, p_now timestamptz
) returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_delivery deliveries%rowtype;
    v_task_org uuid;
    v_attestation text;
begin
    select * into v_delivery from deliveries where id = p_delivery for update;
    if not found or v_delivery.state <> 'pending' then
        return 'gone';
    end if;
    select v.org_id into v_task_org
      from order_items i join task_versions v on v.id = i.task_version_id and v.org_id = i.task_org_id
     where i.order_id = v_delivery.order_id and i.task_version_id = p_version and v.bundle_sha256 = p_source;
    if v_task_org is null then
        raise exception 'that version, with that bundle, is not in this order' using errcode = 'no_data_found';
    end if;
    select attestation into v_attestation from judge_nodes where id = p_node and state in ('active', 'draining');
    if v_attestation is null then
        raise exception 'only an enrolled, live node can report' using errcode = 'insufficient_privilege';
    end if;
    if exists (select 1 from delivery_bundles where delivery_id = p_delivery and task_version_id = p_version) then
        return 'already';
    end if;
    insert into delivery_bundles (delivery_id, customer_org_id, task_version_id, task_org_id, tag, source_sha256,
                                  sha256, bytes, answers_marked, solutions_marked, verdicts_checked, node_id,
                                  attestation, created_at)
    values (p_delivery, v_delivery.customer_org_id, p_version, v_task_org,
            delivery_tag(v_delivery.watermark_id, p_version), p_source, p_sha, p_bytes, p_answers, p_solutions,
            p_checked, p_node, v_attestation, p_now);
    if not exists (
        select 1 from order_items i
         where i.order_id = v_delivery.order_id
           and not exists (select 1 from delivery_bundles b
                            where b.delivery_id = p_delivery and b.task_version_id = i.task_version_id)
    ) then
        insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
        values ('delivery.build', v_delivery.customer_org_id, jsonb_build_object('delivery_id', p_delivery),
                'default', 5, 5, p_now, 'delivery:' || p_delivery::text, p_now, p_now)
        on conflict do nothing;
    end if;
    return 'recorded';
end
$$;

revoke all on function delivery_tag(text, uuid), watermark_job_input(uuid, uuid),
    record_delivery_bundle(uuid, uuid, bytea, bytea, bigint, boolean, boolean, boolean, uuid, timestamptz) from public;
grant execute on function watermark_job_input(uuid, uuid),
    record_delivery_bundle(uuid, uuid, bytea, bytea, bigint, boolean, boolean, boolean, uuid, timestamptz) to aura_worker;

-- The customer organization of a pending delivery, for the worker's staging keys. Nothing else about the
-- delivery leaves the database on this path.
create function watermark_customer_org(p_delivery uuid) returns uuid
    language sql stable security definer set search_path = pg_catalog, public as $$
    select customer_org_id from deliveries where id = p_delivery and state = 'pending'
$$;
revoke all on function watermark_customer_org(uuid) from public;
grant execute on function watermark_customer_org(uuid) to aura_worker;
