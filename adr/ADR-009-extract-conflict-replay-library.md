# Decision: extract the conflict-replay library for shared require

## Summary

**Status:** Accepted
**Date:** 2026-10-06
**Scope:** `src/phase9-conflict-replay.js` and every `require` of it (`src/server.js:31`)
**Applies to:** `conflict-replay`
**Change:** `wave4-node-test-loadorder-conflict-replay`, archived 2026-10-06.

**Decision:** New `src/conflict-replay.js` holds the entire library (pure move of the library block including `module.exports`); `src/phase9-conflict-replay.js` becomes a thin wrapper (`module.exports = require('./conflict-replay')` plus the unchanged 9-flag dispatch); `src/server.js:31` swaps to the lib. Add alongside first, dual-run proves equivalence, swap only after.

**Trade-offs:**

- Accepted: the wrapper keeps its path, so all `package.json` scripts keep working and its 9-flag behavior stays byte-identical; the only new file is the lib.
- Accepted: product code no longer requires a proof file, and the `--live-lock` locking-boundary code no longer sits inside a file whose shape says test-only.
- Cost: two files to read instead of one wherever replay internals are traced.

## Context

`src/phase9-conflict-replay.js` is two things in one file: a 9-suite proof (`--check` … `--text-tables`, `require.main` dispatch) and the product library `src/server.js:31` requires (16 use sites: log parsing/attribution, `collectStatements`, `createTempCopy`, `replayOrdered`, envelope, differential, calibration). Every prior mirror wave kept its phase script untouched because no product code required it; that is false here, so a mirror-only change would leave product code requiring a proof file. The lib block (`module.exports`) already separates cleanly from the dispatch block, so extraction is a pure move, not a rewrite. One seam detail: the original `module.exports` did not export the `runCheck`/`runFidelity`/`runGates` runners (those suites predate the export discipline and their dispatch calls module-local functions directly), so the lib's export set is the baseline plus those three runners — additive only, no other edit.

## Options Considered

### Thin wrapper re-exporting (chosen)

- Pros: the wrapper keeps its path (all `package.json` scripts keep working) and its 9-flag behavior byte-identical; the only new file is the lib.
- Cons: two files to read instead of one.
- Chosen because: the cutover is one `require` line per consumer with equivalence proven by dual-run (all 9 flags exit 0, after-logs identical modulo volatile TMP lines, export-set equality, `server.js --selfcheck`).

### Wrapper keeps its own copy of the dispatch plus duplicated requires

- Pros: a single file still reads end to end.
- Cons: duplicates the flag table, inviting drift between the two files.
- Rejected because: drift between a proof dispatch and the library it proves defeats the purpose of the split.

### No extraction — mirror requires the phase file directly

- Pros: zero product-code edits.
- Cons: leaves product code coupled to a proof harness and keeps the `--live-lock` locking-boundary code inside a file whose shape says test-only.
- Rejected because: the seam is already clean, and product code requiring a proof file misstates what the file is.

## Consequences

Later waves have no unmirrored proofs left; any future replay change edits `src/conflict-replay.js` with both consumers (`server.js`, wrapper) covered by the same mirror. Cutover stays one `package.json` line per file in a follow-up, after the executed-count gates pass. If a future change needs a different split, that change files a superseding decision instead of drifting.

## Change

Implemented by openspec change `wave4-node-test-loadorder-conflict-replay`, archived 2026-10-06.
