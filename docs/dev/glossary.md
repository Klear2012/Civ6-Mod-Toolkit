# Glossary

Words used across specs, code, and docs. When code and prose disagree, the
spec path in the last column wins.

| Term | Means | Spec |
|---|---|---|
| Profile | Civ6 "mod group": a named set of enabled mods, switchable, exportable as `.json` | `specs/game-setup`, `specs/load-order-edit` |
| Load order | The single global sequence mods load in; a profile filters it, never forks it | `specs/load-order-edit` |
| Override | A user repositioning of a mod's actions, stored in `load-order-overrides.json` | `specs/load-order-edit` |
| Replay | Running mods' database writes in load order against a disposable copy to find conflicts | `specs/conflict-replay` |
| Shadowing | Two or more enabled mods claiming the same UI file path | `specs/shadowing-enumeration` |
| Differential | Replay-vs-game (Database.log) comparison showing agreement and misses | `specs/conflict-replay`, `specs/log-pairing` |
| Verdict | Will-run / requires-it / assumed label on a gated action | `specs/game-setup` |
| Assumed | A verdict derived without game observation, always labeled as such | `specs/game-setup` |
| Roundtrip safety | Parse → edit → save without touching a byte outside the edited blocks | `src/civ6cfg.js`, `FINDINGS.md` Phase 0 |
| Calibration | Comparing the tracker's load timeline against game-observed order | `specs/log-pairing` |
| Provenance | Which file and statement won a contested row/column, and how certain | `specs/conflict-replay` |
