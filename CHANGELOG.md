# Changelog

All notable changes to this project are recorded here.

This project is a fork of [cru121/Civ6-Mod-Toolkit](https://github.com/cru121/Civ6-Mod-Toolkit),
which was last updated on 25 September 2026. Everything from **v1.1.0** onward is
new in this fork; **v1.0.0** and earlier are upstream's work, under the same MIT
licence and with the original copyright left intact.

Versions are tagged, and each tag produces a Windows zip on the
[releases page](https://github.com/Klear2012/Civ6-Mod-Toolkit/releases/latest).

## v1.5.0 — 28 September 2026

A mod manager you can actually drive: it finds new mods by itself, and you can
open a mod's folder, open its Workshop page, take it out of the game, or read
its name properly.

The work that was drafted as a separate v1.4.0 shipped as part of this one
release, so there is no v1.4.0 tag or download — v1.3.1 is the version before
this one.

### Added

- **The toolkit adds new mods itself, when it starts.** Anything on disk the
  game has never scanned is registered, and anything the game knows but that has
  no row in the profile in use gets one, so it can be ticked. No button, and no
  game launch.
- **Rescan & add new mods** (was *Rescan*) on the dashboard does the same thing
  on demand, for mods subscribed to while the toolkit is already open — which is
  how you normally subscribe, in batches. Renamed because it now writes to the
  game's database; a button labelled *Rescan* that silently registered thirty
  mods would be a nasty surprise.
- **A folder button on every Workshop and local mod**, which opens its folder in
  Explorer. A page cannot start Explorer itself — `file://` links are blocked from
  an `http://` page — so the server does it, taking ids only and re-deriving the
  folder from the database. A mod whose folder is gone shows the button disabled,
  labelled *folder not found*.
- **Remove mod**, in a mod's details panel. It takes the mod out of the game and
  out of every profile, and deletes its folder from disk. The dialog names the
  exact folder first, because the files cannot be undone — only the database is
  backed up.
- The dashboard lists mods that are recorded by the game but no longer on disk
  (unsubscribed, or deleted by hand) and points at the same button. They are only
  ever listed, never removed automatically: a mod part-way through a Steam
  download looks exactly like one just unsubscribed, and quietly deleting those
  would be a nasty way to lose a mod you had just subscribed to.
- The dashboard says what the last sync did — how many mods were added, and by
  name — and which could not be read, and why.
- If Civ6 is running, a sync is skipped and the reason is shown, rather than
  attempted and failed.

### Changed

- **Nothing is ever switched on.** Added mods come up off, with a row in every
  profile. This is the whole reason the above can run unattended: the toolkit
  can put a mod in front of you, but it cannot change what the game loads.
- The mod manager no longer has a Register button, an *Add to profile* button, or
  the *Add them all* banner. Its only write is **Apply changes**. A mod that
  needs adding is tagged **not added** and points at the dashboard.

### Fixed

- **Clicking the `workshop` label toggled the mod instead of opening the Workshop
  page.** The whole row is the on/off switch, and `paneClick` only spared what was
  a `<button>` or an `<a>`; the label was a `<span>`, so it was neither. It is now
  a real link, which fixes it structurally rather than adding another case to the
  handler. The separate `↗` it replaces, and the CSS only it used, are gone.
- A mod whose name contains an XML entity rendered as a literal `&amp;amp;`, and
  its colour markup showed as visible `<span>` text. Two causes: the text was
  escaped a second time after the colour tags had already become HTML, and the
  entity was never decoded. The game stores the raw `&amp;`, so the fix is at the
  point of display only — decoding earlier would have stopped the database
  matching what the game writes.
- The `workshop` and `enabled`/`disabled` labels in a mod's details sat on
  different baselines, because they were different components: a `.tag` at 11px
  beside a `.chip` at 12px. The state is now a `.tag` too, with colour variants.
  The dashboard's found/not-found badge and the change list are `.chip` and are
  deliberately left alone — those are meant to be read across a room.
- **The folder button didn't open the mod's folder.** Two separate faults, stacked,
  each masking the other:
  - It opened **Documents** instead, because the game records paths with forward
    slashes even on Windows and `explorer.exe` reads the first field of an argument
    beginning with `/` as a *switch* — given `D:/Steam/…/289070/2573589760` it saw
    `/Steam`, `/steamapps` and `/workshop` as unknown switches, was left with no
    path at all, and fell back to its default folder. Paths are now converted to
    native separators where they cross into a native program, and nowhere else.
  - Even with the right path, **no window appeared at all** — a flicker and
    nothing more. `windowsHide: true` sets `STARTUPINFO.wShowWindow = SW_HIDE`,
    which Explorer inherits, so it built the window and the shell hid it. A hidden
    window is still a real entry in Explorer's window list, so it looks like it
    worked. The flag is not repeated there on purpose: it belongs on the
    `tasklist` and `reg` calls, which are console programs that would otherwise
    flash one. `explorer.exe` is GUI-subsystem and never allocates a console, so
    the flag bought nothing and cost the window.
- `removeMods` skipped its folder checks entirely when given no source roots, so
  a destructive call could proceed because nobody passed an argument. It now
  refuses: it cannot prove the folder is safe.
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

### Note

Removing does not unsubscribe from Steam. The dialog links the Workshop page so
that is one click away, but doing it for you would mean guessing at a `steam://`
handler that may not exist for workshop items.

**For anyone on v1.3.x: _Add to profile_ used to switch a mod on. It now leaves
it off**, like everything else. Tick it in the mod manager as you would any
other mod.

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
