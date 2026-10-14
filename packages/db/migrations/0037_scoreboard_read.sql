-- Reading and announcing scoreboards (Stage 5, slice 6).
--   * aura_app may read the rendered board; the policy from 0036 decides whose: whoever can see the contest
--     reads its public board, the host's owners and admins also read the final one;
--   * store_contest_scoreboard now announces a changed board with NOTIFY, carrying only the contest, the
--     view, the version and the etag (never the board), so API instances can wake their open streams. A
--     lost notification costs only latency: a client's next read, or its reconnect, sees the truth.

grant select (contest_id, view, version, etag, body, updated_at) on contest_scoreboards to aura_app;

create or replace function store_contest_scoreboard(
    p_contest uuid, p_stamp text, p_now timestamptz,
    p_public_etag text, p_public_body jsonb, p_final_etag text, p_final_body jsonb
) returns boolean
    language plpgsql security definer set search_path = pg_catalog, public as $$
declare
    v_org uuid;
    v_changed boolean := false;
    v_view text;
    v_etag text;
    v_body jsonb;
    v_old text;
    v_version integer;
begin
    select org_id into v_org from contests where id = p_contest;
    if v_org is null then
        raise exception 'no such contest' using errcode = 'P0002';
    end if;
    foreach v_view in array array['public', 'final'] loop
        v_etag := case v_view when 'public' then p_public_etag else p_final_etag end;
        v_body := case v_view when 'public' then p_public_body else p_final_body end;
        select etag into v_old from contest_scoreboards where contest_id = p_contest and view = v_view;
        if v_old is null then
            insert into contest_scoreboards (contest_id, org_id, view, version, etag, stamp, body, updated_at)
            values (p_contest, v_org, v_view, 1, v_etag, p_stamp, v_body, p_now);
            v_version := 1;
        elsif v_old <> v_etag then
            update contest_scoreboards set version = version + 1, etag = v_etag, stamp = p_stamp, body = v_body,
                   updated_at = p_now where contest_id = p_contest and view = v_view
            returning version into v_version;
        else
            update contest_scoreboards set stamp = p_stamp where contest_id = p_contest and view = v_view;
            continue;
        end if;
        v_changed := true;
        perform pg_notify('contest_scoreboard', p_contest::text || ':' || v_view || ':' || v_version::text || ':' || v_etag);
    end loop;
    return v_changed;
end
$$;
