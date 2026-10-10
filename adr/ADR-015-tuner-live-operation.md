# Decision: the tuner bridge operates on the live game, guarded by InGame validation

## Summary

**Status:** Accepted
**Date:** 2026-10-10
**Scope:** tuner bridge live-operation only — sole exception to ADR-006; all other capabilities remain under ADR-006 by default with no action needed
**Applies to:** `tuner-bridge-core` only
**Change:** `tuner-bridge-core`

**Decision:** The tuner bridge talks to the running Civilization VI process
over its FireTuner TCP port and to nowhere else: reads run in the
GameCore_Tuner context, writes run exclusively through the InGame context
where the game's own validation accepts or rejects each action. Database
files — live or copied — are never opened by the bridge. Client-side
allow-listing of Lua is forbidden: it would drift from the game's rules.

**Trade-offs:**

- Accepted: the bridge only functions while Civ6 runs — the deliberate,
  recorded inverse of ADR-006's refuse-while-running precondition, applying
  solely to the tuner bridge
- Accepted: a write the game rejects stays rejected (surfaced as `E_LUA`,
  never retried or rewritten)
- Cost: nothing beyond `tuner-bridge-core` inherits this exception; every
  other capability remains under ADR-006 with no action needed, and any
  future live-operation consumer needs its own explicitly requested decision;
  menu screens expose no game states, so callers handle `E_NO_STATES` honestly

## Context

Every toolkit writer so far refuses game-database writes while Civ6 runs
(ADR-006) and replays against a disposable copy (ADR-001). The tuner bridge
cannot follow that precondition: the FireTuner port exists only in a running
game with `EnableTuner=1` (which disables achievements — explicit consent,
never enabled by the tool). The substitute guard is the execution context
itself: GameCore_Tuner exposes the read-only surface, and InGame executes
through the same validation as the game's own UI, so an illegal action
fails in the game, not in a toolkit replica of its rules. Live measurement
2026-10-10 grounded the numbers: handshake answers in ~25 ms over persistent
TCP `localhost:4318` (Nexus frames `[u32le len][i32le tag][utf-8 + NUL]`,
per the MIT-licensed lmwilki/civ6-mcp reverse engineering); output collects
to a sentinel print; `ERR:` payloads stay errors.

## Options Considered

### Refuse while running (ADR-006 literally)

- Pros: zero new safety argument, one rule everywhere
- Cons: the bridge would refuse exactly when it can function — a dead tool
- Rejected because: the precondition contradicts the capability; the design
  records the exception instead of silently extending ADR-006

### Toolkit-side Lua allow-listing

- Pros: reads and writes could share one context with a curated safe subset
- Cons: the list drifts from the game's rules with every patch; a missed
  entry is either a cheat vector or a false refusal
- Rejected because: no-cheat by game construction beats no-cheat by toolkit
  promise

### InGame validation as the guard (chosen)

- Pros: the game enforces its own rules; rejected actions prove the guard
  (live: nil-call returns `ERR:Runtime Error`, surfaced as `E_LUA`)
- Cons: requires a loaded game for the write path; menu-only sessions get
  an honest `E_NO_STATES`, not a degraded write
- Rejected because: n/a — chosen

## Consequences

The tuner bridge routes reads to GameCore_Tuner and writes to InGame,
names the state in its output envelope, and treats `E_NO_STATES` as
load-a-game-first. Malformed frames are never sent: short unframed input
provably wedges the game's listener into a zero-length-frame flood until
disconnect (measured 2026-10-10 during `tuner-bridge-core`). The single
connection is held open across commands and closed promptly; the FireTuner
GUI and the bridge cannot hold the slot at once, and the refused message
says so in plain words.

## Change

Implemented by openspec change `tuner-bridge-core` (`src/tuner.js`,
`tests/tuner.test.js`); accepted into `adr/` as
`ADR-015-tuner-live-operation.md`. ADR-006 stays in force for every
capability outside `tuner-bridge-core`.
