# Decision: handleApi becomes a first-match route table

## Summary

**Status:** Accepted
**Date:** 2026-10-06
**Scope:** in-file request dispatch in the local web server entry
**Applies to:** `load-order-edit`, `conflict-replay`
**Change:** `refactor-server-loadorder-split`

**Decision:** We will replace the `handleApi` if-chain with a linear `ROUTES`
array of `{ method, match, handler }` scanned first-match in today's branch
order, where `match` is an exact pathname except the single POST
`/api/modgroups/*` prefix entry.

**Trade-offs:**

- Accepted: order-equivalence with today is structural (first match wins, same
  order), so even accidental branch overlap behaves identically.
- Accepted: the route inventory becomes auditable data (the before/after diff
  is a list comparison, not a code review).
- Cost: linear scan over ~33 entries per request (negligible on a
  localhost admin server); a Map would be faster and harder to prove ordered.

## Context

All 33 branch conditions are `req.method === ... && url.pathname === ...`
except one prefix match (POST `/api/modgroups/`), pairwise disjoint, each
ending in `return`. In-handler 404s and the terminal 404 stay inside
handlers/after the loop.

## Options Considered

### Linear array, first-match, exact-or-prefix entries (chosen)

- Pros: today's evaluation order IS the table order — equivalence needs no
  disjointness argument; the modgroups prefix entry sits exactly where its
  `if` sits today.
- Cons: O(n) scan; prefix entries need a `kind` flag rather than being
  uniform strings.
- Chosen because: provable order-equivalence beats lookup elegance for a
  33-route localhost dispatcher.

### Nested Map `method -> path -> handler` with prefix fallback

- Pros: O(1) exact lookup; cleaner data shape.
- Cons: prefix-fallback ordering rules must be re-specified (today order is
  implicit in the if-chain); a second dispatch mechanism for one route.
- Rejected because: re-specifying match priority for one prefix route buys
  nothing on a localhost server and risks subtle reorder bugs.

### Keep the if-chain, extract handlers only

- Pros: smallest diff.
- Cons: keeps the 800-line conditional — the Switch-Statements smell this
  split exists to remove; inventory still requires reading code.
- Rejected because: it is half the split with none of the auditability.

## Consequences

Handler names mirror today's route comments (`GET /api/state -> ...`);
route renames are out of scope. A future route adds one table row; a future
second prefix route reuses the `kind` flag. Test mirrors that pinned
dispatcher syntax now resolve handlers through `ROUTES` instead.

## Change

Implemented by openspec change `refactor-server-loadorder-split`, archived 2026-10-07.
