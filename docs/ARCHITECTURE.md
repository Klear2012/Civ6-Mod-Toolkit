# Architecture

Civ6 Mod Toolkit runs outside the game. You manage mods, profiles, load order,
and conflicts here; the game database is never written.

## Entry and pipeline

Entry: `src/server.js`. Work flows through `src/phase*.js` in order:

| Phase | Script | Owns |
|---|---|---|
| 0 | `phase0-roundtrip.js` | `.Civ6Cfg` parse/edit/save round-trip proof |
| 1 | `phase1-inventory.js` | Mod inventory and diff |
| 2 | `phase2-save.js` | Save-adjacent handling |
| 4 | `phase4-profiles.js` | Profiles (mod groups) |
| 5 | `phase5-labels.js` | Mod labels |
| 6 | `phase6-sorting.js` | Sorting |
| 7 | `phase7-loadorder.js` | Load order resolution |
| 8 | `phase8-scripts.js` | Script handling |
| 9 | `phase9-conflict-replay.js`, `phase9-shadowing.js` | Conflict replay + UI shadowing |
| 10 | `phase10-packaging.js` | Release packaging |
| game-setup | `phase-game-setup.js` | Setup rounds and verdicts |
| clean | `phase-clean.js` | Stray-artifact gate |

Each phase script runs alone with `node`. Full gate: `npm run check:release`
(phases 4–8 plus replay, shadowing, packaging, selfcheck, game-setup, clean).
No test framework; phase scripts are the verification. Phases 4 (profiles), 5 (labels), 6
(sorting), 7 (loadorder), 8 (browser-scripts), 9-shadowing, 9-replay, and 10 (packaging) plus game-setup additionally have stdlib `node:test` mirrors
(`tests/profiles.test.js`, `tests/labels.test.js`, `tests/sorting.test.js`, `tests/loadorder.test.js`, `tests/browser-scripts.test.js`, `tests/shadowing.test.js`, `tests/conflict-replay.test.js`, `tests/packaging.test.js`, `tests/game-setup.test.js`)
for filtered runs; the phase scripts stay authoritative.

## Data model

- `.Civ6Cfg` files are edited by **pure buffer splices** inside the mod-block
  regions only. Every byte outside the edited blocks is preserved verbatim.
  See `docs/dev/data-formats.md` and `src/civ6cfg.js`.
- **Profiles** (Civ6 "mod groups"): create, duplicate, rename, delete, switch,
  export/import as `.json`. Load order is **global**; a profile is a filter,
  not a separate order.
- `load-order-overrides.json`, `mod-labels.json`, `game-setup.json`: per-user
  local files, never committed. Shapes are documented in
  `docs/dev/modules/` and `docs/user/`.

## Encoding

UTF-16 via `iconv-lite`. Never assume UTF-8 near game files.

## Conflict analysis (read-only)

- **DB collision replay** runs mods' database writes in load order against a
  disposable copy and names the winning and losing file per contested row
  and column. The game database is never written.
- **UI file shadowing** lists every interface file claimed by more than one
  mod with its winner, or an honest *undefined* when no winner is decidable.
- **Database.log differential** shows where the replay and the game agree
  and where each saw what the other missed.

Behavior contracts: `openspec/specs/` (conflict-replay, shadowing-enumeration,
log-pairing, load-order-edit, game-setup, mod-name-display, replay-text-tables).
Page-level how-tos: `docs/user/`. Module internals: `docs/dev/modules/`.

## For maintainers with the full checkout

Change history (`openspec/changes/`), the planning index
(`docs/TRACEABILITY.md`), and the decision log (`docs/decisions/`) are
local-only and not in git. Public readers need nothing from them: behavior
is in `openspec/specs/`, rationale summaries are in `docs/dev/`.
