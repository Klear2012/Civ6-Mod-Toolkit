# Decision: keep conflict builders in server.js (drop the conflict-report split)

## Summary

**Status:** Accepted
**Date:** 2026-10-07
**Scope:** conflict report builders in the local web server entry
**Applies to:** `load-order-edit`, `conflict-replay`
**Change:** `refactor-server-loadorder-split`

**Decision:** We will NOT extract the `gameSetupCatalog`/`gameSetupKnown`
helpers plus the conflict report builders into `src/conflict-report.js`. The
conflict builders stay in `src/server.js`; `src/conflict-report.js` does not
exist.

**Trade-offs:**

- Accepted: `server.js` keeps its conflict block — the review-cost goal is met
  by the five landed splits (selfcheck, gates, fit, store, route table); one
  cohesive block staying put is cheaper than moving the most ADR-sensitive
  code for zero behavior gain.
- Accepted: the selfcheck injected-builder shape stays as-is (see ADR-010);
  the `srvSrc` selfcheck assertion keeps scanning `server.js`
  (+ `server-selfcheck.js`), with no retarget.
- Cost: a future conflict-builder extraction must supersede this decision
  with a new decision file — never edit this file.

## Context

This split was the highest-risk one in the plan: it moved the code under
ADR-001 (disposable-copy replay) and ADR-006 (read-only diagnostics)
boundaries, plus the shared `gameSetupCatalog`/`gameSetupKnown` helpers that
the game-setup routes also require. Against that stood zero behavior gain
(refactoring-hat only) and a program that had already landed five splits.
The owner judged the residual `server.js` conflict block acceptable and
dropped this split deliberately — not by neglect.

## Options Considered

### Drop the split, keep builders in `server.js` (chosen)

- Pros: no ADR-001/006 boundary move; no shared-helper rewire for the
  game-setup routes; no `srvSrc` assertion retarget; five landed splits keep
  all of their value independently.
- Cons: `server.js` stays larger by ~650 lines; the conflict block still
  shares a require path with routing.
- Chosen because: the risk/benefit of moving read-guarded, replay-guarded
  code for a pure restructure did not clear the bar once the other five
  splits had landed.

### Land the split as planned (rejected)

- Pros: smallest final `server.js`; all six responsibilities separated.
- Cons: highest regression surface in the program (read-only +
  disposable-copy boundaries, shared game-setup helpers, selfcheck assertion
  retarget) for no behavior gain; delays the integration gate.
- Rejected because: owner decision — the marginal separation was not worth
  the marginal risk.

## Consequences

`src/conflict-report.js` does not exist; `server.js` keeps the catalog
helpers and conflict builders verbatim. A future change may revive the
extraction only by superseding this decision with a new decision file — this
ADR is immutable after acceptance.

## Change

Implemented by openspec change `refactor-server-loadorder-split`, archived 2026-10-07.
