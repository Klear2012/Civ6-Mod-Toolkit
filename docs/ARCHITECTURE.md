# Architecture

Civ6 Mod Toolkit runs outside the game. You manage mods, profiles, load order,
and conflicts here; the game database is never written.

## Entry and pipeline

Entry: `src/server.js`, fanned out to split modules (`server-selfcheck.js`,
`gates.js`, `loadorder-fit.js`, `loadorder-store.js`) with API dispatch
through a first-match `ROUTES` table — pure restructure, no behavior change.
The pipeline keeps the phase order; the checks that
used to be phase scripts are now stdlib `node:test` mirrors (`tests/` is the
single source of truth):

| Phase | Gate step | Owns |
|---|---|---|
| 0 | `phase0-roundtrip.js` (manual tool, out of gate) | `.Civ6Cfg` parse/edit/save round-trip proof |
| 1 | `phase1-inventory.js` (manual tool, out of gate) | Mod inventory and diff |
| 2 | `phase2-save.js` (manual tool, out of gate) | Save-adjacent handling |
| 4 | `test:profiles` (`tests/profiles.test.js`) | Profiles (mod groups) |
| 5 | `test:labels` (`tests/labels.test.js`) | Mod labels |
| 6 | `test:sorting` (`tests/sorting.test.js`) | Sorting |
| 7 | `test:loadorder` (`tests/loadorder.test.js`) | Load order resolution |
| 8 | `test:scripts` (`tests/browser-scripts.test.js`) | Script handling |
| 9 | `test:replay` (`tests/conflict-replay.test.js`), `test:shadowing` (`tests/shadowing.test.js`) | Conflict replay + UI shadowing |
| 10 | `test:packaging` (`tests/packaging.test.js`) | Release packaging |
| game-setup | `test:game-setup` (`tests/game-setup.test.js`) | Setup rounds and verdicts |
| selfcheck | `phase9-selfcheck` (`node src/server.js --selfcheck`, product code) | Conflict-diagnosis selfcheck |
| clean | `phaseclean` (`node src/phase-clean.js`) | Stray-artifact gate |

Each mirror runs alone with `node --test tests/<name>.test.js`, or one slice
with `node --test --test-name-pattern="<name>" tests/<name>.test.js`.
Full gate: `npm run check:release` (the `test:*` steps plus selfcheck and
clean). No test framework beyond the Node standard library; the `tests/`
mirrors are the verification. The old `src/phase4`-up proof scripts were
deleted at cutover after 1:1 cover was proven per file.

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
- **Crash vicinity** groups the trailing window of the game log by attributed
  mod on the differential response (`crashVicinity`, newest first, unattributed
  bucket last) as a lead into the full differential, not the verdict.
- **Benign game-own rows** (known-harmless Firaxis log lines) are tagged on the
  response, excluded from error tallies, and listed collapsed as the game's own.

Behavior contracts: `openspec/specs/` (conflict-replay, shadowing-enumeration,
log-pairing, load-order-edit, game-setup, mod-name-display, replay-text-tables).
Page-level how-tos: `docs/user/`. Module internals: `docs/dev/modules/`.

## For maintainers with the full checkout

Change history (`openspec/changes/`), the planning index
(`docs/TRACEABILITY.md`), and the decision log (`docs/decisions/`) are
local-only and not in git. Public readers need nothing from them: behavior
is in `openspec/specs/`, rationale summaries are in `docs/dev/`.
