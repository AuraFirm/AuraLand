-- Judging reads the spec and the bundle's size and hash of the task version behind a submission. The
-- worker role gets exactly those columns, read-only: not the statement, not who made it, not its state
-- history, and no write access to task versions.
create policy task_versions_worker on task_versions for select to aura_worker using (true);
grant select (id, org_id, task_id, state, spec, bundle_bytes, bundle_sha256) on task_versions to aura_worker;

-- The worker and the API acting for a judge node write audit entries of their own kind only: they
-- cannot append an entry that claims a person did something.
create policy audit_insert_worker on audit_log for insert to aura_worker
    with check (actor_kind in ('worker', 'system') and actor_user_id is null);
grant insert on audit_log to aura_worker;
