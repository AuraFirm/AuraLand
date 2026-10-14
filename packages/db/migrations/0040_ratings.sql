-- Ratings (Stage 5, slice 9; ADR 0031 decision 7).
--   * ratings: a person's current rating per dimension. rating_events: one row per person per rated contest,
--     the history. contest_ratings: one row per rated contest and dimension once it has been rated (or
--     skipped), which makes the job idempotent: a contest is rated at most once, ever;
--   * only the worker writes them, and only through rating_apply, which re-checks that the contest is rated
--     and finalized, that nobody who did not take part gets a rating, and that contests are rated oldest
--     finalized first under one advisory lock, so the priors a contest is rated against are final;
--   * a rating is readable by its owner and by anyone when the person's profile is public.

create table ratings (
    user_id uuid not null references users (id) on delete cascade,
    dimension text not null constraint ratings_dimension check (dimension ~ '^[a-z][a-z0-9_]{0,31}$'),
    mu double precision not null,
    sigma double precision not null constraint ratings_sigma check (sigma > 0),
    contests integer not null constraint ratings_contests check (contests >= 1),
    updated_at timestamptz not null,
    primary key (user_id, dimension),
    constraint ratings_finite check (mu between -10000 and 20000 and sigma < 10000)
);

create table rating_events (
    user_id uuid not null references users (id) on delete cascade,
    contest_id uuid not null references contests (id),
    dimension text not null,
    rank integer not null constraint rating_events_rank check (rank >= 1),
    mu_before double precision not null,
    mu_after double precision not null,
    sigma_after double precision not null constraint rating_events_sigma check (sigma_after > 0),
    performance double precision not null,
    created_at timestamptz not null,
    primary key (user_id, contest_id, dimension),
    constraint rating_events_finite check (mu_before between -10000 and 20000 and mu_after between -10000 and 20000)
);
create index rating_events_contest on rating_events (contest_id, dimension);

create table contest_ratings (
    contest_id uuid not null references contests (id),
    org_id uuid not null references orgs (id),
    dimension text not null,
    status text not null constraint contest_ratings_status check (status in ('rated', 'skipped')),
    participants integer not null constraint contest_ratings_participants check (participants >= 0),
    parameters_version integer not null,
    created_at timestamptz not null,
    primary key (contest_id, dimension)
);
create index contest_ratings_org on contest_ratings (org_id);

-- History is not rewritten: a rating row changes only through rating_apply (which is the owner), never by
-- an update that moves an event, and rating events never change at all.
create function rating_events_guard() returns trigger language plpgsql as $$
begin
    raise exception 'a rating event never changes' using errcode = 'insufficient_privilege';
end
$$;
create trigger rating_events_guard before update or delete on rating_events
    for each row execute function rating_events_guard();
create function contest_ratings_guard() returns trigger language plpgsql as $$
begin
    raise exception 'a rating run never changes' using errcode = 'insufficient_privilege';
end
$$;
create trigger contest_ratings_guard before update or delete on contest_ratings
    for each row execute function contest_ratings_guard();

alter table ratings enable row level security;
alter table ratings force row level security;
alter table rating_events enable row level security;
alter table rating_events force row level security;
alter table contest_ratings enable row level security;
alter table contest_ratings force row level security;

create policy ratings_read on ratings for select to aura_app
    using (user_id = app_user() or exists (select 1 from profiles p where p.user_id = ratings.user_id and p.visibility = 'public'));
create policy rating_events_read on rating_events for select to aura_app
    using (user_id = app_user() or exists (select 1 from profiles p where p.user_id = rating_events.user_id and p.visibility = 'public'));
create policy contest_ratings_read on contest_ratings for select to aura_app
    using (exists (select 1 from contests c where c.id = contest_id));
grant select on ratings, rating_events, contest_ratings to aura_app;

-- The next contest to rate: rated, finalized, not yet rated, oldest finalized first. Takes the lock that
-- serializes rating runs for the rest of the transaction; returns no row when there is nothing to do.
create function rating_begin(p_dimension text) returns uuid
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_id uuid;
begin
    perform pg_advisory_xact_lock(hashtextextended('aura.rating.' || p_dimension, 0));
    select c.id into v_id from contests c
     where c.rated and c.state = 'finalized'
       and not exists (select 1 from contest_ratings r where r.contest_id = c.id and r.dimension = p_dimension)
     order by c.finalized_at, c.id limit 1;
    return v_id;
end
$$;

create function rating_priors(p_users uuid[], p_dimension text)
    returns table (user_id uuid, mu double precision, sigma double precision)
    language sql stable security definer set search_path = pg_catalog, public as $$
    select r.user_id, r.mu, r.sigma from ratings r
     where r.dimension = p_dimension and r.user_id = any (p_users) order by r.user_id
$$;

-- Records the outcome of rating one contest. p_events: [{user_id, rank, mu_before, mu_after, sigma_after,
-- performance}] (empty when skipped). Refuses a contest that is not the next one, so a stale or repeated
-- run changes nothing.
create function rating_apply(p_contest uuid, p_dimension text, p_status text, p_parameters_version int,
                             p_events jsonb, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
    v_count int := jsonb_array_length(p_events);
begin
    perform pg_advisory_xact_lock(hashtextextended('aura.rating.' || p_dimension, 0));
    select org_id into v_org from contests where id = p_contest and rated and state = 'finalized';
    if v_org is null or exists (select 1 from contest_ratings where contest_id = p_contest and dimension = p_dimension) then
        raise exception 'this contest is not waiting to be rated' using errcode = 'object_not_in_prerequisite_state';
    end if;
    if p_contest is distinct from (select c.id from contests c
         where c.rated and c.state = 'finalized'
           and not exists (select 1 from contest_ratings r where r.contest_id = c.id and r.dimension = p_dimension)
         order by c.finalized_at, c.id limit 1) then
        raise exception 'an older contest is rated first' using errcode = 'object_not_in_prerequisite_state';
    end if;
    if (p_status = 'skipped') <> (v_count = 0) then
        raise exception 'a skipped run has no events and a rated run has some' using errcode = 'check_violation';
    end if;
    if exists (select 1 from jsonb_to_recordset(p_events) as e(user_id uuid)
                where not exists (select 1 from registrations g where g.contest_id = p_contest and g.user_id = e.user_id)) then
        raise exception 'only people who took part are rated' using errcode = 'check_violation';
    end if;
    insert into rating_events (user_id, contest_id, dimension, rank, mu_before, mu_after, sigma_after, performance, created_at)
    select e.user_id, p_contest, p_dimension, e.rank, e.mu_before, e.mu_after, e.sigma_after, e.performance, p_now
      from jsonb_to_recordset(p_events) as e(user_id uuid, rank int, mu_before double precision,
           mu_after double precision, sigma_after double precision, performance double precision);
    insert into ratings (user_id, dimension, mu, sigma, contests, updated_at)
    select e.user_id, p_dimension, e.mu_after, e.sigma_after, 1, p_now
      from jsonb_to_recordset(p_events) as e(user_id uuid, mu_after double precision, sigma_after double precision)
    on conflict (user_id, dimension) do update
        set mu = excluded.mu, sigma = excluded.sigma, contests = ratings.contests + 1, updated_at = excluded.updated_at;
    insert into contest_ratings (contest_id, org_id, dimension, status, participants, parameters_version, created_at)
    values (p_contest, v_org, p_dimension, p_status, v_count, p_parameters_version, p_now);
end
$$;

revoke all on function rating_begin(text), rating_priors(uuid[], text),
    rating_apply(uuid, text, text, int, jsonb, timestamptz) from public;
grant execute on function rating_begin(text), rating_priors(uuid[], text),
    rating_apply(uuid, text, text, int, jsonb, timestamptz) to aura_worker;
