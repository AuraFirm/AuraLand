-- The platform status banner (Stage 5, slice 12): one row an administrator sets and every page shows. It is
-- the first thing to update when something is wrong during a contest (docs/kit: communicate early). One row
-- only, readable by everyone, written only through set_platform_status by a platform administrator.

create table platform_status (
    id smallint primary key constraint platform_status_single check (id = 1),
    level text not null constraint platform_status_level check (level in ('ok', 'degraded', 'outage')),
    message text not null constraint platform_status_message check (char_length(message) <= 280 and message !~ '[[:cntrl:]]'),
    updated_by uuid references users (id),
    updated_at timestamptz not null,
    constraint platform_status_ok_is_quiet check (level <> 'ok' or message = '')
);
create index platform_status_updated_by on platform_status (updated_by);
insert into platform_status (id, level, message, updated_at) values (1, 'ok', '', now());

alter table platform_status enable row level security;
alter table platform_status force row level security;
create policy platform_status_read on platform_status for select to aura_app using (true);
grant select (level, message, updated_at) on platform_status to aura_app;

create function set_platform_status(p_level text, p_message text, p_now timestamptz) returns void
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
    if v_user is null or not exists (select 1 from users where id = v_user and platform_role = 'admin') then
        raise exception 'only platform administrators set the status' using errcode = '42501';
    end if;
    update platform_status set level = p_level, message = p_message, updated_by = v_user, updated_at = p_now where id = 1;
end
$$;
revoke all on function set_platform_status(text, text, timestamptz) from public;
grant execute on function set_platform_status(text, text, timestamptz) to aura_app;
