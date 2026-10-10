# Glossary

Words used across code and docs.

| Term | Means | Spec |
|---|---|---|
| Profile | Civ6 "mod group": a named set of enabled mods, switchable, exportable as `.json` | |
| Load order | The single global sequence mods load in; a profile filters it, never forks it | |
| Override | A user repositioning of a mod's actions, stored in `load-order-overrides.json` | |
| Replay | Running mods' database writes in load order against a disposable copy to find conflicts | |
| Shadowing | Two or more enabled mods claiming the same UI file path | |
| Differential | Replay-vs-game (Database.log) comparison showing agreement and misses | |
| Verdict | Will-run / requires-it / assumed label on a gated action | |
| Assumed | A verdict derived without game observation, always labeled as such | |
| Roundtrip safety | Parse → edit → save without touching a byte outside the edited blocks | `src/civ6cfg.js`, `FINDINGS.md` Phase 0 |
| Calibration | Comparing the tracker's load timeline against game-observed order | |
| Provenance | Which file and statement won a contested row/column, and how certain | |
