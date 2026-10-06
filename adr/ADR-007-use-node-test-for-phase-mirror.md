# Decision: mirror phase scripts with the Node standard-library test runner

## Summary

**Status:** Accepted
**Date:** 2026-10-06
**Scope:** all capabilities that gain a runnable test mirror of a phase script
**Applies to:** `load-order-edit`, `conflict-replay`, `shadowing-enumeration`, `game-setup`, `log-pairing`
**Change:** `pilot-node-test-phase6`

**Decision:** We will mirror phase scripts with the Node standard-library runner (`node:test` + `node:assert`), CommonJS, zero new dependencies — not Vitest — as the default for every wave unless a wave proves it needs what only Vitest provides.

**Trade-offs:**

- Accepted: filtered single-test runs (`--test-name-pattern`) with no install and no build step.
- Accepted: same single-process semantics as `node src/phaseX.js`, so `node:sqlite` and Temp-path behavior cannot diverge behind a transform layer.
- Cost: no watch UI, no built-in coverage report; added later only on demonstrated need.

## Context

The toolkit is Node 24, CommonJS, no build step; every phase script runs as `node src/phaseX.js` and several canonicalise Temp via `fs.realpathSync.native` after an 8.3 short-name incident that blocked a release (a runner TEMP like `C:\Users\RUNNER~1\...` compares unequal to the long form the database holds). The release gate measured ~33s with the load-order and selfcheck phases dominating on process startup rather than assertion logic, so the goal is a faster dev loop per behavior, not a faster gate.

## Options Considered

### Vitest now

- Pros: watch mode, pretty reporter, built-in coverage, familiar `describe/it/expect`.
- Cons: adds a transform plus worker-thread pooling on top of scripts that depend on single-process `node:sqlite` and canonicalised Temp paths; a silent behavior fork is possible with no product benefit in a sub-second pilot.
- Rejected because: cost is paid on every wave while the benefit (watch/coverage) has no demonstrated need yet.

### node:test + node:assert

- Pros: ships with Node 22/24, zero dependencies, stays CommonJS, `--test-name-pattern` filtering covers the dev-loop goal directly.
- Cons: plainer reporter, no watch/coverage out of the box.
- Rejected because: n/a — chosen. If a later wave demonstrates a Vitest-only need, that wave files a superseding decision instead of drifting.

### Keep raw `node src/phaseX.js` only, no runner at all

- Pros: zero files added.
- Cons: no filtered runs; every behavior edit re-pays the full file cost, which is the problem this decision exists to solve.
- Rejected because: it preserves the dev-loop cost the pilot is meant to remove.

## Consequences

Later waves inherit the default — mirror with stdlib, keep the old script green (dual-run), cut over one `package.json` line per file only after 1:1 cover. If the team later wants Vitest features, each wave pays a second migration. Follow-up trigger: a wave that needs watch or coverage files a superseding decision instead of drifting. (Note: this Node's `--test` rejects the `-t` shorthand; the canonical filter flag is `--test-name-pattern`.)

## Change

Implemented by openspec change `pilot-node-test-phase6`, archived 2026-10-06.
