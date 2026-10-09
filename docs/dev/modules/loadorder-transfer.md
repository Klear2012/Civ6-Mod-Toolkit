# Module `loadorder-transfer.js` — override set import/export

What it is: import/export of the global override set. Who calls it:
`src/server.js` (two thin handlers plus two `ROUTES` rows — see `routes.md`).
Placement: the store owns `VERSION`/keys/primitives and requires only leaves,
so DB-bound `resolveAction` lives here; neither side requires back, so the
graph stays acyclic. See `adr/ADR-013-module-responsibility-and-test-placement.md`.

## Reference (exported surface, grouped)

| Group | Functions | Role |
|---|---|---|
| Export | `exportOverrides` | Store content as read, verbatim, in canonical sorted shaping (byte-identical roundtrip); read-only, works while Civ6 runs |
| Import | `importOverrides` | Upload → validate per-entry → replace-with-backup under the game guard → skipped-entries report |
| Cap | `countUploadEntries` | Leaf-entry count for the pre-guard size cap |

## How-to: move a set to another install

1. Export here (downloads the set as a file).
2. Import the file there — the current set is kept as a same-directory backup
   first, and entries that match nothing here are listed afterwards, not added.
3. Re-apply from the overrides page (import writes the store file only).

## What it does not do

Not a merge: import replaces the whole set (loud and reversible, never
silent). Not per-profile: the set is global (see
`adr/ADR-003-global-order-profile-filter.md`). Never touches the game database
on import — re-application happens via the existing sync/apply paths. Foreign
formats are refused, not converted.

## Tests

Covered by `tests/loadorder.test.js`, Tests 20–21 (run: `node --test
tests/loadorder.test.js`). Acyclicity enforced by `tests/arch.test.js`.
