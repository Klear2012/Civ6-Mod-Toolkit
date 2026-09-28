# Civ6 Mod Toolkit

A mod toolkit for Sid Meier's Civilization VI that runs outside the game:

- **Dashboard** — how many Workshop and local mods you have (and how many are
  enabled), your saved game configurations, whether the game is running, and
  where the toolkit looks for everything.
- **Config editor** — add or remove mods in an existing `.Civ6Cfg` game
  configuration **without** recreating it by hand. Your customized game settings
  are preserved — only the mod list is touched.
- **Mod manager** — turn mods (and official DLC) on and off without starting
  the game, with warnings for missing dependencies and conflicts. Handy when a
  broken mod stops the game from starting, or when the in-game mod screen is
  slow. A mod you have just subscribed to can be registered and switched on
  here, without starting the game once so it notices the mod.
- **Profiles** — Civ6 calls them *mod groups*. Create, duplicate, rename, delete
  and switch between them here, and export/import a profile as a `.json` file,
  so a set-up can be moved to another computer or shared.

> **This is a maintained fork** of
> [cru121](https://github.com/cru121/Civ6-Mod-Toolkit) (Steam:
> *evzenhouzvicka*), last updated 25 September 2026. Releases and fixes happen
> here — [CHANGELOG.md](CHANGELOG.md) has what this fork adds, and please
> [report problems here](https://github.com/Klear2012/Civ6-Mod-Toolkit/issues).
> The MIT licence and original copyright are unchanged.

Website: <https://klear2012.github.io/Civ6-Mod-Toolkit/>

Not affiliated with or endorsed by Firaxis Games or 2K.

## Install and run

Windows 10 or 11.

1. **Download** `Civ6-Mod-Toolkit-vX.Y.Z.zip` from the
   [latest release](https://github.com/Klear2012/Civ6-Mod-Toolkit/releases/latest).
2. **Unblock it** (recommended): right-click the zip → *Properties* → tick
   **Unblock** → *OK*. Otherwise Windows may show a blue *"Windows protected
   your PC"* warning — if it does, click *More info* → *Run anyway*.
3. **Extract** the zip anywhere (e.g. your Documents folder).
4. **Double-click `Civ6 Mod Toolkit.cmd`.** Your browser opens to the toolkit.

The toolkit needs [Node.js](https://nodejs.org) **22.5 or newer**. If it's
missing or too old, the launcher offers to install it for you (using Windows'
built-in `winget`) or to open the download page.

A small window stays open while the toolkit runs — press a key to pick:

- **O** — open it in your browser again, if you closed the tab
- **R** — restart it
- **S** — stop it and close the window

Closing the window also stops it. Tip: right-click the `.cmd` → *Send to* →
*Desktop (create shortcut)* to launch it from your desktop.

### From the source code

If you cloned the repository instead, the launcher installs the dependencies on
first run (needs internet once). Or:

```bash
npm install
npm start
```

Both open `http://127.0.0.1:8673` (from a terminal, stop it with Ctrl+C).

## Using it

### Dashboard

The start page. The cards show enabled / installed counts for **Workshop** and
**local** mods, the number of `.Civ6Cfg` files, and official DLC. The badge in
the top-right corner shows whether Civ6 is currently running.

**Folder setup** lists everything the toolkit uses — local mods, Steam Workshop,
the configurations folder, and the game's mod database (`Mods.sqlite`, under
`%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI`). They're
auto-detected; if one shows **not found**, click **Edit paths**, fix it, and
**Save paths**.

**Rescan & add new mods** picks up anything you've subscribed to since last
time. See below — you rarely need to click it, because the toolkit does this
when it starts.

### Mod manager

1. Pick what to show: **All mods** (Workshop + local), **Workshop**, **Local**,
   or **Official DLC**, optionally only **Enabled** / **Disabled** ones, and
   filter by name.
2. Tick or untick mods. **Enable all shown** / **Disable all shown** work on
   whatever the current filter shows. Changed rows are highlighted.

   Prefer moving mods between lists? Switch to **Two panes** and click a mod to
   move it across. The toolkit remembers which view you picked.
3. Click **i** on any mod for its details: description, authors, version, what
   it changes, what it needs, what needs it, what it's incompatible with, which
   of your `.Civ6Cfg` configurations use it, and its folder, size and Workshop
   page.
4. Warnings appear under a mod that is turned on but needs something that's off
   or missing (**Turn it on** fixes it), or that conflicts with another mod
   that's on.
5. Click **Apply changes** (or **Discard**). The game must be **closed** —
   applying is blocked while Civ6 runs. Changes take effect the next time you
   start the game.

### New mods

A mod you've just subscribed to isn't in the game's database yet, so the game
can't load it. The toolkit adds it for you:

- **When the toolkit starts**, anything on disk the game hasn't got is added
  straight away.
- **If you subscribe while the toolkit is already open**, click **Rescan & add
  new mods** on the dashboard. That covers subscribing to a batch at once, which
  is the normal way.

Added mods come up **switched off**, with a row in every profile so you can tick
them from any of them. Nothing is ever switched on for you — that's your
decision to make, and it's why this can run unattended. Civ6 must be **closed**,
the database is backed up first, and the result is read back and checked.

A mod tagged **not added** is one the game can't load yet. Same fix: rescan.

### Profiles (mod groups)

The **Profile** bar above the filters picks which group of mods you are
editing — the same thing as Civ6's *Additional Content → Mod Groups*. Each entry
shows how many mods it has on. The game must be **closed** to change them.

- Pick one from the dropdown to make it the group the game uses.
- **Manage…** creates an empty profile (every mod off), duplicates the selected
  one, renames it, or deletes it. The built-in *Default* profile and your last
  remaining profile can't be deleted; deleting the profile in use switches to
  the one you had before it.
- **Export** saves the selected profile as a `.json` file, **Import…** creates a
  new profile from such a file. Mods in the file that you don't have installed
  are reported and left out.

Worth exporting a profile as a backup now and then: a game patch that changes
the mod database format can switch every mod back on.

### Config editor

1. Pick a **Configuration file** from the dropdown.
2. **Left column** — mods currently enabled. Uncheck an installed mod to remove
   it. Official DLC and mods not found in your folders are hidden by default;
   tick **Show official DLC / mods** to see them (they're read-only).
3. **Right column** — mods you have installed but haven't enabled. Check the ones
   you want to add.
4. **Save (overwrite + backup)** writes the changes back to the same file after
   copying the original to a timestamped `.bak-…`. **Save as new file…** writes a
   fresh config and leaves the original untouched.
5. **Delete config…** removes the selected configuration file (a timestamped
   backup is kept, so it can be restored).

Then load the configuration in-game (Single Player → Create Game → load
configuration).

## Safety

- Overwrites always create a timestamped backup first (`name.Civ6Cfg.bak-…`).
- Before saving, the edited file is re-parsed and checked (mods added/removed in
  every mod block, counts consistent, header intact); a failed check aborts the
  write.
- Only the mod-list region of the file is ever modified.
- The toolkit only listens on `127.0.0.1`, and its API only accepts requests
  from its own page (other websites open in your browser can't talk to it).
- The mod manager only writes to the game's mod database while Civ6 is closed,
  copies it to a timestamped `Mods.sqlite.bak-…` first (the newest 10 are kept),
  and checks the result — if anything looks wrong, the backup is put back. The
  same applies to profile changes and to adding new mods.
- Adding new mods at startup is the one write that happens without you asking.
  It **never switches anything on** — a new mod is registered and left off, and
  only appears in the list. It is skipped entirely if Civ6 is running, and it
  writes nothing at all when there is nothing new to add.

## Authors & feedback

Originally by **cru121** (Steam: *evzenhouzvicka*), now maintained by
**Klear2012**. The MIT licence and original copyright are unchanged — see
[LICENSE](LICENSE).

Questions, bugs or ideas? Please
[open an issue on this repo](https://github.com/Klear2012/Civ6-Mod-Toolkit/issues).
Upstream is not being worked on, so issues filed there will not be seen.

## What's under the hood

A small Node server (`src/server.js`) exposes a JSON API used by the browser UI
in `public/`. The `.Civ6Cfg` format engine is `src/civ6cfg.js`, mod discovery is
`src/modinfo.js` + `src/paths.js`, safe saving is `src/editor.js`, and the game's
mod database, mod groups and registration are read and updated by
`src/modsdb.js`. `npm run phase4` checks the profile and registration operations
against a throwaway database.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release, and
`FINDINGS.md` for the reverse-engineered file format and mod database schema.
