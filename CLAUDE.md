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
- The big `GEO` object near the top of the script is machine-generated Albers
  USA projection path data (~163KB). Never hand-edit it — and never read
  `index.html` straight through. The file is only ~730 lines, but line 265 is
  that one 163KB line, and reading it whole burns most of an assistant's
  context for nothing. Search for named landmarks instead: `store` / `readJSON`
  (persistence), `TIER`, `STATES`, `OPTIONAL`, `INDEX` (data model), `ACH` /
  `achProgress` (achievements), `totals` (scoring), `SHOUT` / `burn`
  (celebrations), `syncDeck` (sticky header), `buildShare` (share text),
  `SB_URL` / `rpc` / `queue` / `flush` / `reconcile` (group play sync),
  `renderGame` / `phase` (group play UI).

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
- Three optional groups (Territories, Canadian Provinces, Special Plates), all
  **on by default**, each collapsible with its own on/off switch.
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
  does nothing for the player who's behind.
- Each spot stores a timestamp. `claimed` is a `Map` of code → timestamp, with a
  backward-compatible reader for an older array format. Don't break that reader.

## Local storage — the whole save file

All read through `store` / `readJSON`; the first four are written by `save()`,
the group-play keys by `saveGame()` / `saveOutbox()`.

| Key | Holds |
| --- | --- |
| `lpb.claimed` | The board. Object of `code → timestamp`. |
| `lpb.groups` | Array of enabled optional group ids (`terr`, `prov`, `spec`). |
| `lpb.open` | Array of expanded section ids. |
| `lpb.sort` | `'az'` or `'pts'`. Plain string, not JSON. |
| `lpb.nudged` | `'1'` once the iOS install tip is dismissed. |
| `lpb.game` | Current game `{id,name,starts_at,ends_at,ruleset}`, or empty. |
| `lpb.entry` | This device's entry `{id,secret,name,game_id}`. The secret is the only proof of write access — losing it means losing that board. |
| `lpb.outbox` | Spots waiting for a signal. |
| `lpb.synced` | Codes the server has confirmed, so `reconcile()` knows what's missing. |
| `lpb.board` | Last scoreboard fetched, shown when offline. |

`lpb.groups` is **not written while in a game** — the ruleset is locked, and the
solo choices have to survive so they can be restored on leaving.

`lpb.claimed` **writes** as an object but **reads** either an object or the
legacy array of bare codes (which loads with null timestamps). Keep both paths.
Every read is guarded — corrupt or half-written data falls back to defaults
rather than throwing before the UI renders, because a parse error here used to
mean a blank screen with no way back except clearing site data.

## UI decisions and why

- **The map is display-only.** Taps happen in the list. An earlier version used
  a tappable hex grid; it was replaced because 12 columns can't give a 44px tap
  target on a phone.
- **Rarity is visible before you find something.** Unfound states are tinted by
  tier, so the empty Mountain West glows faintly red.
- **Celebration scales with rarity** so it doesn't go stale: commons get a map
  flash only, uncommon a text pop, rare adds a headlight flare, legendary dims
  the whole map to black and burns one state white. Legendary fires ~7 times a
  game — that scarcity is the point. Don't level this up for commons.
- The callout is a **fixed overlay**, not a child of the map, so it stays on
  screen when the user is scrolled down in the list.
- **Undo** appears for ~4s after any spot. Mis-taps in a moving car are the
  main failure mode.
- Found plates **leave the hunt list** after a 400ms hold, then collapse and
  slide out. The delay is deliberate anti-mis-tap: nothing reflows under a
  thumb that's still moving.
- Header is a **slim wordmark**, not the original green highway sign. The map
  is the identity now; the sign competed with it.

## Deliberately rejected — do not re-suggest

- Photo capture / anti-cheat
- Escalating point multipliers for unfound plates, and first-finder bonuses
  (both exploitable with separate boards: sit on a plate, cash in later)
- One shared synced board with exclusive first-spotter claims
- Hide/show toggle for the map
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
- **The ruleset is locked at game creation.** Which optional groups are in play
  must be set once by the creator and applied to everyone, or scores aren't
  comparable. This moves those toggles from personal settings to game settings.
- Scoreboard shows **totals only** — not who found what.
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
- **localStorage has a try/catch fallback** to an in-memory object, because
  sandboxed preview iframes block it.
- Fonts are cached by the service worker so a dead zone doesn't strip the
  typography.
- The share text is built to stay SMS-friendly (~220 chars) and ends with the
  app URL, so sharing a score is also the invite.
