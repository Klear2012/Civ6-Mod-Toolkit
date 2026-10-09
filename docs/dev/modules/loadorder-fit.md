# Module `loadorder-fit.js` — block-move fit geometry

What it is: read-only geometry behind the load order editor — which values one
mod's actions move to, and what that move would disturb. Who calls it:
`src/loadorder.js` (facade re-export; DB helpers arrive via `initFit`).
Constants and `cleanValue` come from `loadorder-store.md` (their single
owner); `normId`/`MISSPELLINGS` come from leaf modules, so the require graph
stays acyclic (see `tests.md`).

## Reference (exported surface, grouped)

| Group | Functions | Role |
|---|---|---|
| Setup | `initFit` | Injects DB helpers once; called by the facade |
| Shape | `describeBlock`, `occupiedOf` | One mod's movable block (undeclared counted, never moved); values taken by others |
| Targets | `resolveBase`, `fitMapping` | Anchor/gap targets to base values; offset-preserving mapping |
| Proposal | `proposeBlock`, `buildEvenSpacing`, `buildOverflow`, `buildManual` | Fit maps; the three no-fit paths, never an invented ordering |
| Warnings | `collectWarnings` | Honest warnings (ties, drift, sentinel) — never gates |

## How-to: propose a block move

1. Describe the block (`describeBlock`).
2. Resolve the target (`resolveBase` — anchor or free band).
3. Check fit (`occupiedOf`); on no-fit, surface the three paths.
4. Apply via `src/loadorder.js` — never from here.

## What it does not do

Nothing here writes. No database, no store, no backup — builders are pure over
one mod plus profile bands. Undeclared actions count only and are never moved
by any builder.

## Tests

Covered by `tests/loadorder.test.js` (run: `node --test
tests/loadorder.test.js`). Acyclicity enforced by `tests/arch.test.js`.
