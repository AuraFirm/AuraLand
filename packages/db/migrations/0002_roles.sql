-- Two group roles carry all application privileges (docs/stages/stage-1-plan.md section 3):
--   aura_app  tenant data; every table it can read is protected by row-level security.
--   aura_auth identity work before anyone is logged in, such as finding the user for a login token.
-- They are NOLOGIN groups. Operations creates login roles (for example the API's connection user),
-- grants them membership in both groups, and each request switches to one group with SET LOCAL ROLE,
-- so a compromise of one code path cannot use the other group's privileges.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'aura_app') then
        create role aura_app nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'aura_auth') then
        create role aura_auth nologin;
    end if;
end
$$;

-- Nobody but the owner may create objects in the public schema.
revoke create on schema public from public;
grant usage on schema public to aura_app, aura_auth;
