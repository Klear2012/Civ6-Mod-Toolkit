# Decision: diagnostics are read-only and every game-database write is guarded

## Summary

**Status:** Accepted
**Date:** 2026-10-06
**Scope:** all capabilities that read the game database or write derived state
**Applies to:** `conflict-replay`, `log-pairing`, `shadowing-enumeration`, `load-order-edit`

**Decision:** We will keep every report read-only: reports never write. Every write touching the game database is refused while Civilization VI runs. The server resolves paths and ids from the database, never from client input.

**Trade-offs:**

- Accepted: running a diagnosis can never corrupt the game or fight its file locks
- Accepted: client input is untrusted by construction — no path echo, no id confusion
- Cost: legitimate writes wait for the game to close; the UI must explain each refusal

## Context

The toolkit diagnoses a live game it does not own: replaying mod SQL,
pairing log lines to mods, enumerating shadowed UI files, applying load
order overrides. A diagnostic that writes into what it measures, a write
that lands while Civ6 holds the database open, or a path taken from a
request would each turn the tool into the failure it exists to explain.

## Options Considered

### Let reports write derived state into the game database

- Pros: results could be cached where the game could see them
- Cons: a diagnostic bug writes garbage into the real game; replay-vs-game comparison becomes meaningless
- Rejected because: diagnosis must never be able to break the game it diagnoses

### Warn but proceed when Civ6 is running

- Pros: fewer blocked actions, less refusal wording
- Cons: writes against an open database risk lock fights and half-applied state the tool cannot see
- Rejected because: refusal with a reason is the only answer that cannot corrupt a session

### Resolve client-supplied paths and ids directly

- Pros: less server lookup code per route
- Cons: request paths can escape intent; echoed paths leak full relative locations to the client
- Rejected because: the server answers from the database (basenames to the client, full paths never leave), and unknown ids are 404s, not guesses

### Read-only reports, guarded writes, server-side resolution

- Pros: contained failures, well-defined differentials, no trust in request content
- Cons: every write path needs the game-running check; every refusal needs wording
- Rejected because: n/a — chosen

## Consequences

Replay runs against a disposable copy (ADR-001). Block applies land
atomically with one backup or not at all, and only while the game is
closed. Views work while Civ6 runs because, like every other GET, they
write nothing. File lists reaching the client are basenames; no
request-supplied path is ever echoed back.

## Change

Recorded 2026-10-06; already in force across the applied changes
(`load-order-edit` game guard, `conflict-diagnosis` disposable copy,
`log-pairing` read-only pairing, shadowing basename lists).
