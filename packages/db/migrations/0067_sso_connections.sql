-- Enterprise single sign-on, part 1 (Stage 9, slice 6a): an organization's OpenID Connect connection and the email domains it has
-- proved it controls. Signing people in with them is the next migration. Only organizations whose plan includes SSO may have a
-- connection (checked in the function that saves it). The client secret is needed in the clear to talk to the provider, so no
-- application role can select it: column privileges leave it out.

create table sso_connections (
    org_id uuid primary key references orgs (id),
    issuer text not null,
    client_id text not null,
    client_secret text not null,
    authorization_endpoint text not null,
    token_endpoint text not null,
    jwks_uri text not null,
    created_by uuid not null references users (id),
    updated_at timestamptz not null,
    constraint sso_connections_issuer check (char_length(issuer) <= 500 and issuer like 'https://%'),
    constraint sso_connections_client check (char_length(client_id) between 1 and 200 and char_length(client_secret) between 1 and 400),
    constraint sso_connections_endpoints check (char_length(authorization_endpoint) <= 2000 and char_length(token_endpoint) <= 2000
        and char_length(jwks_uri) <= 2000)
);
create index sso_connections_created_by on sso_connections (created_by);
alter table sso_connections enable row level security;
alter table sso_connections force row level security;
create policy sso_connections_read on sso_connections for select to aura_app
    using (coalesce(app_org_role(org_id) in ('owner', 'admin'), false));
create policy sso_connections_worker on sso_connections for select to aura_worker using (true);
grant select (org_id, issuer, client_id, authorization_endpoint, token_endpoint, jwks_uri, created_by, updated_at)
    on sso_connections to aura_app;
grant select on sso_connections to aura_worker;

create table sso_domains (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    domain text not null,
    -- The value the organization publishes in DNS to show it controls the domain; random, not secret once published.
    token text not null,
    created_at timestamptz not null,
    verified_at timestamptz,
    unique (org_id, domain),
    constraint sso_domains_domain check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' and char_length(domain) <= 253),
    constraint sso_domains_token check (token ~ '^[0-9a-f]{32}$')
);
-- A domain can be verified by one organization only: whoever proves control first holds it.
create unique index sso_domains_verified on sso_domains (domain) where verified_at is not null;
alter table sso_domains enable row level security;
alter table sso_domains force row level security;
create policy sso_domains_read on sso_domains for select to aura_app
    using (coalesce(app_org_role(org_id) in ('owner', 'admin'), false));
create policy sso_domains_worker on sso_domains for select to aura_worker using (true);
grant select on sso_domains to aura_app, aura_worker;

create function save_sso_connection(p_org uuid, p_issuer text, p_client_id text, p_client_secret text, p_authorization text,
                                    p_token text, p_jwks text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform webhook_owner_only(p_org); -- owners and administrators of the organization, else "no such organization"
    if not coalesce((select sso from org_entitlements(p_org)), false) then
        raise exception 'this plan does not include single sign-on' using errcode = 'feature_not_supported';
    end if;
    insert into sso_connections (org_id, issuer, client_id, client_secret, authorization_endpoint, token_endpoint, jwks_uri,
                                 created_by, updated_at)
    values (p_org, p_issuer, p_client_id, p_client_secret, p_authorization, p_token, p_jwks,
            nullif(current_setting('app.user_id', true), '')::uuid, p_now)
    on conflict (org_id) do update set issuer = excluded.issuer, client_id = excluded.client_id,
        client_secret = excluded.client_secret, authorization_endpoint = excluded.authorization_endpoint,
        token_endpoint = excluded.token_endpoint, jwks_uri = excluded.jwks_uri, updated_at = excluded.updated_at;
end
$$;

create function delete_sso_connection(p_org uuid) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform webhook_owner_only(p_org);
    delete from sso_connections where org_id = p_org;
    if not found then
        raise exception 'no such connection' using errcode = 'no_data_found';
    end if;
end
$$;

-- Returns the token to publish. Asking again for the same domain returns the same token, so the instructions do not change under a
-- person who is half-way through setting up DNS. At most ten domains per organization.
create function add_sso_domain(p_org uuid, p_domain text, p_token text, p_now timestamptz) returns text
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_token text;
begin
    perform webhook_owner_only(p_org);
    select token into v_token from sso_domains where org_id = p_org and domain = p_domain;
    if found then
        return v_token;
    end if;
    if (select count(*) from sso_domains where org_id = p_org) >= 10 then
        raise exception 'too many domains' using errcode = 'program_limit_exceeded';
    end if;
    insert into sso_domains (org_id, domain, token, created_at) values (p_org, p_domain, p_token, p_now);
    return p_token;
end
$$;

-- The caller has already checked DNS; this records it. A domain someone else verified first cannot be verified again (unique index).
create function verify_sso_domain(p_org uuid, p_domain text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform webhook_owner_only(p_org);
    update sso_domains set verified_at = coalesce(verified_at, p_now) where org_id = p_org and domain = p_domain;
    if not found then
        raise exception 'no such domain' using errcode = 'no_data_found';
    end if;
end
$$;

create function remove_sso_domain(p_org uuid, p_domain text) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    perform webhook_owner_only(p_org);
    delete from sso_domains where org_id = p_org and domain = p_domain;
    if not found then
        raise exception 'no such domain' using errcode = 'no_data_found';
    end if;
end
$$;
revoke all on function save_sso_connection(uuid, text, text, text, text, text, text, timestamptz), delete_sso_connection(uuid),
    add_sso_domain(uuid, text, text, timestamptz), verify_sso_domain(uuid, text, timestamptz), remove_sso_domain(uuid, text) from public;
grant execute on function save_sso_connection(uuid, text, text, text, text, text, text, timestamptz), delete_sso_connection(uuid),
    add_sso_domain(uuid, text, text, timestamptz), verify_sso_domain(uuid, text, timestamptz), remove_sso_domain(uuid, text) to aura_app;
