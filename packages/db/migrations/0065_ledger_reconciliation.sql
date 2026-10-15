-- A money ledger and the monthly reconciliation (Stage 9, slice 4). The ledger is double entry: every transaction is a set of
-- debit and credit lines that must add up, per currency, when the transaction commits; a transaction that does not balance
-- cannot be saved. Amounts are whole minor units (bigint), never floats. Rows are never changed. The ledger is internal to the
-- platform: only the worker role reads or writes it.

create table ledger_txns (
    id uuid primary key default uuidv7(),
    kind text not null,
    -- The business fact this transaction records (a payout batch, a share run); with the kind it is unique, so posting the
    -- same fact twice returns the first transaction instead of a second one.
    ref text not null,
    occurred_at timestamptz not null,
    unique (kind, ref),
    constraint ledger_txns_kind check (kind ~ '^[a-z][a-z_]{0,39}$'),
    constraint ledger_txns_ref check (char_length(ref) between 1 and 120)
);
create table ledger_entries (
    txn_id uuid not null references ledger_txns (id),
    line smallint not null,
    account text not null,
    direction char(1) not null,
    amount_minor bigint not null,
    currency char(3) not null,
    primary key (txn_id, line),
    constraint ledger_entries_account check (account ~ '^[a-z][a-z_]{0,39}(:[a-z0-9_-]{1,60})?$'),
    constraint ledger_entries_direction check (direction in ('D', 'C')),
    constraint ledger_entries_amount check (amount_minor > 0),
    constraint ledger_entries_currency check (currency ~ '^[A-Z]{3}$')
);

-- Checked when the transaction commits, so the lines may be inserted one at a time. Needs at least two lines, and debits equal
-- credits in every currency that appears.
create function ledger_check_balance() returns trigger language plpgsql as $$
declare
    v_txn uuid;
    v_lines int;
    v_unbalanced int;
begin
    -- Two tables use this function and each row has different fields, so pick the right one with an if, not an expression.
    if tg_table_name = 'ledger_txns' then
        v_txn := new.id;
    else
        v_txn := new.txn_id;
    end if;
    select count(*) into v_lines from ledger_entries where txn_id = v_txn;
    select count(*) into v_unbalanced from (
        select currency from ledger_entries where txn_id = v_txn group by currency
        having sum(case direction when 'D' then amount_minor else -amount_minor end) <> 0) as t;
    if v_lines < 2 or v_unbalanced > 0 then
        raise exception 'ledger transaction % does not balance', v_txn using errcode = 'check_violation';
    end if;
    return null;
end
$$;
create constraint trigger ledger_txns_balance after insert on ledger_txns deferrable initially deferred
    for each row execute function ledger_check_balance();
create constraint trigger ledger_entries_balance after insert on ledger_entries deferrable initially deferred
    for each row execute function ledger_check_balance();
create function ledger_guard() returns trigger language plpgsql as $$
begin
    raise exception 'the ledger is kept as it was' using errcode = 'insufficient_privilege';
end
$$;
create trigger ledger_txns_guard before update or delete on ledger_txns for each row execute function ledger_guard();
create trigger ledger_entries_guard before update or delete on ledger_entries for each row execute function ledger_guard();
alter table ledger_txns enable row level security;
alter table ledger_txns force row level security;
alter table ledger_entries enable row level security;
alter table ledger_entries force row level security;
create policy ledger_txns_worker on ledger_txns for select to aura_worker using (true);
create policy ledger_entries_worker on ledger_entries for select to aura_worker using (true);
grant select on ledger_txns, ledger_entries to aura_worker;

-- Posts a transaction once. p_entries is an array of {account, direction, amount_minor, currency}. Returns the transaction's id,
-- the existing one when this (kind, ref) was posted before.
create function post_ledger_txn(p_kind text, p_ref text, p_at timestamptz, p_entries jsonb) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_id uuid;
    v_line int := 0;
    v_entry jsonb;
begin
    if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) not between 2 and 20 then
        raise exception 'a transaction has 2 to 20 lines' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_ref, 0));
    select id into v_id from ledger_txns where kind = p_kind and ref = p_ref;
    if found then
        return v_id;
    end if;
    insert into ledger_txns (kind, ref, occurred_at) values (p_kind, p_ref, p_at) returning id into v_id;
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_line := v_line + 1;
        insert into ledger_entries (txn_id, line, account, direction, amount_minor, currency)
        values (v_id, v_line, v_entry ->> 'account', v_entry ->> 'direction', (v_entry ->> 'amount_minor')::bigint,
                v_entry ->> 'currency');
    end loop;
    return v_id;
end
$$;

-- One row per month that was reconciled: what we counted, what the provider says, and the differences (empty when clean).
create table reconciliations (
    period text primary key,
    ours jsonb not null,
    theirs jsonb not null,
    differences jsonb not null,
    status text not null,
    checked_at timestamptz not null,
    constraint reconciliations_period check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    constraint reconciliations_status check (status in ('clean', 'differences')),
    constraint reconciliations_consistent check ((status = 'clean') = (jsonb_array_length(differences) = 0))
);
create trigger reconciliations_guard before update or delete on reconciliations
    for each row execute function ledger_guard();
alter table reconciliations enable row level security;
alter table reconciliations force row level security;
create policy reconciliations_worker on reconciliations for select to aura_worker using (true);
grant select on reconciliations to aura_worker;

create function record_reconciliation(p_period text, p_ours jsonb, p_theirs jsonb, p_differences jsonb, p_now timestamptz)
    returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    insert into reconciliations (period, ours, theirs, differences, status, checked_at)
    values (p_period, p_ours, p_theirs, p_differences,
            case when jsonb_array_length(p_differences) = 0 then 'clean' else 'differences' end, p_now)
    on conflict (period) do nothing;
    return found;
end
$$;

-- What every organization used in [p_from, p_to): the platform's own view, for the worker only.
create function usage_totals(p_from timestamptz, p_to timestamptz) returns table (org_id uuid, kind text, used bigint)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select e.org_id, e.kind, count(*) from usage_events e
     where e.occurred_at >= p_from and e.occurred_at < p_to group by e.org_id, e.kind order by e.org_id, e.kind
$$;
revoke all on function post_ledger_txn(text, text, timestamptz, jsonb), record_reconciliation(text, jsonb, jsonb, jsonb, timestamptz),
    usage_totals(timestamptz, timestamptz) from public;
grant execute on function post_ledger_txn(text, text, timestamptz, jsonb), record_reconciliation(text, jsonb, jsonb, jsonb, timestamptz),
    usage_totals(timestamptz, timestamptz) to aura_worker;
