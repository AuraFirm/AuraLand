-- Payment records (Stage 4A). Nothing here moves money: staff record that an invoice was paid and that
-- a contractor was paid, and the database keeps those records from being rewritten.
--   * an order is marked paid once, only after it is placed; the date never changes;
--   * a contractor payout names the person who authored a released version, an agreed amount in minor
--     units, and (later) when and under what reference it was paid; the agreement never changes and a
--     payout is paid at most once;
--   * only platform administrators write; the contractor and platform administrators read.

alter table orders add column paid_at timestamptz;

create or replace function orders_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'INSERT' then
        if new.state <> 'draft' or new.paid_at is not null then
            raise exception 'an order starts as an unpaid draft' using errcode = 'check_violation';
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
    if new.paid_at is distinct from old.paid_at and (old.paid_at is not null or new.state <> 'placed') then
        raise exception 'payment is recorded once, for a placed order' using errcode = 'insufficient_privilege';
    end if;
    if new.state <> old.state and not (old.state || '>' || new.state) = any (array['draft>placed', 'draft>cancelled']) then
        raise exception 'an order cannot move from % to %', old.state, new.state using errcode = 'check_violation';
    end if;
    return new;
end
$$;

create function mark_order_paid(p_order uuid, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform orders_require_admin();
    update orders set paid_at = p_now, updated_at = p_now where id = p_order and state = 'placed' and paid_at is null;
    if not found then
        raise exception 'no such unpaid placed order' using errcode = 'no_data_found';
    end if;
end
$$;
revoke all on function mark_order_paid(uuid, timestamptz) from public;
grant execute on function mark_order_paid(uuid, timestamptz) to aura_app;

create table contractor_payouts (
    id uuid primary key default uuidv7(),
    contractor_id uuid not null references users (id),
    task_version_id uuid not null,
    task_org_id uuid not null,
    amount_minor bigint not null,
    currency text not null,
    paid_at timestamptz,
    paid_reference text,
    created_by uuid not null references users (id),
    created_at timestamptz not null,
    foreign key (task_version_id, task_org_id) references task_versions (id, org_id),
    constraint payouts_amount check (amount_minor between 1 and 100000000000),
    constraint payouts_currency check (currency ~ '^[A-Z]{3}$'),
    constraint payouts_paid_pair check ((paid_at is null) = (paid_reference is null)),
    constraint payouts_reference check (paid_reference is null or (char_length(paid_reference) between 1 and 200 and paid_reference !~ '[[:cntrl:]]'))
);
create index payouts_contractor on contractor_payouts (contractor_id, created_at desc, id desc);
create index payouts_version on contractor_payouts (task_version_id, task_org_id);

create function contractor_payouts_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'INSERT' then
        if new.paid_at is not null then
            raise exception 'a payout starts unpaid' using errcode = 'check_violation';
        end if;
        if not exists (select 1 from task_versions
                       where id = new.task_version_id and org_id = new.task_org_id
                         and created_by = new.contractor_id and state = 'released') then
            raise exception 'a payout is for the author of a released version' using errcode = 'check_violation';
        end if;
        return new;
    end if;
    if tg_op = 'DELETE' then
        raise exception 'payouts are never deleted' using errcode = 'insufficient_privilege';
    end if;
    if new.contractor_id <> old.contractor_id or new.task_version_id <> old.task_version_id
       or new.task_org_id <> old.task_org_id or new.amount_minor <> old.amount_minor
       or new.currency <> old.currency or new.created_by <> old.created_by or new.created_at <> old.created_at then
        raise exception 'the agreement of a payout does not change' using errcode = 'insufficient_privilege';
    end if;
    if old.paid_at is not null then
        raise exception 'a paid payout does not change' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger contractor_payouts_guard before insert or update or delete on contractor_payouts
    for each row execute function contractor_payouts_guard();

alter table contractor_payouts enable row level security;
alter table contractor_payouts force row level security;
create policy payouts_read on contractor_payouts for select to aura_app
    using (contractor_id = app_user() or app_is_platform_admin());
grant select on contractor_payouts to aura_app;

create function record_payout(p_contractor uuid, p_version uuid, p_amount bigint, p_currency text, p_now timestamptz)
    returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
    v_id uuid;
begin
    perform orders_require_admin();
    select org_id into v_org from task_versions where id = p_version;
    if v_org is null then
        raise exception 'no such task version' using errcode = 'no_data_found';
    end if;
    insert into contractor_payouts (contractor_id, task_version_id, task_org_id, amount_minor, currency, created_by, created_at)
    values (p_contractor, p_version, v_org, p_amount, p_currency, app_user(), p_now) returning id into v_id;
    return v_id;
end
$$;

create function mark_payout_paid(p_payout uuid, p_reference text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform orders_require_admin();
    update contractor_payouts set paid_at = p_now, paid_reference = p_reference where id = p_payout and paid_at is null;
    if not found then
        raise exception 'no such unpaid payout' using errcode = 'no_data_found';
    end if;
end
$$;
revoke all on function record_payout(uuid, uuid, bigint, text, timestamptz), mark_payout_paid(uuid, text, timestamptz) from public;
grant execute on function record_payout(uuid, uuid, bigint, text, timestamptz), mark_payout_paid(uuid, text, timestamptz) to aura_app;
