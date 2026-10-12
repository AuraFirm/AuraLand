-- Orders and deliveries (Stage 4A, Forge v0). A platform administrator sells released task versions to
-- a customer organization (a company or an AI lab); the delivery records exactly what was handed over.
-- Rules that must never break are database rules:
--   * only a platform administrator creates or changes orders and deliveries, through the functions
--     below, which check the role themselves; the application role has no insert or update on these tables;
--   * an order holds released versions only, and its content is fixed once it is placed;
--   * a delivery's manifest is set once and its stored SHA-256 equals the hash of its text;
--   * a delivery never changes after that, except to be revoked;
--   * the customer's owners, admins and buyers read their own organization's rows, nobody else's.

alter table memberships drop constraint memberships_role;
alter table memberships add constraint memberships_role
    check (role in ('owner', 'admin', 'setter', 'reviewer', 'member', 'buyer'));
alter table org_invitations drop constraint org_invitations_role;
alter table org_invitations add constraint org_invitations_role
    check (role in ('admin', 'setter', 'reviewer', 'member', 'buyer'));

drop policy org_invitations_manage_insert on org_invitations;
create policy org_invitations_manage_insert on org_invitations for insert to aura_app
    with check (invited_by = nullif(current_setting('app.user_id', true), '')::uuid
                and ((role = 'member' and app_org_role(org_id) in ('owner', 'admin'))
                     or (role in ('admin', 'setter', 'reviewer', 'buyer') and app_org_role(org_id) = 'owner')));

drop policy memberships_remove on memberships;
create policy memberships_remove on memberships for delete to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid
           or app_org_role(org_id) = 'owner'
           or (app_org_role(org_id) = 'admin' and role in ('member', 'setter', 'reviewer', 'buyer')));

create function app_is_platform_admin() returns boolean language sql stable security definer
    set search_path = pg_catalog, public as $$
    select exists (select 1 from users
                   where id = nullif(current_setting('app.user_id', true), '')::uuid and platform_role = 'admin')
$$;
revoke all on function app_is_platform_admin() from public;
grant execute on function app_is_platform_admin() to aura_app;

create table orders (
    id uuid primary key default uuidv7(),
    customer_org_id uuid not null references orgs (id),
    title text not null,
    licence_terms text not null,
    delivery_days int not null,
    invoice_reference text,
    state text not null default 'draft',
    created_by uuid not null references users (id),
    placed_at timestamptz,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (id, customer_org_id),
    constraint orders_title check (char_length(title) between 1 and 200 and title !~ '[[:cntrl:]]'),
    constraint orders_terms check (char_length(licence_terms) between 1 and 4000 and licence_terms !~ '\x00'),
    constraint orders_days check (delivery_days between 1 and 365),
    constraint orders_invoice check (invoice_reference is null or (char_length(invoice_reference) between 1 and 200 and invoice_reference !~ '[[:cntrl:]]')),
    constraint orders_state check (state in ('draft', 'placed', 'cancelled')),
    constraint orders_placed_pair check ((state = 'placed') = (placed_at is not null))
);
create index orders_customer on orders (customer_org_id, created_at desc, id desc);

create table order_items (
    order_id uuid not null references orders (id),
    task_version_id uuid not null,
    task_org_id uuid not null,
    added_at timestamptz not null,
    primary key (order_id, task_version_id),
    foreign key (task_version_id, task_org_id) references task_versions (id, org_id)
);
create index order_items_version on order_items (task_version_id, task_org_id);

create table deliveries (
    id uuid primary key default uuidv7(),
    order_id uuid not null unique,
    customer_org_id uuid not null,
    state text not null default 'pending',
    watermark_id text not null unique,
    manifest text,
    manifest_sha256 bytea,
    expires_at timestamptz not null,
    ready_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text,
    created_at timestamptz not null,
    foreign key (order_id, customer_org_id) references orders (id, customer_org_id),
    unique (id, customer_org_id),
    constraint deliveries_state check (state in ('pending', 'ready', 'revoked')),
    constraint deliveries_watermark check (watermark_id ~ '^[0-9a-f]{32}$'),
    constraint deliveries_manifest_size check (manifest is null or (octet_length(manifest) between 2 and 1048576 and manifest !~ '\x00')),
    constraint deliveries_manifest_hash check (manifest_sha256 is null or octet_length(manifest_sha256) = 32),
    constraint deliveries_manifest_pair check ((manifest is null) = (manifest_sha256 is null)),
    constraint deliveries_pending_empty check (state <> 'pending' or manifest is null),
    constraint deliveries_ready_full check (state <> 'ready' or (manifest is not null and ready_at is not null)),
    constraint deliveries_revoked_pair check ((state = 'revoked') = (revoked_at is not null)),
    constraint deliveries_reason check (revoke_reason is null or (state = 'revoked' and char_length(revoke_reason) between 1 and 500 and revoke_reason !~ '[[:cntrl:]]'))
);
create index deliveries_customer on deliveries (customer_org_id, created_at desc, id desc);

-- Append-only log of every download link issued (docs/stages/stage-4-plan.md section 5, invariant 3).
create table delivery_access (
    id uuid primary key default uuidv7(),
    delivery_id uuid not null,
    customer_org_id uuid not null,
    user_id uuid not null references users (id),
    task_version_id uuid not null,
    address inet,
    issued_at timestamptz not null,
    link_expires_at timestamptz not null,
    foreign key (delivery_id, customer_org_id) references deliveries (id, customer_org_id),
    constraint delivery_access_window check (link_expires_at > issued_at and link_expires_at <= issued_at + interval '1 hour')
);
create index delivery_access_delivery on delivery_access (delivery_id, issued_at desc, id desc);
create index delivery_access_user on delivery_access (user_id);

-- Orders: content moves only while a draft; a draft is placed or cancelled; the invoice reference is
-- billing data and may be set at any time before cancellation.
create function orders_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'INSERT' then
        if new.state <> 'draft' then
            raise exception 'an order starts as a draft' using errcode = 'check_violation';
        end if;
        if not exists (select 1 from orgs where id = new.customer_org_id and kind in ('company', 'ai_lab')) then
            raise exception 'a customer is a company or an AI lab' using errcode = 'check_violation';
        end if;
        return new;
    end if;
    if old.state in ('placed', 'cancelled') and (
           new.state is distinct from old.state or new.title <> old.title
           or new.licence_terms <> old.licence_terms or new.delivery_days <> old.delivery_days
           or new.customer_org_id <> old.customer_org_id or new.created_by <> old.created_by) then
        raise exception 'a placed or cancelled order does not change' using errcode = 'insufficient_privilege';
    end if;
    if old.state = 'cancelled' and new.invoice_reference is distinct from old.invoice_reference then
        raise exception 'a cancelled order does not change' using errcode = 'insufficient_privilege';
    end if;
    if new.customer_org_id <> old.customer_org_id or new.created_by <> old.created_by then
        raise exception 'an order keeps its customer and creator' using errcode = 'insufficient_privilege';
    end if;
    if new.state <> old.state and not (old.state || '>' || new.state) = any (array['draft>placed', 'draft>cancelled']) then
        raise exception 'an order cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger orders_guard before insert or update on orders for each row execute function orders_guard();

-- Items: only released versions, only while the order is a draft, at most 100 per order; no updates.
create function order_items_guard() returns trigger language plpgsql as $$
declare
    order_state text;
begin
    if tg_op = 'UPDATE' then
        raise exception 'an order item does not change' using errcode = 'insufficient_privilege';
    end if;
    select state into order_state from orders where id = coalesce(new.order_id, old.order_id);
    if order_state is distinct from 'draft' then
        raise exception 'only a draft order has items added or removed' using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'DELETE' then
        return old;
    end if;
    if not exists (select 1 from task_versions where id = new.task_version_id and org_id = new.task_org_id and state = 'released') then
        raise exception 'only a released version can be ordered' using errcode = 'check_violation';
    end if;
    if (select count(*) from order_items where order_id = new.order_id) >= 100 then
        raise exception 'an order holds at most 100 versions' using errcode = 'configuration_limit_exceeded';
    end if;
    return new;
end
$$;
create trigger order_items_guard before insert or update or delete on order_items
    for each row execute function order_items_guard();

-- Deliveries: identity, watermark and expiry are fixed; the manifest is set once (pending -> ready) and
-- must hash to the stored value; revocation is the only other change; nothing leaves revoked.
create function deliveries_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'INSERT' then
        if new.state <> 'pending' then
            raise exception 'a delivery starts pending' using errcode = 'check_violation';
        end if;
        return new;
    end if;
    if new.order_id <> old.order_id or new.customer_org_id <> old.customer_org_id
       or new.watermark_id <> old.watermark_id or new.expires_at <> old.expires_at
       or new.created_at <> old.created_at then
        raise exception 'a delivery keeps its order, customer, watermark and expiry' using errcode = 'insufficient_privilege';
    end if;
    if old.manifest is not null and (new.manifest <> old.manifest or new.manifest_sha256 <> old.manifest_sha256) then
        raise exception 'a delivery manifest is set once' using errcode = 'insufficient_privilege';
    end if;
    if old.state = 'revoked' then
        raise exception 'a revoked delivery does not change' using errcode = 'insufficient_privilege';
    end if;
    if new.manifest is not null and sha256(convert_to(new.manifest, 'UTF8')) <> new.manifest_sha256 then
        raise exception 'the manifest hash does not match the manifest' using errcode = 'check_violation';
    end if;
    if new.state <> old.state and not (old.state || '>' || new.state) = any (array['pending>ready', 'pending>revoked', 'ready>revoked']) then
        raise exception 'a delivery cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger deliveries_guard before insert or update on deliveries
    for each row execute function deliveries_guard();

create function delivery_access_append_only() returns trigger language plpgsql as $$
begin
    raise exception 'the download log is append-only' using errcode = 'insufficient_privilege';
end
$$;
create trigger delivery_access_append_only before update or delete on delivery_access
    for each row execute function delivery_access_append_only();

alter table orders enable row level security;
alter table orders force row level security;
alter table order_items enable row level security;
alter table order_items force row level security;
alter table deliveries enable row level security;
alter table deliveries force row level security;
alter table delivery_access enable row level security;
alter table delivery_access force row level security;

create policy orders_read on orders for select to aura_app
    using (app_is_platform_admin() or app_org_role(customer_org_id) in ('owner', 'admin', 'buyer'));
create policy order_items_read on order_items for select to aura_app
    using (exists (select 1 from orders o where o.id = order_id));
create policy deliveries_read on deliveries for select to aura_app
    using (app_is_platform_admin() or app_org_role(customer_org_id) in ('owner', 'admin', 'buyer'));
create policy delivery_access_read on delivery_access for select to aura_app
    using (app_is_platform_admin() or app_org_role(customer_org_id) in ('owner', 'admin'));

grant select on orders, order_items, deliveries, delivery_access to aura_app;

-- Platform-administrator functions. Each checks the role itself, so the rule holds even if a route
-- forgets to; they run as the table owner, which bypasses the policies that give aura_app no writes.
create function orders_require_admin() returns uuid language plpgsql stable security definer
    set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator may manage orders' using errcode = 'insufficient_privilege';
    end if;
    return v_user;
end
$$;
revoke all on function orders_require_admin() from public;

create function create_order(p_customer uuid, p_title text, p_terms text, p_days int, p_now timestamptz)
    returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_id uuid;
begin
    insert into orders (customer_org_id, title, licence_terms, delivery_days, created_by, created_at, updated_at)
    values (p_customer, p_title, p_terms, p_days, orders_require_admin(), p_now, p_now) returning id into v_id;
    return v_id;
end
$$;

create function add_order_item(p_order uuid, p_version uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
begin
    perform orders_require_admin();
    select org_id into v_org from task_versions where id = p_version;
    if v_org is null then
        raise exception 'no such task version' using errcode = 'no_data_found';
    end if;
    insert into order_items (order_id, task_version_id, task_org_id, added_at) values (p_order, p_version, v_org, p_now);
end
$$;

create function remove_order_item(p_order uuid, p_version uuid) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform orders_require_admin();
    delete from order_items where order_id = p_order and task_version_id = p_version;
    if not found then
        raise exception 'no such order item' using errcode = 'no_data_found';
    end if;
end
$$;

create function set_order_invoice(p_order uuid, p_reference text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform orders_require_admin();
    update orders set invoice_reference = p_reference, updated_at = p_now where id = p_order;
    if not found then
        raise exception 'no such order' using errcode = 'no_data_found';
    end if;
end
$$;

create function cancel_order(p_order uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform orders_require_admin();
    update orders set state = 'cancelled', updated_at = p_now where id = p_order and state = 'draft';
    if not found then
        raise exception 'no such draft order' using errcode = 'no_data_found';
    end if;
end
$$;

-- Placing an order creates its delivery (pending) and the job that builds the manifest, atomically.
-- The watermark id comes from the caller's random source so tests can inject it.
create function place_order(p_order uuid, p_watermark text, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_order orders%rowtype;
    v_delivery uuid;
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
    insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
    values ('delivery.build', v_order.customer_org_id, jsonb_build_object('delivery_id', v_delivery), 'default', 5, 5, p_now,
            'delivery:' || v_delivery::text, p_now, p_now);
    return v_delivery;
end
$$;

create function revoke_delivery(p_delivery uuid, p_reason text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform orders_require_admin();
    update deliveries set state = 'revoked', revoked_at = p_now, revoke_reason = p_reason
    where id = p_delivery and state in ('pending', 'ready');
    if not found then
        raise exception 'no such active delivery' using errcode = 'no_data_found';
    end if;
end
$$;

revoke all on function create_order(uuid, text, text, int, timestamptz), add_order_item(uuid, uuid, timestamptz),
    remove_order_item(uuid, uuid), set_order_invoice(uuid, text, timestamptz), cancel_order(uuid, timestamptz),
    place_order(uuid, text, timestamptz), revoke_delivery(uuid, text, timestamptz) from public;
grant execute on function create_order(uuid, text, text, int, timestamptz), add_order_item(uuid, uuid, timestamptz),
    remove_order_item(uuid, uuid), set_order_invoice(uuid, text, timestamptz), cancel_order(uuid, timestamptz),
    place_order(uuid, text, timestamptz), revoke_delivery(uuid, text, timestamptz) to aura_app;
