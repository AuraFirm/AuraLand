-- Setter revenue share (Stage 9, slice 8). Orders carry no prices (invoices are made outside the product), so platform staff book the
-- revenue of an order item, and the split follows terms staff set per task. Every booking is one balanced ledger transaction
-- (cash in, the platform's share as revenue, each setter's share as an amount owed). A payout batch pays what is owed: creating one
-- reserves amounts, marking it paid posts the ledger transaction, cancelling it frees them. Money is whole minor units.
--
-- Only platform administrators change anything here; a setter can read their own terms, balance and payout lines.

create table setter_terms (
    task_id uuid not null,
    org_id uuid not null,
    user_id uuid not null references users (id),
    share_bps int not null,
    set_by uuid not null references users (id),
    set_at timestamptz not null,
    primary key (task_id, user_id),
    foreign key (task_id, org_id) references tasks (id, org_id),
    constraint setter_terms_share check (share_bps between 1 and 10000)
);
create index setter_terms_user on setter_terms (user_id);
create index setter_terms_set_by on setter_terms (set_by);
alter table setter_terms enable row level security;
alter table setter_terms force row level security;
create policy setter_terms_own on setter_terms for select to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid
        or exists (select 1 from users u where u.id = nullif(current_setting('app.user_id', true), '')::uuid and u.platform_role = 'admin'));
create policy setter_terms_worker on setter_terms for select to aura_worker using (true);
grant select on setter_terms to aura_app, aura_worker;

create function revenue_admin_only() returns uuid language plpgsql stable security definer
    set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator may do this' using errcode = 'insufficient_privilege';
    end if;
    return v_user;
end
$$;

-- The shares on one task may add up to at most 100%; the platform keeps the rest.
create function set_setter_terms(p_task uuid, p_user uuid, p_bps int, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_admin uuid := revenue_admin_only();
    v_org uuid;
    v_others int;
begin
    select org_id into v_org from tasks where id = p_task;
    if v_org is null then
        raise exception 'no such task' using errcode = 'no_data_found';
    end if;
    select coalesce(sum(share_bps), 0) into v_others from setter_terms where task_id = p_task and user_id <> p_user;
    if v_others + p_bps > 10000 then
        raise exception 'shares add up to more than 100%%' using errcode = 'check_violation';
    end if;
    insert into setter_terms (task_id, org_id, user_id, share_bps, set_by, set_at) values (p_task, v_org, p_user, p_bps, v_admin, p_now)
    on conflict (task_id, user_id) do update set share_bps = excluded.share_bps, set_by = excluded.set_by, set_at = excluded.set_at;
end
$$;

create table order_revenue (
    order_id uuid not null,
    task_version_id uuid not null,
    task_org_id uuid not null,
    amount_minor bigint not null,
    currency char(3) not null,
    booked_by uuid not null references users (id),
    booked_at timestamptz not null,
    ledger_txn uuid not null references ledger_txns (id),
    primary key (order_id, task_version_id),
    foreign key (order_id, task_version_id) references order_items (order_id, task_version_id),
    constraint order_revenue_amount check (amount_minor between 1 and 100000000000),
    constraint order_revenue_currency check (currency ~ '^[A-Z]{3}$')
);
create index order_revenue_booked_by on order_revenue (booked_by);
create index order_revenue_txn on order_revenue (ledger_txn);
create trigger order_revenue_guard before update or delete on order_revenue for each row execute function ledger_guard();
alter table order_revenue enable row level security;
alter table order_revenue force row level security;
create policy order_revenue_admin on order_revenue for select to aura_app
    using (exists (select 1 from users u where u.id = nullif(current_setting('app.user_id', true), '')::uuid and u.platform_role = 'admin'));
create policy order_revenue_worker on order_revenue for select to aura_worker using (true);
grant select on order_revenue to aura_app, aura_worker;

-- Books the revenue of one item of a placed order, once. Each setter gets floor(amount * bps / 10000); the platform keeps the rest,
-- including every rounding remainder, so the transaction always balances.
create function book_order_revenue(p_order uuid, p_version uuid, p_amount bigint, p_currency text, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_admin uuid := revenue_admin_only();
    v_task uuid;
    v_org uuid;
    v_entries jsonb;
    v_shared bigint := 0;
    v_share bigint;
    v_terms record;
    v_txn uuid;
begin
    if not exists (select 1 from orders o join order_items i on i.order_id = o.id
                    where o.id = p_order and o.state = 'placed' and i.task_version_id = p_version) then
        raise exception 'no such placed order item' using errcode = 'no_data_found';
    end if;
    if exists (select 1 from order_revenue where order_id = p_order and task_version_id = p_version) then
        raise exception 'revenue for this item is already booked' using errcode = 'unique_violation';
    end if;
    select v.task_id, v.org_id into v_task, v_org from task_versions v where v.id = p_version;
    v_entries := jsonb_build_array(jsonb_build_object('account', 'cash', 'direction', 'D', 'amount_minor', p_amount, 'currency', p_currency));
    for v_terms in select user_id, share_bps from setter_terms where task_id = v_task order by user_id loop
        v_share := (p_amount * v_terms.share_bps) / 10000;
        if v_share > 0 then
            v_entries := v_entries || jsonb_build_object('account', 'payable_setter:' || v_terms.user_id::text, 'direction', 'C',
                                                         'amount_minor', v_share, 'currency', p_currency);
            v_shared := v_shared + v_share;
        end if;
    end loop;
    if p_amount - v_shared > 0 then
        v_entries := v_entries || jsonb_build_object('account', 'revenue', 'direction', 'C', 'amount_minor', p_amount - v_shared,
                                                     'currency', p_currency);
    end if;
    v_txn := post_ledger_txn('order_revenue', p_order::text || ':' || p_version::text, p_now, v_entries);
    insert into order_revenue (order_id, task_version_id, task_org_id, amount_minor, currency, booked_by, booked_at, ledger_txn)
    values (p_order, p_version, v_org, p_amount, p_currency, v_admin, p_now, v_txn);
    return v_txn;
end
$$;

-- What the platform owes a setter in a currency: credits minus debits on their account.
create function setter_owed(p_user uuid, p_currency text) returns bigint
    language sql stable security definer set search_path = pg_catalog, public as $$
    select coalesce(sum(case e.direction when 'C' then e.amount_minor else -e.amount_minor end), 0)::bigint
      from ledger_entries e where e.account = 'payable_setter:' || p_user::text and e.currency = p_currency
$$;

create table payout_batches (
    id uuid primary key default uuidv7(),
    currency char(3) not null,
    state text not null default 'created',
    created_by uuid not null references users (id),
    created_at timestamptz not null,
    paid_at timestamptz,
    paid_reference text,
    ledger_txn uuid references ledger_txns (id),
    constraint payout_batches_currency check (currency ~ '^[A-Z]{3}$'),
    constraint payout_batches_state check (state in ('created', 'paid', 'cancelled')),
    constraint payout_batches_paid check ((state = 'paid') = (paid_at is not null and paid_reference is not null and ledger_txn is not null)),
    constraint payout_batches_reference check (paid_reference is null or (char_length(paid_reference) between 1 and 200 and paid_reference !~ '[[:cntrl:]]'))
);
create index payout_batches_created_by on payout_batches (created_by);
create index payout_batches_txn on payout_batches (ledger_txn);
create table payout_batch_lines (
    batch_id uuid not null references payout_batches (id),
    user_id uuid not null references users (id),
    amount_minor bigint not null,
    primary key (batch_id, user_id),
    constraint payout_batch_lines_amount check (amount_minor between 1 and 100000000000)
);
create index payout_batch_lines_user on payout_batch_lines (user_id);
alter table payout_batches enable row level security;
alter table payout_batches force row level security;
alter table payout_batch_lines enable row level security;
alter table payout_batch_lines force row level security;
create policy payout_batches_admin on payout_batches for select to aura_app
    using (exists (select 1 from users u where u.id = nullif(current_setting('app.user_id', true), '')::uuid and u.platform_role = 'admin'));
create policy payout_batch_lines_own on payout_batch_lines for select to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid
        or exists (select 1 from users u where u.id = nullif(current_setting('app.user_id', true), '')::uuid and u.platform_role = 'admin'));
create policy payout_batches_worker on payout_batches for select to aura_worker using (true);
create policy payout_batch_lines_worker on payout_batch_lines for select to aura_worker using (true);
grant select on payout_batches, payout_batch_lines to aura_app, aura_worker;

-- What is available to pay a setter: owed, less what open batches already reserve.
create function setter_available(p_user uuid, p_currency text) returns bigint
    language sql stable security definer set search_path = pg_catalog, public as $$
    select setter_owed(p_user, p_currency) - coalesce((select sum(l.amount_minor) from payout_batch_lines l
        join payout_batches b on b.id = l.batch_id where l.user_id = p_user and b.currency = p_currency and b.state = 'created'), 0)
$$;

-- Reserves what is available (at least p_minimum) for every setter who has some.
create function create_payout_batch(p_currency text, p_minimum bigint, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_admin uuid := revenue_admin_only();
    v_id uuid;
    v_user record;
    v_available bigint;
    v_lines int := 0;
begin
    insert into payout_batches (currency, created_by, created_at) values (p_currency, v_admin, p_now) returning id into v_id;
    for v_user in select distinct substr(e.account, length('payable_setter:') + 1)::uuid as user_id from ledger_entries e
                   where e.account like 'payable_setter:%' and e.currency = p_currency order by 1 loop
        v_available := setter_available(v_user.user_id, p_currency);
        if v_available >= greatest(p_minimum, 1) then
            insert into payout_batch_lines (batch_id, user_id, amount_minor) values (v_id, v_user.user_id, v_available);
            v_lines := v_lines + 1;
        end if;
    end loop;
    if v_lines = 0 then
        raise exception 'nobody is owed enough' using errcode = 'no_data_found';
    end if;
    return v_id;
end
$$;

create function mark_payout_batch_paid(p_batch uuid, p_reference text, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_batch payout_batches%rowtype;
    v_entries jsonb;
    v_total bigint := 0;
    v_line record;
    v_txn uuid;
begin
    perform revenue_admin_only();
    select * into v_batch from payout_batches where id = p_batch for update;
    if not found then
        raise exception 'no such batch' using errcode = 'no_data_found';
    end if;
    if v_batch.state <> 'created' then
        raise exception 'this batch is not waiting' using errcode = 'object_not_in_prerequisite_state';
    end if;
    v_entries := '[]'::jsonb;
    for v_line in select user_id, amount_minor from payout_batch_lines where batch_id = p_batch order by user_id loop
        v_entries := v_entries || jsonb_build_object('account', 'payable_setter:' || v_line.user_id::text, 'direction', 'D',
                                                     'amount_minor', v_line.amount_minor, 'currency', v_batch.currency);
        v_total := v_total + v_line.amount_minor;
    end loop;
    v_entries := v_entries || jsonb_build_object('account', 'cash', 'direction', 'C', 'amount_minor', v_total, 'currency', v_batch.currency);
    v_txn := post_ledger_txn('payout_batch', p_batch::text, p_now, v_entries);
    update payout_batches set state = 'paid', paid_at = p_now, paid_reference = p_reference, ledger_txn = v_txn where id = p_batch;
    return v_txn;
end
$$;

create function cancel_payout_batch(p_batch uuid) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform revenue_admin_only();
    update payout_batches set state = 'cancelled' where id = p_batch and state = 'created';
    if not found then
        raise exception 'no such waiting batch' using errcode = 'no_data_found';
    end if;
end
$$;

-- The person's own position, per currency: owed in total and available to be paid.
create function my_earnings() returns table (currency text, owed_minor bigint, available_minor bigint)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select c.currency, setter_owed(u.id, c.currency), setter_available(u.id, c.currency)
      from (select nullif(current_setting('app.user_id', true), '')::uuid as id) u,
           (select distinct currency::text from ledger_entries where account like 'payable_setter:%') c
     where u.id is not null and exists (select 1 from ledger_entries e where e.account = 'payable_setter:' || u.id::text and e.currency = c.currency)
$$;
revoke all on function revenue_admin_only(), set_setter_terms(uuid, uuid, int, timestamptz), book_order_revenue(uuid, uuid, bigint, text, timestamptz),
    setter_owed(uuid, text), setter_available(uuid, text), create_payout_batch(text, bigint, timestamptz),
    mark_payout_batch_paid(uuid, text, timestamptz), cancel_payout_batch(uuid), my_earnings() from public;
grant execute on function set_setter_terms(uuid, uuid, int, timestamptz), book_order_revenue(uuid, uuid, bigint, text, timestamptz),
    create_payout_batch(text, bigint, timestamptz), mark_payout_batch_paid(uuid, text, timestamptz), cancel_payout_batch(uuid),
    my_earnings() to aura_app;
