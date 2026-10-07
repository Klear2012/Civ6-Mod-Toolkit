# Decision: load order is global, a profile is a filter

## Summary

**Status:** Accepted
**Date:** 2026-09-30
**Scope:** all capabilities that order mods or scope views to a profile
**Applies to:** `load-order-edit`, `game-setup`

**Decision:** We will keep one global load order and treat the active profile as a filter over it.

**Trade-offs:**

- Accepted: reorder once, every profile benefits; sharing a profile never forks ordering
- Cost: every order view must scope to the active profile or it misleads

## Context

Profiles (Civ6 "mod groups") can be created, duplicated, renamed, deleted,
switched, and shared as `.json` files. If each profile owned its own order,
every reorder would need copying across profiles and shared profiles would
diverge with no common reference. Renaming and sharing are routine user
actions, not edge cases.

## Options Considered

### Per-profile load orders

- Pros: each profile fully independent
- Cons: reorders must be duplicated; exported/shared profiles drift apart with no common reference
- Rejected because: profiles are shared and renamed routinely — N copies of one order is N chances to disagree

### One global order, profile as a filter

- Pros: a single reorder benefits every profile; sharing never forks ordering
- Cons: views must always apply the profile filter; a missing filter shows the wrong list
- Rejected because: n/a — chosen

## Consequences

The editor lives on the overrides route while views stay read-only.
Identity follows component rows with server resolution so filtered views
stay stable across renames. Deleting a profile must handle orphaned load
orders (open follow-up).

## Change

Implemented by openspec change `load-order-edit`, archived 2026-09-30.
