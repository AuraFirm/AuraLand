-- A published credential file that should no longer exist (its holder made it private) is removed from storage and its
-- record forgotten, so the next run does not think it is still there.
create function forget_passport_artifact(p_name text) returns void
    language sql security definer set search_path = pg_catalog, public as $$
    delete from passport_artifacts where name = p_name
$$;
revoke all on function forget_passport_artifact(text) from public;
grant execute on function forget_passport_artifact(text) to aura_worker;
