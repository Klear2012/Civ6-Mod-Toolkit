# Decision: leader-screen continue is one Escape key, sent only after the logs park the game

## Summary

**Status:** Accepted
**Date:** 2026-10-11
**Scope:** leader-screen continue after a save load: one `Escape` key, pressed only after the leader-waiting detector positively matches
**Applies to:** `isLeaderWaiting` and `escapeLeaderScreen` in `src/leader-escape.js`; the post-verdict call site in `bootSave` in `src/play-save.js`
**Supersedes:** ADR-016 — its "no OS clicks/keys" boundary clause only, narrowed to the `Escape` key on the parked-leader path; ADR-016's mouse, coordinates, OCR, and screenshot prohibitions stand
**Change:** `src/leader-escape.js` (detector, bounded loop, focus and key by process ID), `src/game.js` (`gameProcesses` PID listing), `bootSave` wiring in `src/play-save.js`, mirrors in `tests/leader-escape.test.js`

**Decision:** After a play-from-save load, `bootSave` sends one `Escape` keypress per attempt, at most three attempts per boot, and only while the game logs positively show the game parked at the Begin Game (leader) screen. The game window is brought forward by process ID through `AppActivate`, and the key goes through `WScript.Shell` `SendKeys`. This keypress is the temporary leader-continue mechanism until a tuner path exists. Mouse input, screen coordinates, OCR, and screenshot inspection stay out of this path.

**Trade-offs:**

- Accepted: the toolkit sends one OS key to the game window, the only OS input this path performs. A focus failure sends nothing and says so in plain words.
- Accepted: the detector reads three logs. The Lua completion line has no per-load boundary, so it is mtime-gated and counts as corroboration only, never as the sole signal.
- Cost: a live boot waits up to 60 seconds for the leader verdict to settle after the load verdict, because the join marker lands before `PostLoadTime`. A load that never reaches the leader screen sends no key.

## Context

ADR-016 starts the planted load with one tuner menu call, but the game then parks at the Begin Game (leader) screen and waits for the player. A live run cleared that screen with one `Escape` and entered turn 166 of the save. No tuner path continues from the leader screen yet, so a keypress is the only available continue step, and ADR-016's "no OS clicks/keys" boundary blocks it.

The live log timing shows a race. `MultiplayerJoinGameComplete` and `WAIT_FOR_PLAYERS End` land in the same second, and `PostLoadTime` follows about two seconds later. A single check at the load verdict can read a parked game as still loading and never press.

## Options Considered

### Keep ADR-016's boundary; the user presses Escape (rejected)

- Pros: no OS input, no new machinery
- Cons: every boot stops at the leader screen waiting on the user, the step ADR-016 exists to remove
- Rejected because: the parked state is positively detectable from the logs, so the manual step is only the fallback

### Click the globe at screen coordinates (rejected)

- Pros: works without focus control
- Cons: depends on layout and resolution, and cannot verify what it clicked
- Rejected because: an unverifiable click is a guess stated as an action (see ADR-004)

### Escape by process ID, gated by the positive detector, bounded to three presses (chosen)

- Pros: one key already proven live; focus by process ID instead of whatever window is in front; the detector gates every press; each press is verified from log markers; a final failure is a plain-words message, not a crash
- Cons: adds OS input to the boot path; depends on three log files and on `AppActivate` succeeding
- Rejected because: n/a — chosen

### Single check after the load verdict (rejected)

- Pros: no settle polling
- Cons: misses the parked state whenever the check lands before `PostLoadTime`
- Rejected because: the race is measured in the live logs

## Consequences

ADR-016's "no OS clicks/keys" boundary clause is superseded for one key only. The `Escape` key may be sent only after the detector matches. Mouse input, coordinates, OCR, and screenshots remain forbidden on this path and on every path it touches. ADR-016 stays in force for everything else.

The keypress is temporary. A tuner path that continues from the leader screen supersedes this decision with its own file, not by editing this one.

Stubbed launches (no game window) and refused loads never reach the step. Tests inject focus, key, log, and sleep functions, so no test sends a key.

## Change

Implemented in `src/leader-escape.js` with mirrors in `tests/leader-escape.test.js`, plus `src/game.js` (`gameProcesses`) for the process lookup. The `bootSave` call site in `src/play-save.js` runs after the load verdict. ADR-016 gets one back-link line; ADR-006 and ADR-015 stay in force unchanged.
