# Changelog

All notable changes to this project are recorded here.

This project is a fork of [cru121/Civ6-Mod-Toolkit](https://github.com/cru121/Civ6-Mod-Toolkit),
which was last updated on 25 September 2026. Everything from **v1.1.0** onward is
new in this fork; **v1.0.0** and earlier are upstream's work, under the same MIT
licence and with the original copyright left intact.

Versions are tagged, and each tag produces a Windows zip on the
[releases page](https://github.com/Klear2012/Civ6-Mod-Toolkit/releases/latest).

## v1.3.0 — 27 September 2026

Two ways a mod could be unusable in the mod manager, one button for both.

### Added

- **Add to profile** for a mod the game has already scanned but that has no row
  in the profile you are editing. It showed as *not available* and could not be
  ticked, and the Register button only appeared for mods the game had never
  seen — so a mod left behind by an earlier run, or discovered by the game after
  the profile was made, had no way out of the toolkit.
- The banner and the mod list report how many profiles a mod will be added to,
  and say so before you click.

### Changed

- **Registering a mod now writes a row in every profile**, not just the built-in
  group and the one you are editing. Previously the mod became *not available*
  again as soon as you switched profile. It is switched on in the profile being
  edited and the built-in group, and present-but-off in the rest — which is what
  a profile created by the toolkit already looks like. Re-registering never
  switches a mod on in a profile you did not ask for.
- The registration is read back and checked for a row in *every* profile, so a
  partial write fails and restores the backup instead of leaving a mod stuck.

### Fixed

- `<File>` elements that carry attributes (`<File priority="2">`) were being
  dropped, which lost 53 files across 30 mods when re-registering them. Recorded
  in `FINDINGS.md`.

## v1.2.0 — 27 September 2026

### Added

- **Register a mod without launching Civ6.** A mod you have just subscribed to
  gets the same rows in the game's mod database that the game itself would have
  written, so it can be switched on straight away. A banner button registers
  everything at once; a per-row button does one. Both are disabled while Civ6 is
  running, with the reason shown.
- `FINDINGS.md` records how a mod is registered, derived by matching the game's
  own output row for row.

### Changed

- The README, the docs site and the dashboard no longer tell you to start Civ6
  once to make it notice a new mod.

### Notes

- Registering many mods at once is all-or-nothing, and your database is backed
  up first either way.
- A mod is only *registered and enabled* — it takes effect the next time you
  start Civ6, not instantly.

## v1.1.0 — 27 September 2026

### Added

- **Player profiles** — Civ6 calls them *mod groups*, and upstream could list
  them and show which was in use but could not change any of them. The **Profile**
  bar above the filters now switches which group you are editing, and
  **Manage…** creates an empty one, duplicates the selected one, renames it, or
  deletes it. Deleting the profile in use switches to the one you had before it.
- **Export** and **Import…** for profiles, as `.json`, so a set-up can be moved to
  another computer or shared. Mods in the file that you do not have installed
  are reported and left out. Import always creates a new profile.

### Changed

- The release zip is now built by a workflow on a version tag, so a release no
  longer needs a machine to do it by hand.

## v1.0.0 and earlier — upstream

By **cru121**. Dashboard, config editor, mod manager, and the Windows launcher.
See the [upstream repository](https://github.com/cru121/Civ6-Mod-Toolkit) for the
full history.
