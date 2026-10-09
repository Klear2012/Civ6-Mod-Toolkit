# Decision: count executed checks, not call sites, for the 1:1 gate

## Summary

**Status:** Accepted
**Date:** 2026-10-06
**Scope:** every phase-script `node:test` mirror wave after the pilot (`tests/*.test.js` cover of `src/phase*.js`)
**Applies to:** profiles, browser-scripts, packaging, `shadowing-enumeration` (and later `load-order-edit`, `conflict-replay`)
**Change:** `wave3-node-test-profiles-scripts-packaging-shadowing`, archived 2026-10-06.

**Decision:** The 1:1 gate counts **executed checks in the default baseline run** (baseline PASS lines minus the `ALL CHECKS PASSED` banner, which itself contains "PASS"), not `check(` source occurrences.

**Trade-offs:**

- Accepted: loop bodies unroll to one `it()` per execution with labels verbatim, so a failure names the exact item (which script, which route).
- Accepted: argv-gated blocks the default run skips stay out of the mirror, so the contract is the deterministic no-arg baseline, not a machine-specific game install.
- Cost: `it()` counts diverge from call-site counts in both directions wherever loops or gated blocks exist; reviewers must compare against baseline output, not `grep -c`.

## Context

ADR-007 requires each mirror to prove "1:1 cover" before any cutover. The pilot and Wave 2 equated one `check(` call site with one `it()` (59 for sorting; 124 for labels and 116 for game-setup) — no loops, no gated blocks, so sites equaled executions. Wave 3 breaks the equality both ways:

- `src/phase8-scripts.js`: 118 sites, 140 executions. The per-script existence loop and per-script parse loop each run x10 scripts, and the per-nav registration loop runs x5 routes; confirmed against 141 baseline PASS lines minus the banner.
- `src/phase4-profiles.js`: 309 sites, 299 executions. Thirteen real-database sites are gated on `argv[2]` and never run without a game install, while one wrong-shape loop body runs one site x4; confirmed against 300 baseline PASS lines minus the banner.
- `src/phase10-packaging.js` (73) and `src/phase9-shadowing.js` (59, split 13 + 11 + 11 + 24 across its suites) already agree site-for-site.

Per-file gates under this convention: profiles **299**, browser-scripts **140**, packaging **73**, shadowing **59**. Loop-executed checks unroll to one `it()` per execution with the label verbatim, including dynamic labels such as per-script existence lines. The mirror covers exactly what `node src/phaseX.js` with no args executes; if a later environment runs a gated block, its PASS lines are that block's own accounting, not the mirror's.

## Options Considered

### One `it()` per call site (collapse loops)

- Pros: `it()` count equals source occurrences; smaller files.
- Cons: changes labels (a loop becomes one aggregate name), loses per-item failure attribution (which script or route failed), and under-counts what the gate actually proves.
- Rejected because: it redefines the gate to count text rather than behavior, and a red run no longer says what broke.

### Mirror the gated real-database block conditionally

- Pros: covers code the default run skips.
- Cons: needs a real game install no dev machine guarantees, and its assertions depend on unknown library contents — it cannot be verbatim or deterministic.
- Rejected because: the no-arg baseline is the contract every machine can run; environment-specific coverage belongs to that environment, not the mirror.

### Executed-check counting (chosen)

- Pros: matches the baseline output line-for-line; keeps labels verbatim; stays deterministic.
- Cons: counts must be re-derived per file from a baseline run rather than read off with a source search.
- Chosen because: the gate proves the mirror runs what the script runs, which is the property cutover depends on.

## Consequences

Later waves (phase7 load-order, phase9 conflict-replay, which also mix loops and gated blocks) inherit executed-check counting. Cutover stays one `package.json` line per file in a follow-up, after the executed-count gate passes. If a future mirror needs a different counting rule, that wave files a superseding decision instead of drifting.

## Change

Implemented by openspec change `wave3-node-test-profiles-scripts-packaging-shadowing`, archived 2026-10-06.
