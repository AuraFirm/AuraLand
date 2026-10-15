-- Environments and their runs (Stage 8, ADR 0034). An environment is a recipe an organization owns (spec v2: image
-- digest, commands, limits, a verifier). A run is one agent evaluated in it on a judge node that declares Tier 2. Runs
-- ride the job queue (lease, heartbeat, fencing, dead-lettering), so this file holds only the records and the rules that
-- are not the queue's: who may ask, what a finished run says, and where a run may be used.

create table environments (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    slug text not null,
    title text not null,
    spec jsonb not null,
    -- Where the root file system and the hidden material live in object storage. Both are pinned: the image by the
    -- digest in the spec, the hidden material by its own digest.
    image_key text not null,
    hidden_key text not null,
    hidden_sha256 bytea not null,
    created_by uuid not null references users (id),
    created_at timestamptz not null,
    retired_at timestamptz,
    unique (org_id, slug),
    constraint environments_slug check (slug ~ '^[a-z][a-z0-9-]{2,39}$'),
    constraint environments_title check (char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]'),
    constraint environments_spec check (jsonb_typeof(spec) = 'object' and spec ->> 'spec_version' = '2'
        and pg_column_size(spec) <= 16384),
    constraint environments_hash check (octet_length(hidden_sha256) = 32),
    constraint environments_keys check (char_length(image_key) <= 200 and char_length(hidden_key) <= 200)
);
create index environments_created_by on environments (created_by);
alter table environments enable row level security;
alter table environments force row level security;
create policy environments_read on environments for select to aura_app
    using (app_org_role(org_id) is not null);
create policy environments_worker on environments for select to aura_worker using (true);
grant select on environments to aura_app, aura_worker;

create function create_environment(p_org uuid, p_slug text, p_title text, p_spec jsonb, p_image_key text,
                                   p_hidden_key text, p_hidden_sha256 bytea, p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_id uuid;
begin
    if v_user is null or coalesce(app_org_role(p_org) in ('owner', 'admin', 'setter'), false) is not true then
        raise exception 'no such organization' using errcode = 'no_data_found';
    end if;
    insert into environments (org_id, slug, title, spec, image_key, hidden_key, hidden_sha256, created_by, created_at)
    values (p_org, p_slug, p_title, p_spec, p_image_key, p_hidden_key, p_hidden_sha256, v_user, p_now)
    returning id into v_id;
    return v_id;
end
$$;

create table env_runs (
    id uuid primary key default uuidv7(),
    org_id uuid not null references orgs (id),
    environment_id uuid not null references environments (id),
    requested_by uuid not null references users (id),
    agent_label text not null,
    state text not null default 'queued',
    -- What the run is meant to support. The rule for where a gVisor result may be used is a generated column, so no
    -- query can forget it.
    assurance_level smallint not null default 0,
    customer_delivery boolean not null default false,
    customer_opted_in boolean not null default false,
    isolation text,
    outcome text,
    score numeric(4, 3),
    trace jsonb,
    trace_signature text,
    node_id uuid references judge_nodes (id),
    created_at timestamptz not null,
    finished_at timestamptz,
    eligible boolean generated always as (
        state = 'done' and (isolation = 'firecracker'
            or (assurance_level <= 1 and (not customer_delivery or customer_opted_in)))
    ) stored,
    constraint env_runs_state check (state in ('queued', 'done', 'failed')),
    constraint env_runs_label check (char_length(agent_label) between 1 and 80 and agent_label !~ '[[:cntrl:]]'),
    constraint env_runs_assurance check (assurance_level between 0 and 3),
    constraint env_runs_optin check (not customer_opted_in or customer_delivery),
    constraint env_runs_isolation check (isolation is null or isolation in ('gvisor', 'firecracker')),
    constraint env_runs_outcome check (outcome is null or outcome in ('completed', 'setup_failed', 'sandbox_error')),
    constraint env_runs_score check (score is null or score between 0 and 1),
    constraint env_runs_done check (state <> 'done' or (isolation is not null and outcome is not null and trace is not null
        and trace_signature is not null and node_id is not null and finished_at is not null)),
    constraint env_runs_waiting check (state <> 'queued' or (isolation is null and outcome is null and trace is null
        and finished_at is null)),
    constraint env_runs_trace_size check (trace is null or pg_column_size(trace) <= 1048576)
);
create index env_runs_environment on env_runs (environment_id, id desc);
create index env_runs_org on env_runs (org_id);
create index env_runs_requested_by on env_runs (requested_by);
create index env_runs_node on env_runs (node_id);

-- A finished run is a record: it never changes.
create function env_runs_guard() returns trigger language plpgsql as $$
begin
    if old.state <> 'queued' then
        raise exception 'a finished run is not changed' using errcode = 'insufficient_privilege';
    end if;
    if new.environment_id <> old.environment_id or new.requested_by <> old.requested_by
       or new.assurance_level <> old.assurance_level or new.customer_delivery <> old.customer_delivery
       or new.customer_opted_in <> old.customer_opted_in or new.agent_label <> old.agent_label then
        raise exception 'what a run was asked to do does not change' using errcode = 'insufficient_privilege';
    end if;
    return new;
end
$$;
create trigger env_runs_guard before update on env_runs for each row execute function env_runs_guard();

alter table env_runs enable row level security;
alter table env_runs force row level security;
create policy env_runs_read on env_runs for select to aura_app using (app_org_role(org_id) is not null);
create policy env_runs_worker on env_runs for select to aura_worker using (true);
grant select on env_runs to aura_app, aura_worker;

-- Anyone who may author in the environment's organization may ask for a run. The run is queued and a job is put on the
-- 'env' queue for a node that declares Tier 2; one open run per (environment, agent label) at a time.
create function request_env_run(p_env uuid, p_label text, p_delivery boolean, p_opted_in boolean, p_level int,
                                p_now timestamptz) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_env environments%rowtype;
    v_id uuid;
begin
    select * into v_env from environments where id = p_env and retired_at is null;
    if not found or v_user is null or coalesce(app_org_role(v_env.org_id) in ('owner', 'admin', 'setter'), false) is not true then
        raise exception 'no such environment' using errcode = 'no_data_found';
    end if;
    if exists (select 1 from env_runs where environment_id = p_env and agent_label = p_label and state = 'queued') then
        raise exception 'a run for this agent is already waiting' using errcode = '55000';
    end if;
    if (select count(*) from jobs where queue = 'env' and state = 'ready') >= 1000 then
        raise exception 'the run queue is full' using errcode = '54000';
    end if;
    insert into env_runs (org_id, environment_id, requested_by, agent_label, assurance_level, customer_delivery,
                          customer_opted_in, created_at)
    values (v_env.org_id, p_env, v_user, p_label, p_level, p_delivery, p_opted_in, p_now) returning id into v_id;
    insert into jobs (kind, org_id, payload, queue, priority, max_attempts, run_after, dedupe_key, created_at, updated_at)
    values ('env.run', v_env.org_id, jsonb_build_object('env_run_id', v_id), 'env', 5, 2, p_now, 'env-run:' || v_id::text, p_now, p_now);
    return v_id;
end
$$;

-- The node reports a finished run (called with the job's lease already checked by the application). The row must still be
-- waiting; the eligibility of the result is computed from what the run was asked to support.
create function finish_env_run(p_run uuid, p_node uuid, p_isolation text, p_outcome text, p_score numeric,
                               p_trace jsonb, p_signature text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
begin
    update env_runs
       set state = case when p_outcome = 'sandbox_error' then 'failed' else 'done' end,
           isolation = p_isolation, outcome = p_outcome, score = p_score, trace = p_trace, trace_signature = p_signature,
           node_id = p_node, finished_at = p_now
     where id = p_run and state = 'queued';
    if not found then
        raise exception 'this run is not waiting' using errcode = 'object_not_in_prerequisite_state';
    end if;
end
$$;

-- A run whose job died (the node kept failing, or no node ever answered) is failed, so nobody waits for it forever.
create function fail_dead_env_runs(p_now timestamptz) returns int
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_count int;
begin
    update env_runs r set state = 'failed', outcome = 'sandbox_error', finished_at = p_now
     where r.state = 'queued'
       and exists (select 1 from jobs j where j.queue = 'env' and j.dedupe_key = 'env-run:' || r.id::text and j.state = 'dead');
    get diagnostics v_count = row_count;
    return v_count;
end
$$;

revoke all on function create_environment(uuid, text, text, jsonb, text, text, bytea, timestamptz),
    request_env_run(uuid, text, boolean, boolean, int, timestamptz),
    finish_env_run(uuid, uuid, text, text, numeric, jsonb, text, timestamptz), fail_dead_env_runs(timestamptz) from public;
grant execute on function create_environment(uuid, text, text, jsonb, text, text, bytea, timestamptz),
    request_env_run(uuid, text, boolean, boolean, int, timestamptz) to aura_app;
grant execute on function finish_env_run(uuid, uuid, text, text, numeric, jsonb, text, timestamptz), fail_dead_env_runs(timestamptz) to aura_worker;
