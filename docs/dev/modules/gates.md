# Module `gates.js` — will-run verdicts for gated actions

What it is: pure functions that decide which load order actions will run in a
profile, and how sure the toolkit is. Who calls it: `src/loadorder.js`
(re-exported through the facade) and `src/loadorder-fit.js` (`MISSPELLINGS`
only). This module owns `DECIDABLE` and `MISSPELLINGS`; everyone else requires
them. See `adr/ADR-004-undefined-honesty.md`.

## Reference (exported surface, grouped)

| Group | Functions | Role |
|---|---|---|
| Vocabulary | `DECIDABLE`, `MISSPELLINGS`, `MAYBE` | Provable criterion types; the two real misspellings (read, never written); the unknown marker (`null`) |
| Author intent | `declaredValueOf` | Correctly spelled row first, else a misspelling, else nothing |
| Reasons | `unreadableWhy`, `setupKeysFor` | Player-readable why for one unreadable condition; assumed-setup keys that satisfy it |
| Verdicts | `isAssumedMatch`, `evalCondition`, `verdictOf` | Per-condition and per-action verdicts — `true`/`false` only where provable |

## How-to: verdict one action

Call `verdictOf(entry, ctx)` — it returns `{ willRun, reason, unknown,
assumed }`. `willRun` is `true` or `false` only where provable, otherwise
`null`; `reason` names what is missing in words a player can check.

## What it does not do

No database, no store, no writes. It never touches `Mods.sqlite`,
`load-order-overrides.json`, or a backup — see `loadorder-store.md` and
`loadorder.md`. It never guesses: an undecidable condition stays undecided
with its reason attached.

## Tests

No dedicated mirror. Exercised end to end through `tests/loadorder.test.js`
(run: `node --test tests/loadorder.test.js`); assumed-setup keys through
`tests/game-setup.test.js`. Shared Temp pattern: `tests/helpers.js`.
