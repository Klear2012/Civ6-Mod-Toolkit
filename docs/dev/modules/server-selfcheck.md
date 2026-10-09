# Module `server-selfcheck.js` — conflict-diagnosis selfcheck

What it is: the conflict-diagnosis selfcheck over HTTP plus read-only guards,
split out of `src/server.js` with no behavior change. Who calls it:
`src/server.js` (`--selfcheck` entry). Dependencies (server handle, builders)
are injected; leaves are required directly; it never requires the server back.
See `adr/ADR-010-selfcheck-dependency-shape.md`.

## Reference (exported surface, grouped)

| Group | Functions | Role |
|---|---|---|
| Seed | `conflictSelfcheckSeed` | Builds a fake mod library (two mods, gated/missing/bad files) in a scratch dir |
| Run | `runConflictSelfcheck` | Exercises the live report path over HTTP and checks each expectation |

## How-to: run it

Run `npm run phase9-selfcheck` (i.e. `node src/server.js --selfcheck`). It is
product code and part of `npm run check:release`.

## What it does not do

Never touches the live game database: fake databases live in OS temp only
(see `adr/ADR-006-readonly-diagnostics.md`). Never a substitute for the
`tests/` mirrors — it proves the wired-up server path, not each library unit.

## Tests

It *is* a check, not checked code: the release gate runs it
(`phase9-selfcheck` in `npm run check:release`). The replay engine it
exercises is covered by `tests/conflict-replay.test.js`.
