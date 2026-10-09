# Decision: reports state what is unknown instead of guessing

## Summary

**Status:** Accepted
**Date:** 2026-09-30
**Scope:** all capabilities that present ordering, conflict, or diagnostic results to the user
**Applies to:** `load-order-edit`, `conflict-replay`, `shadowing-enumeration`, `log-pairing`, `game-setup`

**Decision:** We will never guess where the game itself does not decide. Ties are shown unranked, unattributed rows are stated as unattributed, approximate attributions are labeled approximate, and undecidable criteria are named rather than gated on.

**Trade-offs:**

- Accepted: the user always sees the same uncertainty the tool sees — no false confidence
- Accepted: one doctrine across views, replay, shadowing, logs, and setup verdicts
- Cost: some rows say "unknown" where a guess would look more helpful

## Context

The game resolves same-LoadOrder ties arbitrarily, leaves many actions
without declared order, and logs errors with no file hint. Every layer of
the toolkit — the load-order view, the replay, shadowing enumeration, log
pairing, setup verdicts — meets inputs where no correct answer exists. A
guess at any one layer would read as a measured fact at the next.

## Options Considered

### Best-effort ranking everywhere

- Pros: every row has an answer; no "unknown" wording to explain
- Cons: a heuristic winner is indistinguishable from a measured one, so users act on invented certainty
- Rejected because: it hides uncertainty and recreates the confusion being removed

### Honest unknown, labeled per cause

- Pros: ties unranked, unattributed stated, approximate labeled, undecidable named — each cause visible and actionable in its own way
- Cons: the UI must carry "unknown" states instead of plain lists
- Rejected because: n/a — chosen

## Consequences

The load-order editor never orders actions inside a tie and never gates
editing on undecidable criteria. Shadowing reports undefined paths with
reasons instead of ranking claimants. Log pairing marks bracketed
attributions approximate and offers unattributed rows plainly. Setup
verdicts built on asserted options say assumed, never measured.

## Change

Decided during openspec change `load-order-edit`, archived 2026-09-30;
restated here as the cross-capability doctrine its later dependents follow.
