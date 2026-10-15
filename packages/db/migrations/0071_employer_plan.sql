-- Employer subscriptions (Stage 9, slice 9). Searching public credentials and opening reports needs two things: a platform
-- administrator's approval of the company (Stage 7) AND a plan that includes employer search (a subscription, Stage 9). Losing
-- either ends access at once. Everything that asks "is this employer allowed" goes through this one function.
create or replace function employer_is_approved(p_org uuid) returns boolean
    language sql stable security definer set search_path = pg_catalog, public as $$
    select app_org_role(p_org) is not null
       and exists (select 1 from employer_orgs e where e.org_id = p_org and e.revoked_at is null)
       and coalesce((select o.employer_search from org_entitlements(p_org) o), false)
$$;
