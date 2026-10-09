# Decision: action identity is (ComponentType, id, sorted file list) under a GUID mod key

## Summary

**Status:** Accepted
**Date:** 2026-10-06
**Scope:** all capabilities that store per-action choices across sessions
**Applies to:** `load-order-edit`, `conflict-replay`

**Decision:** We will identify a stored action by the key (ComponentType, id, sorted file list) inside its mod, and identify the mod by GUID (`normId`, lowercased and unbraced) — never by database row ids, which the game renumbers on every rescan. No ordinal tiebreak: a wrong ordinal silently moves a neighbor's action, and the residual 0.35% ambiguity is ambiguous to the mods' own authors too.

**Trade-offs:**

- Accepted: stored overrides survive rescans, renames, and author LoadOrder bumps
- Accepted: misidentification fails loud (orphaned/ambiguous) instead of writing to the wrong action
- Cost: 11 of 3176 measured actions (0.35%) cannot be told apart and stay uneditable by key

## Context

Overrides must name one action inside one mod and still match after the
game rescans its database. Row ids (`ModRowId`, `ComponentRowId`) are the
obvious handle and the wrong one: the game renumbers them on every rescan.
The key components were chosen by measuring collisions within a mod across
all 3176 actions in the library: id alone collides 760 times (23.91% —
Civ6's editor leaves `NewAction` placeholders), (id, type) 99 times
(3.12%), (file list, type) 286 times (9.00%, since 8.2% of actions have no
files), and (file list, type, id) 11 times (0.35%). Declared LoadOrder is
deliberately not part of the key: it is the one thing that changes on
exactly the updates an override has to survive.

## Options Considered

### Key by database row ids

- Pros: trivially unique, cheap to compare
- Cons: the game renumbers every row id on rescan, orphaning all stored overrides at once
- Rejected because: persistence across rescans is the whole point of storing the key

### Add an ordinal tiebreak to reach zero collisions

- Pros: unique within a mod by construction, driving the count to zero
- Cons: 48 mods hold 286 actions in 65 groups sharing an identical type and file list (38 with empty file lists, where the ordinal would be the only discriminator) — an author inserting one action renumbers everything after it, and a wrong ordinal does not error, it silently moves a neighbor's action
- Rejected because: a dropped override is noticed immediately; a misdirected write surfaces three sessions later

### Key by (ComponentType, id, sorted file list) under GUID normId

- Pros: measured 0.35% residual; survives rescans, renames, and LoadOrder bumps; failures are loud reports, never silent misdirection
- Cons: the 11 indistinguishable actions cannot be keyed — and neither could their authors tell them apart
- Rejected because: n/a — chosen

## Consequences

Row ids remain the runtime handle only: each session resolves the stored
key to the current row id server-side and reports zero or multiple matches
as orphaned or ambiguous with no write offered. The key parts are
one-line-normalized (whitespace collapsed, backslashes to slashes, files
sorted) so equivalent declarations match.

## Change

Recorded 2026-10-06 from the implemented design in `src/loadorder.js`
(key measurement, ordinal rejection, GUID mod keys); relied upon by
openspec change `load-order-edit`, archived 2026-09-30.
