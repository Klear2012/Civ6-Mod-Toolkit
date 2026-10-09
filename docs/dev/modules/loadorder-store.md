# Module `loadorder-store.js` — the overrides file store

What it is: the single place that validates, reads, and writes
`load-order-overrides.json`, plus folding applied values back in. Who calls
it: `src/loadorder.js` (facade re-export), `src/loadorder-transfer.js`
(import/export), `src/loadorder-fit.js` (constants only). This module owns
`VERSION`, `MAX_KEY`, `MIN`/`MAX_VALUE`, `SENTINEL`, and `GUID`; everyone else
requires the owner, never duplicates. See
`adr/ADR-005-action-identity.md`.

## Reference (exported surface, grouped)

| Group | Functions | Role |
|---|---|---|
| Markers | `VERSION`, `SENTINEL`, `GUID`, `MAX_KEY`, `MIN_VALUE`, `MAX_VALUE` | File version; the game's load-last sentinel; mod-id shape; hand-edit bounds |
| Location | `overridesFile` | Where the file lives (overridable for tests) |
| Cleaning | `cleanValue`, `isModId`, `cleanKey`, `cleanModId` | Whole-number values; strict mod-id and key shape |
| Read | `parse`, `view`, `readOverrides`, `readForWrite` | Text to overrides-with-message; unusable-as-a-whole vs one-bad-entry |
| Write | `writeOverrides`, `setOverride`, `clearOverride`, `recordApplied` | Atomic writes via `src/editor.js`; applied values folded back in |

## How-to: persist one override

Call `setOverride(file, modId, key, value)` — it validates, writes atomically,
and returns the re-read store. A corrupt live file fails closed: fix or delete
it by hand, nothing is built on top of it.

## What it does not do

No database reads, no action resolution, no game guard. It never resolves a
key against `Mods.sqlite` (see `loadorder-transfer.md`), never writes the game
database (see `loadorder.md`), and never invents an entry: one bad entry costs
only that entry.

## Tests

Covered by `tests/loadorder.test.js` (run: `node --test
tests/loadorder.test.js`), including the corrupt-file fail-closed path.
Shared Temp pattern: `tests/helpers.js`.
