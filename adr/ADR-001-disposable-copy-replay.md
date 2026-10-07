# Decision: conflict replay runs against a disposable copy, never the live game database

## Summary

**Status:** Accepted
**Date:** 2026-10-01
**Scope:** all capabilities that diagnose database-level mod conflicts
**Applies to:** `conflict-replay`, `log-pairing`, `replay-text-tables`

**Decision:** We will replay mods' database writes in load order against a disposable copy of the game database and report winners per contested row and column. The game database is never written.

**Trade-offs:**

- Accepted: diagnosis can never corrupt a working game
- Accepted: replay-vs-game comparison (differential) is well-defined
- Cost: the replay needs its own harness, and harness gaps must be declared rather than silent

## Context

Conflict diagnosis must name, for each contested row and column, which mod
file and statement wins. Running that analysis anywhere near the live
database risks destroying the game state it is meant to protect. At the time,
the project already had a load-order resolver and game-log readers, but no
safe place to execute untrusted mod SQL.

## Options Considered

### Replay against the live game database

- Pros: no harness to build or maintain
- Cons: a replay bug writes garbage into the real game; comparison against Database.log becomes meaningless
- Rejected because: the tool must never be able to break the game it diagnoses

### Replay against a disposable copy

- Pros: failures are contained; replay-vs-game differential is well-defined
- Cons: harness gaps (unreplayable statements) must be tracked and declared
- Rejected because: n/a — chosen

## Consequences

Every replay-adjacent requirement carries the "never the live game DB"
constraint. Harness gaps are declared, never silent. The text-table follow-up
had to separate genuine text errors from the harness's own missing
localization tables — a direct consequence of this decision.

## Change

Implemented by openspec change `conflict-diagnosis`, archived 2026-10-01.
