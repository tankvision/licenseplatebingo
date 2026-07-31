# Plate Hunt

A PWA for spotting license plates from every US state on multi-day road trips.
Live on GitHub Pages. Built over a long design conversation — this file carries
the decisions and the reasoning, which the code can't tell you.

## Hard constraints

- **Single self-contained `index.html`.** No build step, no bundler, no npm, no
  framework. All CSS and JS inline. Do not introduce a toolchain.
- **The owner works from an iPhone.** He edits and deploys through the GitHub
  web UI. Any setup step should be copy-paste, never "run this command" or
  "edit line 412 of index.html."
- `index.html` is ~58KB and safe to read straight through. It used to carry a
  163KB `GEO` blob of Albers projection paths for the map; the map is gone and
  so is the blob. If you only need one area, the landmarks are: `store` /
  `readJSON` (persistence), `TIER`, `STATES`, `OPTIONAL`, `INDEX` (data model),
  `ACH` / `achProgress` / `unlockCheck` (achievements), `totals` (scoring),
  `renderProgress` (the states bar), `SHOUT` / `burn` (celebrations),
  `syncDeck` (sticky header), `buildShare` (share text), `SB_URL` / `rpc` /
  `queue` / `flush` / `reconcile` (group play sync), `renderGame` / `phase`
  (group play UI).

## Deploy ritual — the one thing that will bite you

`sw.js` caches the app shell. It serves stale code forever unless its version
string changes:

```js
const VERSION = 'lpb-YYYY-MM-DD<letter>';   // e.g. lpb-2026-07-29a
```

**Bump that string on every change to `index.html`.** Then upload both files.
Forgetting this looks exactly like "the deploy didn't work." An auto-reload
handler in `index.html` refreshes the page once when the new worker activates.

GitHub Pages notes: source is **Deploy from a branch → main → /(root)**. Do not
switch to the GitHub Actions source — it caused repeated startup failures.
All paths are relative (`./`) so the app works from a repo subpath.

## Gameplay model

- 50 states + D.C. — **51 entries** in `STATES`. Each sits in a rarity tier
  worth **1 / 2 / 5 / 10** points. Tiers are calibrated for the DC-Maryland
  corridor: MD, VA, DC, PA are 1pt; AK, HI, ID, MT, ND, SD, WY are 10pt.
  Perfect states board = 214 pts.
- Three optional groups (Territories, Canadian Provinces, Special Plates).
  **Always on. There is no switch.** They used to be per-player toggles, which
  is the only reason group play ever needed a locked ruleset. Making them
  constant means any two scores are comparable by construction. `live()` is
  therefore just `!!INDEX[c]` — every known code counts, always. The board is
  **73 plates** (`BOARD_SIZE`).
- **Progress and score measure different things, on purpose.** The hero bar in
  the deck counts **states only** — 51 plates, 214 pts, all genuinely findable.
  The optional groups hold ~310 pts on seven plates nobody will realistically
  see on a US road trip (four island territories, three far-north Canadian
  ones), so counting them would cap the bar at 62% forever. They stay in the
  score as pure bonus. **Progress means states; score means everything.**
  The `any:` achievements (`start`, `half`) count states for the same reason —
  as "any plate" they fired at 36% of the board and contradicted the bar.
- **Points work two different ways — this is the easiest thing to get wrong.**
  For the states group, points come from the tier. For the three optional
  groups, **each item carries its own point value** (Guam 40, Ontario 10,
  GOV 3) and the tier drives only color and label. `INDEX[code].pts` resolves
  both and is the single source of truth: scoring code must read it, never
  recompute from `TIER[tier].pts`. Achievements that say "tier" (`untch`)
  deliberately scan `STATES` only, so Guam can't count toward the legendary
  sweep.
- **13 achievements** worth 112 bonus points total — regional sweeps, pattern
  sets, and milestones. Always visible with live progress; a hidden achievement
  does nothing for the player who's behind. Each has an **emoji badge** (`e:`),
  dimmed and desaturated while locked and lit when earned — the console
  "locked silhouette" idiom, and emoji are the only way to get badge art
  without fetching an asset. `unlockCheck()` diffs against `earnedIds` and
  fires an **"Achievement unlocked" banner**, deliberately styled unlike the
  plate callout and delayed ~900ms behind it so the two never read as one
  event. `earnedIds` is seeded from the saved board at load, so nothing fires
  on app start. The banner shows for **4200ms**, and `unlockCheck()` queues
  simultaneous unlocks **4700ms** apart — that gap must stay larger than the
  visible time plus the 340ms out-animation or two banners overlap.
- **Achievements live in their own `<section id="achv">` after the plate
  groups**, not inside `#groups`. They used to sit between "States & D.C." and
  "Territories", so scrolling the hunt list ran you through an unrelated
  section. The block keeps `.grouphead` / `data-g="ach"` / `.body` /
  `data-body="ach"` so the `opened` set, the body-level click handler and the
  `aria-expanded` sync work on it unchanged — only position and styling are
  new. The banner carries a teaser row of all 13 badges (`data-strip="ach"`),
  locked ones dimmed. Still collapsible, still closed by default: a
  destination, not the main event.
- **The section keydown handler is bound to `document.body`, not `#groups`.**
  Scoping it to `#groups` silently drops keyboard access to the achievements
  banner now that it lives outside that element.
- **Known imbalance, left alone deliberately.** Optional plates average 27 pts
  against a state's 4.2, so one lucky Yukon can out-earn a week of hunting; and
  52% of the achievement bonus hinges on the 7 legendary states (missing
  Montana alone costs 60). Both are real. Rebalancing waits for evidence from
  an actual trip. Note it is **not free later**: `spots.pts` is frozen at spot
  time and `add_spot` is `on conflict do nothing`, so old rows keep old values
  and would need a migration.
- Each spot stores a timestamp. `claimed` is a `Map` of code → timestamp, with a
  backward-compatible reader for an older array format. Don't break that reader.

## Local storage — the whole save file

All read through `store` / `readJSON`; the first four are written by `save()`,
the group-play keys by `saveGame()` / `saveOutbox()`.

| Key | Holds |
| --- | --- |
| `lpb.claimed` | The board. Object of `code → timestamp`. |
| `lpb.open` | Array of expanded section ids. |
| `lpb.sort` | `'az'` or `'pts'`. Plain string, not JSON. |
| `lpb.nudged` | `'1'` once the iOS install tip is dismissed. |
| `lpb.game` | Current game `{id,name,starts_at,ends_at,ruleset}`, or empty. |
| `lpb.entry` | This device's entry `{id,secret,name,game_id}`. The secret is the only proof of write access — losing it means losing that board. |
| `lpb.outbox` | Spots waiting for a signal. |
| `lpb.synced` | Codes the server has confirmed, so `reconcile()` knows what's missing. |
| `lpb.board` | Last scoreboard fetched, shown when offline. |

Devices from before the always-on change still have a stale `lpb.groups` key.
Nothing reads it any more. Leave it — deleting it buys nothing and a cleanup
pass is one more thing that can throw before the UI renders.

`lpb.claimed` **writes** as an object but **reads** either an object or the
legacy array of bare codes (which loads with null timestamps). Keep both paths.
Every read is guarded — corrupt or half-written data falls back to defaults
rather than throwing before the UI renders, because a parse error here used to
mean a blank screen with no way back except clearing site data.

## UI decisions and why

- **There is no map. It was removed on purpose — do not add it back.** It was
  display-only, ate about a third of the phone viewport permanently, was too
  small at phone size to read a single state, and made the sticky deck tall
  enough to fight the keyboard in the group-play form. Its space went to the
  two things actually looked at: the score and the shared scoreboard.
  **Accepted loss:** the map was the only sense of *where* the unfound rare
  plates are — "the empty Mountain West glows faintly red". Rarity survives as
  row colour and points; the geography does not. That was the trade.
  (The app icons still depict the map. They are the home-screen identity and
  are unaffected by what the page renders. Leave them.)
- **The score is the identity now.** The deck is wordmark, a display-size
  points figure, the spotted count, and the states progress bar — all of which
  shrink on scroll via the existing `.scrolled` class.
- **Rarity is visible before you find something.** Unfound plates are tinted by
  tier in the list, and the group headers say how many points are still out.
- **Celebration scales with rarity** so it doesn't go stale: commons get the
  score-figure pulse and the row tick only, uncommon a name pop, rare adds a
  headlight flare, legendary blacks out **the whole screen** and burns the name
  white. That last one replaced a map dim; the stage got bigger, the idea did
  not change. Legendary fires ~7 times a game — that scarcity is the point.
  Don't level this up for commons.
- The callout is a **fixed overlay** anchored below the deck, so it stays on
  screen when the user is scrolled down in the list.
- **Undo** appears for ~4s after any spot. Mis-taps in a moving car are the
  main failure mode.
- Found plates **leave the hunt list** after a 400ms hold, then collapse and
  slide out. The delay is deliberate anti-mis-tap: nothing reflows under a
  thumb that's still moving.
- Header is a **slim wordmark**, not the original green highway sign. The sign
  competed with the content below it and lost.

## Deliberately rejected — do not re-suggest

- Photo capture / anti-cheat
- Escalating point multipliers for unfound plates, and first-finder bonuses
  (both exploitable with separate boards: sit on a plate, cash in later)
- One shared synced board with exclusive first-spotter claims
- The map, in any form — including a hide/show toggle, a collapsed version, or
  a smaller one. This was reconsidered once, on a phone, and the answer was to
  delete it rather than shrink it.
- Per-player switches for the optional groups, and per-game rulesets
- Grouping the Spotted list by day
- Screen Wake Lock and regional point re-weighting (deferred, not dead)
- Confetti (replaced by the headlight flare — it fits the road vocabulary)
- `navigator.vibrate()` — unsupported in iOS Safari

## Group play (built, Supabase)

Live. Project `bejgcgrbdrnuvwvcqrvz`; URL and publishable key are literals near
`SB_URL` in `index.html`. Schema lives in `supabase/schema.sql` — edit that file
and re-run it in the dashboard's SQL editor, don't hand-change the database.

**The rules it was built to:**

- **Boards stay separate.** Everyone can spot the same plate independently.
  A "game" is a container that links boards and shows a shared scoreboard.
- A game has a **name, start date, end date**. Before start it's a lobby; after
  end, boards freeze and the scoreboard finalizes into a recap.
- An **entry** is either one player or a team. A team is just an entry with
  several devices writing to one board — do not sum individual boards.
- **Everyone plays the same 73-plate board.** There is no ruleset to choose.
  An earlier design locked a per-game ruleset at creation, because optional
  groups were per-player switches and scores otherwise wouldn't compare.
  Removing the switches removed the problem, and with it `applyRuleset()` and
  the "ruleset is locked" toast. **The `ruleset` column stays in the database
  and `create_game` is still sent every group id** — that costs nothing, avoids
  a migration, and leaves the door open if per-game rulesets ever return.
  Nothing reads it, so a player mid-game with an old partial ruleset simply
  gets the full board.
- Scoreboard shows **totals only** — not who found what.
- **A compact strip inside `.deck` keeps the standings on screen while you
  hunt.** It is the exact mirror of `.prog`: zero-height at the top of the
  page, revealed once `body.scrolled` is set, so the deck's height barely
  changes and the collapse guard has nothing new to fight. Shows leader + you,
  or you + the runner-up when you're leading. Rendered from the cached
  `board.rows`, so it survives a dead zone; absent in solo play and on the
  create/join form. **`setMini()` only re-runs `measureDeck()` when the strip
  appears or disappears** — `renderGame()` fires on every flush, every board
  refresh and the 60s heartbeat, and `measureDeck()` forces a synchronous
  layout.
- One exception agreed to: a **recent-activity line** ("Ellie spotted Montana ·
  4m ago"). It's what makes the scoreboard feel live.
- Joining is by link. The share text already carries the URL.

**How it actually works, and why:**

- **No accounts.** A game is a random id in a link. Each entry gets a secret on
  join, held in `lpb.entry`. Anyone with the link can read the game; only the
  secret-holder can write to that entry's board.
- **Nothing writes to tables directly.** RLS denies all writes; every mutation
  is a `security definer` function that checks the secret server-side. That is
  what makes the secret enforceable rather than decorative. Reads are open,
  because Realtime can only deliver rows a subscriber may select.
- **`entry_secrets` is its own table with no read policy.** `entries` has to be
  world-readable for the live scoreboard, so a secret must never sit on it.
- **The local board stays authoritative.** Spots go to an outbox and flush when
  there's a signal; the scoreboard falls back to `lpb.board` rather than an
  error. You will be in dead zones exactly where the 10-pointers are.
- **`reconcile()` is the safety net.** It re-queues anything `lpb.synced`
  doesn't confirm, every 60s. `add_spot` is idempotent, so re-sending is free.
  This is what rescues spots made during the lobby (the server refuses those)
  and anything lost to a blip — without any special-case handling.
- **A refused write is not a failed write.** No-signal retries forever; a server
  refusal is dropped from the outbox immediately so it cannot block the queue,
  and `reconcile()` brings it back later if it still matters. An earlier version
  deadlocked the whole queue on one bad item.
- **Supabase is optional at runtime.** Every call is plain `fetch`; the CDN
  client is used only for the live push. If it fails to load, the 60s poll
  covers it and solo play is untouched. Keep it that way.
- Entry names come from other people — **escape them** (`esc()`) everywhere.
- The publishable key belongs in client code. A `service_role` key never does.

**Free tier:** the project pauses after 7 days with no requests. Restore from
the dashboard, or let the scheduled keep-alive workflow ping it. That workflow
is unrelated to the Pages source setting above — Pages stays on "Deploy from a
branch"; do not delete the workflow thinking it caused the old build failures.

## Known-good behaviors worth not breaking

- **Scroll collapse guard.** Collapsing the sticky deck shortens the page. On a
  short page that caused an infinite flicker loop: collapse → page shrinks →
  browser snaps to top → expands → repeat. `syncDeck()` measures how much the
  deck shrinks and only collapses when there'll still be scroll room afterward.
  Re-measured on resize and whenever a section opens or closes.
- **That guard needs hysteresis, and it now has it.** It takes >96px of room to
  collapse but only <24px to expand again. With one shared threshold the deck
  flips twice while a spotted row animates out — the page height crosses the
  line, the scroll clamp moves you, and the rule reverses. Two asymmetric
  numbers, not one; don't "simplify" them back together.
- **`holdDeck(ms)` freezes the deck through anything that animates the page
  height** — a spotted row leaving (900ms), a field losing focus (140ms).
  Cheaper and more honest than trying to make `syncDeck()` correct mid-flight.
- **Never animate layout properties inside the deck.** It is `position:sticky`,
  so a transitioning `font-size` reflows it every frame for 300ms and iOS
  renders that as judder. The score figure snaps between sizes on purpose.
- **The score figures reserve their digits (`min-width` in `ch`) and pulse from
  `transform-origin:left center`.** Both exist because the header visibly
  twitched on every tap once the points figure grew to 46px: a centred 1.2×
  scale throws big type around, and 9→10 widening the number shoved the
  spotted count sideways. Scale multipliers here are tuned to the font size —
  re-check them if that size changes.
- **The deck freezes while a field has focus.** A focused input makes iOS
  scroll the page, which re-triggers that same loop — and this time it fights
  the keyboard, which is how it showed up: typing a game name made the page
  bounce. `focusin` sets `deckLocked` and pins the deck compact, `focusout`
  hands off to `holdDeck(140)`, and `syncDeck()` returns early while locked.
  Fixed at the root; do not "solve" this again by tuning the thresholds.
- **`.gform input` must keep `appearance:none` and `min-width:0`.** iOS ignores
  an author width on `input[type=date]` otherwise, and the date fields spill
  out of the card. `box-sizing:border-box` is already global and is *not* the
  fix here.
- **localStorage has a try/catch fallback** to an in-memory object, because
  sandboxed preview iframes block it.
- Fonts are cached by the service worker so a dead zone doesn't strip the
  typography.
- The share text is built to stay SMS-friendly (~220 chars) and ends with the
  app URL, so sharing a score is also the invite.
