# Decision: play-from-save boots through one tuner menu call with a fail-fast load verdict

## Summary

**Status:** Accepted
**Superseded by:** ADR-017 (its "no OS clicks/keys" boundary clause only; the rest of this decision stands)
**Date:** 2026-10-11
**Scope:** play-from-save boot trigger and load verdict only — how bootSave starts the load and how it reads the result; nothing else gains a live-game trigger
**Applies to:** `bootSave` in `src/play-save.js` only
**Change:** `play-save` boot path in `src/play-save.js`

**Decision:** `bootSave` starts the planted-save load with one tuner call —
`OnStateTransition("MainMenu")` fired once into the MainMenu tuner state after
a menu-ready poll — and reads the result as a fail-fast tri-state verdict over
the game logs. The tuner call is the default; when the menu never becomes
ready (or the call itself fails) the boot leaves the menu up and returns a
plain-words `needsManualClick` reason naming the one click that finishes it.
No step in this path performs mouse automation, key synthesis, OCR, or
screenshot inspection: readiness is tuner LSQ states plus log markers only.

**Trade-offs:**

- Accepted: the boot depends on the tuner port being reachable at menu time,
  with a bounded wait (repoll period with a total cap long enough to cover a
  cold menu load, short enough to fall back while the user is still watching)
- Accepted: a refused load is reported at once with the game's own early-exit
  line quoted, instead of polling out the full load timeout
- Cost: nothing beyond `bootSave` inherits any live-operation cover; this
  decision grants no new exception — it runs inside ADR-015's exclusive
  live-operation doctrine, which stays the sole exception to ADR-006

## Context

The planted `PlayNowSave` key tells the menu which save to load, but planting
alone does not start anything: the game sits at the main menu until something
advances it. The previous option was the user clicking Play by hand every
time. The tuner bridge (ADR-015) already holds a live connection to the
running game, and the menu exposes a state list through its LSQ handshake —
including a MainMenu state while no game is loaded (both execution states
absent). Firing the menu's own transition function through that state starts
the planted load with zero mouse clicks and zero key presses.

The load result was previously a boolean (loaded or keep waiting) with one
failure shape: waiting out the timeout. The game logs distinguish a third
case — the instant-reject line in `net_message_debug.log` (`LoadGameViewState
leaving ... early exit of the game state`), after which no content marker ever
follows. Treating that line as final turns a ten-minute wait into an
immediate, quotable refusal.

## Options Considered

### Manual click always (no tuner trigger)

- Pros: zero new machinery, no port dependency at menu time
- Cons: every boot stops at the menu waiting on the user, which is the step
  this path exists to remove
- Rejected because: the planted key plus an idle menu is an unfinished boot

### OS-level click or key synthesis at the menu (chosen nowhere)

- Pros: works without the tuner port
- Cons: needs screen coordinates or focus control, breaks across layouts and
  resolutions, and cannot verify what it clicked
- Rejected because: the game's own transition function through its own
  bridge call starts the same load deterministically; see ADR-004 — an
  unverifiable click is a guess stated as an action

### Tuner menu call as the default with manual-click fallback (chosen)

- Pros: the common path needs no user action; the fallback keeps the boot
  honest — a menu that never becomes ready returns
  `needsManualClick` ("The save did not start by itself. The game is open at
  the menu — click Play and the save will load.") instead of failing or
  clicking anything itself
- Cons: the boot waits on the port at menu time (bounded by the poll cap)
- Rejected because: n/a — chosen

### Boolean load probe (loaded or keep polling)

- Pros: one code path, no log-line parsing
- Cons: a refused load burns the whole load timeout before reporting what
  the log already said on line one
- Rejected because: the early-exit line is definitive — no content marker
  ever follows it — so waiting is pure delay

### Fail-fast tri-state verdict (chosen)

- Pros: loaded wins on any fresh join marker (`MultiplayerJoinGameComplete`,
  `GAMECORE_UNSERIALIZE_GAMESTATE took`, `OnLoadGameViewStateDone`); failed
  fires at once on a fresh early-exit line with the line quoted as the
  reason; unknown keeps polling to the timeout
- Cons: reads three log files instead of one check
- Rejected because: n/a — chosen

## Consequences

`bootSave` fires the tuner menu call by default (skipped only for stubbed
loads with an injected verdict, where there is no live menu), then verifies
through the tri-state check: a fresh join marker restores AppOptions at once;
a fresh early-exit line with zero content markers returns `load-rejected`
quoting that line and leaves the plant for the startup reconcile; anything
else polls to the timeout and defers the restore. Detection stays inside two
sources — tuner LSQ states for menu readiness, log markers for load outcome —
and OS clicks, keys, OCR, and screenshots are out of scope for this path and
every path it touches. Live-operation cover is inherited, not extended:
ADR-015 remains the sole exception to ADR-006, and any future live trigger
outside `bootSave` needs its own explicitly requested decision.

## Change

Implemented in `src/play-save.js` (`defaultTunerClick`, `tunerMenuReady`,
`checkLoadState`, `waitForGameThenRestore`, `bootSave` wiring) with mirrors
in `tests/play-save.test.js`; accepted into `adr/` as
`ADR-016-tuner-click-boot.md`. ADR-006 and ADR-015 stay in force unchanged.
