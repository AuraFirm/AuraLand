-- A version stuck in 'validating' (Stage 4B): its job died because no node finished it within the
-- attempts allowed, or the job was swept away. Housekeeping sends such a version back to 'uploaded' so
-- its setter can ask again. No report is written: nothing was observed. The version moves only when no
-- live (ready or leased) validation job names it, so a slow but healthy validation is never cut short.
create function abort_orphaned_validations(p_now timestamptz) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_count int;
begin
    with orphans as (
        select v.id from task_versions v
         where v.state = 'validating'
           and not exists (select 1 from jobs j
                            where j.kind = 'task.validate' and j.state in ('ready', 'leased')
                              and j.payload->>'task_version_id' = v.id::text)
         order by v.id limit 1000
         for update of v skip locked)
    update task_versions t set state = 'uploaded' from orphans o where t.id = o.id;
    get diagnostics v_count = row_count;
    return v_count;
end
$$;
revoke all on function abort_orphaned_validations(timestamptz) from public;
grant execute on function abort_orphaned_validations(timestamptz) to aura_worker;
