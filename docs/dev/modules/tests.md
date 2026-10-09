# Test system — `tests/` mirrors plus `arch.test.js`

What it is: the single source of truth for verification — stdlib `node:test`
mirrors, one per capability, plus shared helpers and an architecture guard. No
test framework beyond the Node standard library. See
`adr/ADR-007-use-node-test-for-phase-mirror.md` and
`adr/ADR-008-count-executed-checks.md`.

## Reference (mirror files)

| Suite | File | Covers |
|---|---|---|
| `test:profiles` | `tests/profiles.test.js` | Profiles (mod groups) |
| `test:labels` | `tests/labels.test.js` | Mod labels |
| `test:sorting` | `tests/sorting.test.js` | The six orderings (pure functions) |
| `test:loadorder` | `tests/loadorder.test.js` | Load order: store, identity, apply, sync, view, import/export (Tests 20–21) |
| `test:scripts` | `tests/browser-scripts.test.js` | Classic-`<script>` global-scope safety |
| `test:replay` | `tests/conflict-replay.test.js` | Conflict replay (9 suites) |
| `test:shadowing` | `tests/shadowing.test.js` | UI shadowing |
| `test:packaging` | `tests/packaging.test.js` | Release packaging |
| `test:game-setup` | `tests/game-setup.test.js` | Setup rounds and verdicts |
| — | `tests/helpers.js` | Shared seam: `makeTmp` Temp pattern plus assert wrappers |
| — | `tests/arch.test.js` | Require-cycle guard over `src/*.js`, including deferred `require()` calls |

## How-to: run the gate

- One mirror: `node --test tests/<name>.test.js`.
- One slice: `node --test --test-name-pattern="<name>" tests/<name>.test.js`.
- Architecture guard: `node --test tests/arch.test.js`.
- Full gate: `npm run check:release` (all `test:*` steps plus selfcheck and
  clean). Manual tools outside the gate: `npm run phase0`, `phase1`, `phase2`
  (need a real config in `fixtures/`).

## What it does not do

Mirrors never touch the live game database or your real store files: scratch
state goes under OS temp via `makeTmp` (canonicalised once via
`realpathSync.native`), with `CIV6_*_FILE` overrides pointing at Temp. The old
`src/phase4`-up proof scripts were deleted at cutover after 1:1 cover was
proven per file.

## UI variables note

`public/style.css` theming is pure CSS and has no mirror: the `:root`
variables are the contract (see `ui-variables.md`). `test:scripts` covers
script concatenation safety, not styling.
