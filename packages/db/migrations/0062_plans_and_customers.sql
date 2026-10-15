-- Plans and customers (Stage 9, slice 1). A plan is a row of limits and switches; an organization is on the free plan
-- unless a platform administrator put it on another one. Everything that asks "may this organization do X" asks the one
-- function org_entitlements, so the answer cannot differ between features and an unknown plan cannot open anything.
--
-- The numbers below are PLACEHOLDERS chosen by the engineer (the owner has not set pricing): change them by a migration.

create table plans (
    key text primary key,
    name text not null,
    members_max int not null,
    env_runs_per_month int not null,
    verifications_per_month int not null,
    webhook_endpoints_max int not null,
    sso boolean not null,
    scim boolean not null,
    employer_search boolean not null,
    price_minor bigint not null,
    currency char(3) not null,
    constraint plans_key check (key ~ '^[a-z][a-z0-9_]{1,23}$'),
    constraint plans_name check (char_length(name) between 1 and 60 and name !~ '[[:cntrl:]]'),
    constraint plans_limits check (members_max >= 1 and env_runs_per_month >= 0 and verifications_per_month >= 0
        and webhook_endpoints_max >= 0),
    constraint plans_price check (price_minor >= 0 and currency ~ '^[A-Z]{3}$'),
    -- A plan that sells single sign-on and provisioning together or not at all keeps the console simple.
    constraint plans_sso_scim check (sso or not scim)
);
alter table plans enable row level security;
alter table plans force row level security;
create policy plans_read on plans for select to aura_app, aura_worker using (true);
grant select on plans to aura_app, aura_worker;

insert into plans (key, name, members_max, env_runs_per_month, verifications_per_month, webhook_endpoints_max, sso, scim,
                   employer_search, price_minor, currency)
values ('free', 'Free', 5, 20, 100, 0, false, false, false, 0, 'USD'),
       ('team', 'Team', 50, 500, 5000, 5, false, false, false, 49900, 'USD'),
       ('enterprise', 'Enterprise', 10000, 50000, 500000, 50, true, true, false, 0, 'USD'),
       ('employer', 'Employer', 25, 0, 100000, 10, false, false, true, 99900, 'USD');

-- Which plan an organization is on, and the references staff need to find its contract and billing account. Billing
-- references are not for ordinary members: owners and administrators of the organization may read the row.
create table customers (
    org_id uuid primary key references orgs (id),
    plan text not null references plans (key),
    billing_ref text,
    contract_ref text,
    updated_by uuid not null references users (id),
    updated_at timestamptz not null,
    constraint customers_refs check ((billing_ref is null or char_length(billing_ref) between 1 and 120)
        and (contract_ref is null or char_length(contract_ref) between 1 and 120))
);
create index customers_plan on customers (plan);
create index customers_updated_by on customers (updated_by);
alter table customers enable row level security;
alter table customers force row level security;
create policy customers_read on customers for select to aura_app
    using (coalesce(app_org_role(org_id) in ('owner', 'admin'), false));
create policy customers_worker on customers for select to aura_worker using (true);
grant select on customers to aura_app, aura_worker;

-- Only a platform administrator changes a plan (a sale is a business act, not a setting).
create function set_org_plan(p_org uuid, p_plan text, p_billing_ref text, p_contract_ref text, p_now timestamptz)
    returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only a platform administrator may change a plan' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from orgs where id = p_org) then
        raise exception 'no such organization' using errcode = 'no_data_found';
    end if;
    insert into customers (org_id, plan, billing_ref, contract_ref, updated_by, updated_at)
    values (p_org, p_plan, p_billing_ref, p_contract_ref, v_user, p_now)
    on conflict (org_id) do update set plan = excluded.plan, billing_ref = excluded.billing_ref,
        contract_ref = excluded.contract_ref, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end
$$;

-- The one place that answers "what may this organization do". Any member may ask about their own organization; anyone
-- else gets nothing. An organization with no customer row, or whose plan row is somehow missing, is on the free plan.
create function org_entitlements(p_org uuid)
    returns table (plan text, name text, members_max int, env_runs_per_month int, verifications_per_month int,
                   webhook_endpoints_max int, sso boolean, scim boolean, employer_search boolean)
    language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
    if app_org_role(p_org) is null then
        return;
    end if;
    return query
    select p.key, p.name, p.members_max, p.env_runs_per_month, p.verifications_per_month, p.webhook_endpoints_max,
           p.sso, p.scim, p.employer_search
    from plans p
    where p.key = coalesce((select c.plan from customers c where c.org_id = p_org), 'free');
end
$$;
revoke all on function set_org_plan(uuid, text, text, text, timestamptz), org_entitlements(uuid) from public;
grant execute on function set_org_plan(uuid, text, text, text, timestamptz), org_entitlements(uuid) to aura_app;
grant execute on function org_entitlements(uuid) to aura_worker;
