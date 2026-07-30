-- ═══════════════════════════════════════════════════════════════════════
--  Plate Hunt — group play schema
--
--  Paste this whole file into the Supabase dashboard → SQL Editor → Run.
--  It is safe to run more than once.
--
--  Design notes (the "why", so this file matches CLAUDE.md's spirit):
--    * No accounts. A game is a random id in a link; a device holds a secret
--      for its own entry. Everyone who has the link can READ the game.
--    * All writes go through security-definer functions, never direct table
--      writes. That is what makes the per-entry secret enforceable — the
--      check happens on the server where a client cannot skip it.
--    * Secrets live in their own table with no read policy, so the openly
--      readable `entries` table can never leak them.
--    * add_spot is idempotent, so an offline outbox can safely re-send.
-- ═══════════════════════════════════════════════════════════════════════

-- ── tables ─────────────────────────────────────────────────────────────

create table if not exists games (
  id          text        primary key,
  name        text        not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  ruleset     jsonb       not null default '[]'::jsonb,  -- enabled optional groups
  created_at  timestamptz not null default now()
);

create table if not exists entries (
  id          uuid        primary key default gen_random_uuid(),
  game_id     text        not null references games(id) on delete cascade,
  name        text        not null,
  bonus       int         not null default 0,            -- achievement points
  created_at  timestamptz not null default now()
);

-- kept separate from `entries` on purpose: `entries` is world-readable so
-- Realtime can broadcast it, and a secret must never ride along.
create table if not exists entry_secrets (
  entry_id    uuid        primary key references entries(id) on delete cascade,
  secret      text        not null
);

create table if not exists spots (
  entry_id    uuid        not null references entries(id) on delete cascade,
  -- denormalized: Realtime filters can only match columns on the changed row,
  -- so without game_id here there is no way to subscribe to a single game.
  game_id     text        not null references games(id) on delete cascade,
  code        text        not null,
  -- resolved at spot time from INDEX[code].pts, so historical scores survive
  -- any future re-weighting of the rarity tiers.
  pts         int         not null,
  spotted_at  timestamptz not null default now(),
  primary key (entry_id, code)
);

create index if not exists spots_game_idx   on spots(game_id, spotted_at desc);
create index if not exists entries_game_idx on entries(game_id);

-- ── internal helpers ───────────────────────────────────────────────────

-- 32 hex chars (128 bits) from a core function; avoids depending on pgcrypto
-- living in a particular schema.
create or replace function rand_hex()
returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '');
$$;

create or replace function entry_auth(p_entry uuid, p_secret text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_entry is null or coalesce(p_secret,'') = '' then
    raise exception 'missing entry credentials';
  end if;
  if not exists (
    select 1 from entry_secrets
    where entry_id = p_entry and secret = p_secret
  ) then
    raise exception 'bad entry credentials';
  end if;
end $$;

-- ── write API ──────────────────────────────────────────────────────────

create or replace function join_game(p_game text, p_entry_name text)
returns json
language plpgsql security definer set search_path = public, pg_temp as $$
declare g games%rowtype; v_entry uuid; v_secret text; v_name text;
begin
  v_name := nullif(btrim(coalesce(p_entry_name,'')), '');
  if v_name is null then raise exception 'entry name required'; end if;
  if length(v_name) > 40 then raise exception 'entry name too long'; end if;

  select * into g from games where id = p_game;
  if not found      then raise exception 'game not found'; end if;
  if now() > g.ends_at then raise exception 'game has ended'; end if;

  if exists (select 1 from entries where game_id = p_game and lower(name) = lower(v_name))
    then raise exception 'that name is already taken in this game'; end if;

  v_secret := rand_hex();
  insert into entries(game_id, name) values (p_game, v_name) returning id into v_entry;
  insert into entry_secrets(entry_id, secret) values (v_entry, v_secret);

  return json_build_object(
    'game_id', p_game, 'entry_id', v_entry,
    'secret', v_secret, 'name', v_name
  );
end $$;

create or replace function create_game(
  p_name       text,
  p_starts_at  timestamptz,
  p_ends_at    timestamptz,
  p_ruleset    jsonb,
  p_entry_name text
) returns json
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_game text; v_name text; tries int := 0;
begin
  v_name := nullif(btrim(coalesce(p_name,'')), '');
  if v_name is null            then raise exception 'game name required'; end if;
  if length(v_name) > 60       then raise exception 'game name too long'; end if;
  if p_starts_at is null or p_ends_at is null
                               then raise exception 'start and end required'; end if;
  if p_ends_at <= p_starts_at  then raise exception 'end must be after start'; end if;

  -- short, link-friendly id; retry on the (vanishingly unlikely) collision
  loop
    v_game := substr(rand_hex(), 1, 8);
    exit when not exists (select 1 from games where id = v_game);
    tries := tries + 1;
    if tries > 5 then raise exception 'could not allocate a game id'; end if;
  end loop;

  insert into games(id, name, starts_at, ends_at, ruleset)
  values (v_game, v_name, p_starts_at, p_ends_at, coalesce(p_ruleset, '[]'::jsonb));

  return join_game(v_game, p_entry_name);
end $$;

create or replace function add_spot(
  p_entry      uuid,
  p_secret     text,
  p_code       text,
  p_pts        int,
  p_spotted_at timestamptz default now()
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g games%rowtype; v_game text; v_code text;
begin
  perform entry_auth(p_entry, p_secret);

  v_code := upper(btrim(coalesce(p_code,'')));
  if v_code !~ '^[A-Z0-9]{1,8}$' then raise exception 'bad plate code'; end if;
  if p_pts is null or p_pts < 0 or p_pts > 100 then raise exception 'implausible points'; end if;

  select game_id into v_game from entries where id = p_entry;
  select * into g from games where id = v_game;
  if now() < g.starts_at then raise exception 'game has not started'; end if;
  if now() > g.ends_at   then raise exception 'game has ended'; end if;

  -- do nothing on conflict: an offline outbox may re-send the same spot
  insert into spots(entry_id, game_id, code, pts, spotted_at)
  values (p_entry, v_game, v_code, p_pts, coalesce(p_spotted_at, now()))
  on conflict (entry_id, code) do nothing;
end $$;

create or replace function remove_spot(p_entry uuid, p_secret text, p_code text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g games%rowtype; v_game text;
begin
  perform entry_auth(p_entry, p_secret);
  select game_id into v_game from entries where id = p_entry;
  select * into g from games where id = v_game;
  if now() > g.ends_at then raise exception 'game has ended'; end if;

  delete from spots
  where entry_id = p_entry and code = upper(btrim(coalesce(p_code,'')));
end $$;

create or replace function set_bonus(p_entry uuid, p_secret text, p_bonus int)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g games%rowtype; v_game text;
begin
  perform entry_auth(p_entry, p_secret);
  if p_bonus is null or p_bonus < 0 or p_bonus > 500 then
    raise exception 'implausible bonus';
  end if;
  select game_id into v_game from entries where id = p_entry;
  select * into g from games where id = v_game;
  if now() > g.ends_at then raise exception 'game has ended'; end if;

  update entries set bonus = p_bonus where id = p_entry;
end $$;

-- ── read API ───────────────────────────────────────────────────────────

-- totals only, per the spec — never who found what
create or replace function scoreboard(p_game text)
returns table(entry_id uuid, name text, found int, score int)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.id,
         e.name,
         coalesce(count(s.code), 0)::int,
         (coalesce(sum(s.pts), 0) + e.bonus)::int
  from entries e
  left join spots s on s.entry_id = e.id
  where e.game_id = p_game
  group by e.id, e.name, e.bonus
  order by 4 desc, 2 asc;
$$;

-- the one agreed exception to totals-only: "Ellie spotted Montana · 4m ago"
create or replace function recent_activity(p_game text, p_limit int default 10)
returns table(name text, code text, spotted_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.name, s.code, s.spotted_at
  from spots s
  join entries e on e.id = s.entry_id
  where s.game_id = p_game
  order by s.spotted_at desc
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

-- ── access rules ───────────────────────────────────────────────────────

alter table games         enable row level security;
alter table entries       enable row level security;
alter table spots         enable row level security;
alter table entry_secrets enable row level security;

drop policy if exists games_read   on games;
drop policy if exists entries_read on entries;
drop policy if exists spots_read   on spots;

-- Reads are open: you need the game id to find anything, and Realtime can
-- only deliver rows the subscriber is allowed to select.
create policy games_read   on games   for select to anon, authenticated using (true);
create policy entries_read on entries for select to anon, authenticated using (true);
create policy spots_read   on spots   for select to anon, authenticated using (true);

-- entry_secrets deliberately gets NO policy: RLS on with no policy means
-- nobody can read it except the security-definer functions above.

-- No direct writes to anything. Everything goes through the functions.
revoke all on games, entries, spots, entry_secrets from anon, authenticated;
grant select on games, entries, spots to anon, authenticated;

revoke execute on function entry_auth(uuid, text) from public, anon, authenticated;
revoke execute on function rand_hex()             from public, anon, authenticated;

grant execute on function create_game(text, timestamptz, timestamptz, jsonb, text) to anon, authenticated;
grant execute on function join_game(text, text)                                    to anon, authenticated;
grant execute on function add_spot(uuid, text, text, int, timestamptz)             to anon, authenticated;
grant execute on function remove_spot(uuid, text, text)                            to anon, authenticated;
grant execute on function set_bonus(uuid, text, int)                               to anon, authenticated;
grant execute on function scoreboard(text)                                         to anon, authenticated;
grant execute on function recent_activity(text, int)                               to anon, authenticated;

-- ── realtime ───────────────────────────────────────────────────────────
-- Broadcast spot and entry changes so the scoreboard updates live.

do $$
begin
  begin alter publication supabase_realtime add table spots;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table entries; exception when duplicate_object then null; end;
end $$;
