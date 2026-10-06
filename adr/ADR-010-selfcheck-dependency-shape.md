# Decision: selfcheck dependency shape (inject server handle, require leaves)

## Summary

**Status:** Accepted
**Date:** 2026-10-06
**Scope:** product entry modules whose extracted code needs the live server handle
**Applies to:** `load-order-edit`, `conflict-replay`
**Change:** `refactor-server-loadorder-split`

**Decision:** We will move `runConflictSelfcheck` into `src/server-selfcheck.js`
with its server-local dependencies injected as parameters
(`{ server, host, hosts, builders... }`), while leaf modules
(`paths`, `setupStore`, `shadowing`, `conflict-replay`) are required directly.

**Trade-offs:**

- Accepted: no require cycle is possible — the new module never requires `server.js`.
- Accepted: the selfcheck split lands without waiting on any other extraction
  (builders stay injected; nothing else moves with it).
- Cost: the injection surface (server handle + six builders) is wider than a
  plain require; the `--selfcheck` entry call in `server.js` names each dep.

## Context

`runConflictSelfcheck` needs the production `server` instance
(`listen`/`close`), `HOST`, `OWN_HOSTS`, and six server-local conflict
builders. `server.js` must require the new module for the `--selfcheck` entry,
so the new module requiring `server.js` back is a cycle.

## Options Considered

### Inject everything, require leaves directly (chosen)

- Pros: acyclic by construction; leaf requires (`paths`, `setupStore`,
  `shadowing`, `conflict-replay`) need no threading.
- Cons: widest call-site surface at the `--selfcheck` entry.
- Chosen because: the cycle is structurally impossible rather than
  conventionally avoided.

### Let the new module require `server.js` (cycle, deferred access)

- Pros: narrowest code diff (no signature change).
- Cons: CommonJS partial-exports fragility; a future top-level reorder in
  either file silently breaks the other at load time.
- Rejected because: load-time coupling between an entry script and its own
  extract is exactly the shape this change exists to remove.

## Consequences

The `--selfcheck` entry stays one call site naming each dep; any future
server-local need of the selfcheck must extend the deps object, never require
`server.js`. Narrowing the builder deps to a direct require was conditional on
extracting the conflict builders, which was deliberately dropped (see
ADR-012) — so the injection shape stays as-is unless ADR-012 is superseded by
a new decision.

## Change

Implemented by openspec change `refactor-server-loadorder-split`, archived 2026-10-07.
