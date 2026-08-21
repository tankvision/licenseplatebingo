-- ═══════════════════════════════════════════════════════════════════════
--  Plate Hunt — schema self-test
--
--  Paste this whole file into the Supabase dashboard → SQL Editor → Run,
--  AFTER running schema.sql. It creates three throwaway games, exercises the
--  real functions against the real constraints, prints a pass/fail table, and
--  then ROLLS BACK — nothing is left behind.
--
--  That last part matters: the schema deliberately has no delete_game (it
--  would be a write surface anyone with a link could reach), so testing
--  against live data would strand a junk game in every scoreboard forever.
--
--  Every row should read ok = true.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create temp table vres(n int, check_name text, ok boolean, detail text);

do $v$
declare
  r json;
  g_live  text; e_live  uuid; s_live  text;
  g_grace text; e_grace uuid; s_grace text;
  g_past  text; e_past  uuid; s_past  text;
  g_lobby text; e_lobby uuid; s_lobby text;
  ts timestamptz; cnt int; i int := 0;
begin
  -- live: started yesterday, ends tomorrow
  r := create_game('VERIFY live',  now() - interval '1 day',  now() + interval '1 day',  '[]'::jsonb, 'Tester');
  g_live  := r->>'game_id'; e_live  := (r->>'entry_id')::uuid; s_live  := r->>'secret';
  -- inside the grace: ended 10 minutes ago (game_grace() is 1 hour)
  r := create_game('VERIFY grace', now() - interval '2 days', now() - interval '10 minutes','[]'::jsonb,'Tester');
  g_grace := r->>'game_id'; e_grace := (r->>'entry_id')::uuid; s_grace := r->>'secret';
  -- past the grace: ended 2 hours ago
  r := create_game('VERIFY past',  now() - interval '3 days', now() - interval '2 hours',  '[]'::jsonb,'Tester');
  g_past  := r->>'game_id'; e_past  := (r->>'entry_id')::uuid; s_past  := r->>'secret';
  -- lobby: hasn't started yet
  r := create_game('VERIFY lobby', now() + interval '1 day',  now() + interval '2 days',  '[]'::jsonb,'Tester');
  g_lobby := r->>'game_id'; e_lobby := (r->>'entry_id')::uuid; s_lobby := r->>'secret';

  ---------------------------------------------------------------- grace window
  i := i+1;
  begin
    perform add_spot(e_grace, s_grace, 'MT', 10, now() - interval '1 day');
    insert into vres values(i,'spot MADE inside the window survives a late flush', true, 'accepted');
  exception when others then
    insert into vres values(i,'spot MADE inside the window survives a late flush', false, SQLERRM);
  end;

  i := i+1;
  begin
    perform add_spot(e_grace, s_grace, 'WY', 10, now() - interval '5 minutes');
    insert into vres values(i,'spot made AFTER the deadline is refused', false, 'accepted — should have been refused');
  exception when others then
    insert into vres values(i,'spot made AFTER the deadline is refused', true, SQLERRM);
  end;

  i := i+1;
  begin
    perform remove_spot(e_grace, s_grace, 'MT');
    insert into vres values(i,'undo still works inside the grace', true, 'accepted');
  exception when others then
    insert into vres values(i,'undo still works inside the grace', false, SQLERRM);
  end;

  i := i+1;
  begin
    perform set_bonus(e_grace, s_grace, 15);
    insert into vres values(i,'achievements can follow a late spot', true, 'accepted');
  exception when others then
    insert into vres values(i,'achievements can follow a late spot', false, SQLERRM);
  end;

  ------------------------------------------------------------ past the grace
  i := i+1;
  begin
    perform add_spot(e_past, s_past, 'MT', 10, now() - interval '3 days');
    insert into vres values(i,'past the grace, even an in-window spot is refused', false, 'accepted — should have been refused');
  exception when others then
    insert into vres values(i,'past the grace, even an in-window spot is refused', true, SQLERRM);
  end;

  i := i+1;
  begin
    perform set_bonus(e_past, s_past, 15);
    insert into vres values(i,'past the grace, the bonus is frozen too', false, 'accepted — should have been refused');
  exception when others then
    insert into vres values(i,'past the grace, the bonus is frozen too', true, SQLERRM);
  end;

  i := i+1;
  begin
    perform join_game(g_past, 'Latecomer');
    insert into vres values(i,'nobody can join a finished game', false, 'accepted — should have been refused');
  exception when others then
    insert into vres values(i,'nobody can join a finished game', true, SQLERRM);
  end;

  --------------------------------------------------------------- the clamp
  -- A phone clock running fast must not park a spot at the top of
  -- recent_activity forever. Note this is about the STORED value only: the
  -- clamp never changes whether a spot is accepted, because least() only
  -- lowers toward now() and the deadline check runs only once now() is
  -- already past ends_at.
  i := i+1;
  begin
    perform add_spot(e_live, s_live, 'ID', 10, now() + interval '400 days');
    select spotted_at into ts from spots where entry_id = e_live and code = 'ID';
    if ts <= now() then
      insert into vres values(i,'a future timestamp is clamped to now()', true, 'stored '||ts);
    else
      insert into vres values(i,'a future timestamp is clamped to now()', false, 'stored '||ts);
    end if;
  exception when others then
    insert into vres values(i,'a future timestamp is clamped to now()', false, SQLERRM);
  end;

  ------------------------------------------------------- the lobby rescue
  -- The start check is ARRIVAL-based on purpose. A spot made before the game
  -- began is refused at the time and re-sent by reconcile() once it starts;
  -- judging it by its own timestamp would refuse it forever.
  i := i+1;
  begin
    perform add_spot(e_live, s_live, 'AK', 10, now() - interval '3 days');
    insert into vres values(i,'a pre-start spot still lands once the game is live', true, 'accepted');
  exception when others then
    insert into vres values(i,'a pre-start spot still lands once the game is live', false, SQLERRM);
  end;

  i := i+1;
  begin
    perform add_spot(e_lobby, s_lobby, 'MT', 10, now());
    insert into vres values(i,'but a lobby game refuses it on arrival', false, 'accepted — should have been refused');
  exception when others then
    insert into vres values(i,'but a lobby game refuses it on arrival', true, SQLERRM);
  end;

  --------------------------------------------------------- the drill-in read
  i := i+1;
  begin
    select count(*) into cnt from entry_spots(e_live);
    if cnt = 2 then
      insert into vres values(i,'entry_spots returns that entry''s plates', true, cnt||' rows');
    else
      insert into vres values(i,'entry_spots returns that entry''s plates', false, 'expected 2, got '||cnt);
    end if;
  exception when others then
    insert into vres values(i,'entry_spots returns that entry''s plates', false, SQLERRM);
  end;

  i := i+1;
  begin
    select count(*) into cnt from entry_spots(e_grace);
    if cnt = 0 then
      insert into vres values(i,'and does not leak another entry''s', true, '0 rows');
    else
      insert into vres values(i,'and does not leak another entry''s', false, 'expected 0, got '||cnt);
    end if;
  exception when others then
    insert into vres values(i,'and does not leak another entry''s', false, SQLERRM);
  end;

  ------------------------------------------------------------- still-live path
  i := i+1;
  begin
    perform add_spot(e_live, s_live, 'HI', 10, now());
    insert into vres values(i,'a live game is unaffected by any of this', true, 'accepted');
  exception when others then
    insert into vres values(i,'a live game is unaffected by any of this', false, SQLERRM);
  end;

  i := i+1;
  begin
    perform add_spot(e_live, 'wrong-secret', 'NV', 5, now());
    insert into vres values(i,'a bad secret is still refused', false, 'accepted — should have been refused');
  exception when others then
    insert into vres values(i,'a bad secret is still refused', true, SQLERRM);
  end;
end $v$;

select n, check_name, ok, detail from vres order by n;

-- everything above is undone; the four VERIFY games never existed
rollback;
