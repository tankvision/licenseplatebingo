# Tests

Plain Node scripts. No dependencies, no install, no build step — that constraint
covers the app and these respect it too.

```
node tests/all.js        # everything, plus the inline-script syntax check
node tests/dom.js        # one suite on its own
```

`all.js` exits non-zero if anything fails, so it works as a pre-deploy gate.

## Why they live in the repo

They used to live in a scratch directory under `AppData\Local\Temp`. Windows
cleaned it, twice, and each time the whole suite had to be rewritten from
scratch. They belong next to the code they test, versioned with it.

## How they work

Most of these **extract real source out of `index.html`** with `indexOf` slices
and run it through `new module.constructor()._compile()`, with the browser
globals it expects stubbed in. Nothing here reimplements app logic — a
reimplementation would happily keep passing while the shipped code broke.

That does mean the slice anchors are load-bearing. If a harness dies with
`missing <something>`, a function was renamed or moved and the anchor needs
updating — it is not a product failure.

| File | Covers |
| --- | --- |
| `sync3.js` | The outbox against a fake server: flush, retry, refusal handling, `reconcile()`, the deadline and join cutoffs, late-drop reporting. |
| `freeze.js` | `phase()` and the `toggle()` guard — the board must stop accepting taps once a game is over, including un-spotting. |
| `panel.js` | `entryPanel()` / `boardHTML()` — rarity grouping, unknown codes, escaping, and your own row staying inert. |
| `dom.js` | Static structure: every `getElementById` / `data-*` / class selector resolves, plus the invariants past bugs taught us. Also cross-checks `index.html` against `supabase/schema.sql`. |
| `negtest.js` | Reintroduces 18 real regressions and asserts `dom.js` rejects each one. |

## `negtest.js` is the important one

A static check that would also pass on broken code is worse than no check,
because it reads as reassurance. Every guard in `dom.js` has a matching
mutation here that puts the original bug back and proves the guard fires.

This has already earned its keep: a guard written as `/lateDropped/` passed even
with the counting line deleted, because the identifier still appeared elsewhere
in the function. The mutation caught it; the guard is now two checks.

**When you add a guard to `dom.js`, add its mutation here.**

## Server-side tests

Not here — see `supabase/verify.sql`. It runs against the real database inside
`begin; … rollback;`, because the schema deliberately has no `delete_game` and a
test game would otherwise sit in the table forever.

## Missing: `score3.js`, `mini.js`, `deck.js`

Lost to the same temp-directory cleanup and **not yet rewritten**. They covered:

- **`score3.js`** (46 tests) — the data model, `totals()`, and all 13
  achievements, including that `INDEX[code].pts` is the single source of truth
  for points and that `untch` scans `STATES` only.
- **`mini.js`** (21 tests) — `renderMini()`, the pinned leader+you strip, and
  that `setMini()` only re-measures the deck when the strip appears or
  disappears.
- **`deck.js`** (18 tests) — `measureDeck` / `holdDeck` / `syncDeck`: the
  scroll-collapse guard, its 96/24 hysteresis, and the lock.

They were green immediately before they were lost, against the current code.
Worth rewriting when someone next touches scoring, the strip, or the sticky
header — those areas currently have no automated cover.
