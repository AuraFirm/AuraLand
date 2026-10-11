-- The one job queue (docs/kit/05). Everything asynchronous goes through it: judging, validation,
-- cleanup, mail. A job is leased by one worker or judge node at a time; every lease raises the job's
-- epoch (a fencing token), and results are accepted only with the current epoch, checked in the same
-- statement that changes the row, so a node that was presumed dead cannot overwrite a newer result.
--
-- Only the new `aura_worker` role touches this table: workers, and the API on behalf of judge nodes
-- (which authenticate themselves, not as a person). Neither `aura_app` nor `aura_auth` can read it.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'aura_worker') then
        create role aura_worker nologin;
    end if;
end
$$;
grant usage on schema public to aura_worker;

create table jobs (
    id uuid primary key default uuidv7(),
    kind text not null,
    org_id uuid,
    payload jsonb not null,
    queue text not null,
    priority smallint not null default 5,
    state text not null default 'ready',
    attempt int not null default 0,
    max_attempts int not null default 5,
    run_after timestamptz not null,
    lease_owner text,
    lease_epoch bigint not null default 0,
    lease_expires_at timestamptz,
    dedupe_key text,
    result jsonb,
    last_error text,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint jobs_kind check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and char_length(kind) <= 60),
    constraint jobs_queue check (queue ~ '^[a-z][a-z0-9-]*$' and char_length(queue) <= 60),
    constraint jobs_payload_size check (pg_column_size(payload) <= 65536),
    constraint jobs_result_size check (result is null or pg_column_size(result) <= 65536),
    constraint jobs_priority check (priority between 0 and 9),
    constraint jobs_state check (state in ('ready', 'leased', 'done', 'dead')),
    constraint jobs_attempts check (attempt >= 0 and max_attempts between 1 and 20 and attempt <= max_attempts),
    constraint jobs_lease_pair check ((state = 'leased') = (lease_owner is not null and lease_expires_at is not null)),
    constraint jobs_owner_size check (lease_owner is null or char_length(lease_owner) between 1 and 100),
    constraint jobs_error_size check (last_error is null or char_length(last_error) <= 2000),
    constraint jobs_dedupe_size check (dedupe_key is null or char_length(dedupe_key) between 1 and 200),
    constraint jobs_epoch check (lease_epoch >= 0 and (state <> 'leased' or lease_epoch >= 1))
);
create unique index jobs_dedupe on jobs (queue, dedupe_key)
    where dedupe_key is not null and state in ('ready', 'leased');
create index jobs_ready on jobs (queue, priority, run_after, id) where state = 'ready';
create index jobs_expiry on jobs (lease_expires_at, id) where state = 'leased';
create index jobs_org on jobs (org_id) where org_id is not null;

-- A job's identity and the history that only moves forward cannot be rewritten: kind, queue, payload,
-- creation time and dedupe key are fixed; the epoch never goes down; finished jobs do not change.
create function jobs_guard() returns trigger language plpgsql as $$
begin
    if old.state in ('done', 'dead') then
        raise exception 'a finished job does not change' using errcode = 'insufficient_privilege';
    end if;
    if new.kind <> old.kind or new.queue <> old.queue or new.payload <> old.payload
       or new.created_at <> old.created_at or new.dedupe_key is distinct from old.dedupe_key then
        raise exception 'a job keeps its kind, queue, payload and dedupe key' using errcode = 'insufficient_privilege';
    end if;
    if new.lease_epoch < old.lease_epoch or new.attempt < old.attempt then
        raise exception 'epoch and attempt only go up' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
create trigger jobs_guard before update on jobs for each row execute function jobs_guard();

alter table jobs enable row level security;
alter table jobs force row level security;
create policy jobs_worker on jobs for all to aura_worker using (true) with check (true);
grant select, insert, update on jobs to aura_worker;
