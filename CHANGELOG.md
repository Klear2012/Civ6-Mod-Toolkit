# Changelog

All notable changes to this project are recorded here.

This project is a fork of [cru121/Civ6-Mod-Toolkit](https://github.com/cru121/Civ6-Mod-Toolkit),
which was last updated on 25 September 2026. Everything from **v1.1.0** onward is
new in this fork; **v1.0.0** and earlier are upstream's work, under the same MIT
licence and with the original copyright left intact.

Versions are tagged, and each tag produces a Windows zip on the
[releases page](https://github.com/Klear2012/Civ6-Mod-Toolkit/releases/latest).

## v1.4.0 — 28 September 2026

New mods are added automatically. The Register button is gone.

### Changed

- **The toolkit adds new mods itself, when it starts.** Anything on disk the
  game has never scanned is registered, and anything the game knows but that has
  no row in the profile in use gets one, so it can be ticked. No button, and no
  game launch.
- **Nothing is ever switched on.** Added mods come up off, with a row in every
  profile. This is the whole reason the above can run unattended: the toolkit
  can put a mod in front of you, but it cannot change what the game loads.
- **Rescan & add new mods** (was *Rescan*) on the dashboard does the same thing
  on demand, for mods subscribed to while the toolkit is already open — which is
  how you normally subscribe, in batches. Renamed because it now writes to the
  game's database; a button labelled *Rescan* that silently registered thirty
  mods would be a nasty surprise.
- The mod manager no longer has a Register button, an *Add to profile* button, or
  the *Add them all* banner. Its only write is **Apply changes**. A mod that
  needs adding is tagged **not added** and points at the dashboard.

### Added

- The dashboard says what the last sync did — how many mods were added, and by
  name — and which could not be read, and why.
- If Civ6 is running, a sync is skipped and the reason is shown, rather than
  attempted and failed.

### Fixed

- `registerMods()` ignored its `enabled` argument and always switched a mod on in
  the built-in group and the profile in use. Harmless while the only caller
  always wanted it on; under automatic syncing it would have switched mods on
  behind your back. Test 17 is the test that would have caught it.
- "What needs adding" was worked out in three separate places, and the copies
  had drifted: the dashboard's version looked only at the mod folders, so it
  never noticed a mod the game knew but that had no row in the profile. There is
  now one function, `findUnregistered()`, that all of them read.
- A second sync with nothing new to do used to make a fresh backup, so every
  Rescan click spent one of the ten backups kept. It now returns before writing.

### Note for anyone on v1.3.x

**Add to profile used to switch a mod on. It now leaves it off**, like everything
else. Tick it in the mod manager as you would any other mod.

## v1.3.1 — 28 September 2026

No code changes — this fixes what v1.3.0 shipped with.

### Fixed

- The `docs/` copy inside the v1.3.0 zip was the pre-fork one: its download
  button and release links still pointed at cru121, and its release-lookup
  script fetched cru121's newest release. The live site was already correct;
  this corrects the copy in the zip.
- The app footer credited Claude and sent **Open an issue** to
  `cru121/Civ6-Mod-Toolkit`, where nothing is being worked on. Both now point
  here.
- `package.json`'s `author` and `repository` fields also still named cru121 and
  Claude.

### Changed

- README trimmed by about a sixth, mostly by dropping the "what's new here"
  section that now duplicates this file, and fixing a "(see below)" that pointed
  at nothing.
- Claude removed from the README, the app footer, the docs site and
  `package.json`. cru121's original authorship, Steam name and MIT copyright
  are kept — that attribution is not optional under the licence, and it was
  never mine to remove.

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
