'use strict';

// Play-from-save: boot the game straight into a save through AppOptions'
// PlayNowSave key (";Forces the game to load only that save file.").
//
// Two entry points share one boot pipeline: playLatest() boots the newest
// autosave by mtime with no picker, while listSaves() + bootSave() serve the
// picker (list with turn and required mods, then boot the chosen file).
// Every boot refuses while Civ6 runs (see ADR-006) and plants a
// Saves-root-relative value the menu reads minutes after launch, restoring
// only after the logs confirm the load and otherwise leaving the plant for
// reconcileUnrestoredBoot() at the next toolkit start.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const paths = require('./paths');
const { gameStatus } = require('./game');
const { scanMods, normId } = require('./modinfo');
const saveParser = require('./civ6-save-parser');

// Told to the user when a boot cannot start. Plain player words: what is
// happening and what to do next, never a process name or an exit code.
const REFUSAL_RUNNING = 'Civilization VI is already running. Quit the game first, then play from the save.';
const NO_SAVES = 'No autosaves were found in the saves folder. Play a few turns first, then try again.';

// Prefix marking a staged launch copy. Distinctive so the startup sweep
// recognises its own files and never touches a real save.
const STAGING_PREFIX = 'ToolkitBoot_';

/**
 * Plain-words refusal when the staged name is already taken. Never
 * overwrites: the user removes the leftover copy, then tries again.
 */
function stagingCollisionError(saveName, plantedCopy) {
  return `The save "${saveName}" was not started: "${plantedCopy}" is still in the saves folder `
    + 'from an earlier try, so there was nowhere safe to prepare the launch. '
    + 'Delete that temporary file (its name starts with ToolkitBoot_ and it is only a copy), '
    + 'then try again. Nothing was changed.';
}

/**
 * Where the game's AppOptions.txt lives. Overridable so tests never touch
 * the real file (see ADR-006).
 */
function appOptionsPath() {
  return process.env.CIV6_APPOPTIONS || path.join(paths.localGamesRoot(), 'AppOptions.txt');
}

/** Sibling backup holding the pre-boot bytes, restored afterwards. */
function backupPathOf(appOptions) {
  return `${appOptions}.toolkit-backup`;
}

/**
 * Flag marking a boot in progress. Its presence at startup means a previous
 * run crashed between writing PlayNowSave and restoring the backup.
 */
function flagPathOf(appOptions) {
  return `${appOptions}.toolkit-boot`;
}

/**
 * Copy AppOptions aside and plant the boot flag. A stale flag means a
 * previous crash, so it is reconciled first and the restore is logged.
 */
function backupAppOptions(appOptions, opts = {}) {
  const target = appOptions || appOptionsPath();
  reconcileUnrestoredBoot(target, opts);
  let hadOriginal = true;
  try {
    hadOriginal = fs.statSync(target).isFile();
  } catch (_) {
    hadOriginal = false;
  }
  if (hadOriginal) fs.copyFileSync(target, backupPathOf(target));
  fs.writeFileSync(flagPathOf(target), JSON.stringify({ at: new Date().toISOString(), hadOriginal }));
  return { appOptions: target, backupPath: backupPathOf(target), hadOriginal };
}

/**
 * Record a staged launch copy in the boot flag so the restore and the
 * startup reconcile delete that exact file. Best effort, never throws.
 */
function noteStagedCopy(appOptions, stagedCopy) {
  const target = appOptions || appOptionsPath();
  const flag = flagPathOf(target);
  try {
    const state = JSON.parse(fs.readFileSync(flag, 'utf8'));
    state.stagedCopy = stagedCopy;
    fs.writeFileSync(flag, JSON.stringify(state));
  } catch (_) {
    /* a missing flag means nothing is tracking the boot */
  }
  return { appOptions: target, stagedCopy };
}

/**
 * Point the game's PlayNowSave key at a save, leaving every other line
 * byte-identical. A missing key is appended; an empty value clears it.
 */
function setPlayNowSave(text, savePath) {
  const line = savePath ? `PlayNowSave ${savePath}` : 'PlayNowSave';
  if (/^PlayNowSave[ \t]*.*$/m.test(text)) return text.replace(/^PlayNowSave[ \t]*.*$/m, line);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  return `${text}${text.endsWith('\n') ? '' : nl}${line}${nl}`;
}

/** Write the PlayNowSave key for a boot (creates AppOptions if absent). */
function writePlayNowSave(appOptions, savePath) {
  const target = appOptions || appOptionsPath();
  let text = '';
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (_) {
    text = '';
  }
  fs.writeFileSync(target, setPlayNowSave(text, savePath));
  return { appOptions: target, savePath };
}

/** Current PlayNowSave value, or null when the key is absent. */
function readPlayNowSave(appOptions) {
  const target = appOptions || appOptionsPath();
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return null;
  }
  const m = text.match(/^PlayNowSave[ \t]*(.*)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Undo a boot: put the backup bytes back (or remove a file the boot
 * created), delete the staged launch copy when there is one, and clear
 * the flag and backup. With no flag there is nothing to undo. Never
 * throws: a failed restore keeps the flag so the next startup reconcile
 * retries it.
 */
function restoreAppOptions(appOptions) {
  const target = appOptions || appOptionsPath();
  const flag = flagPathOf(target);
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(flag, 'utf8'));
  } catch (_) {
    return { restored: false };
  }
  try {
    if (state && state.hadOriginal) {
      try {
        fs.copyFileSync(backupPathOf(target), target);
      } catch (_) {
        // Backup lost: at minimum clear the boot key so the next game
        // start does not load the save again.
        try {
          fs.writeFileSync(target, setPlayNowSave(fs.readFileSync(target, 'utf8'), ''));
        } catch (_) {
          return { restored: false };
        }
      }
    } else {
      try {
        fs.unlinkSync(target);
      } catch (_) {
        /* already gone */
      }
    }
  } catch (_) {
    return { restored: false };
  }
  if (state && typeof state.stagedCopy === 'string' && state.stagedCopy) {
    try {
      fs.unlinkSync(state.stagedCopy);
    } catch (_) {
      /* already gone; the reconcile sweep covers what this misses */
    }
  }
  try {
    fs.unlinkSync(backupPathOf(target));
  } catch (_) {
    /* backup may never have existed */
  }
  try {
    fs.unlinkSync(flag);
  } catch (_) {
    return { restored: false };
  }
  return { restored: true };
}

/**
 * Every saves folder the toolkit knows: the explicit override plus the
 * live Single/Multi sides. Used only to sweep leftover staged copies.
 */
function knownSavesRoots(opts = {}) {
  const roots = [];
  if (opts.savesRoot) roots.push(opts.savesRoot);
  if (process.env.CIV6_SAVES) roots.push(process.env.CIV6_SAVES);
  for (const mode of ['single', 'multi']) {
    try {
      const side = paths.getSavesDir(mode);
      if (side && side.custom && side.root) roots.push(side.root);
      else if (side && side.root) roots.push(path.dirname(side.root));
    } catch (_) {
      /* defaults unavailable */
    }
  }
  return [...new Set(roots.filter(Boolean))];
}

/**
 * Delete staged launch copies left by an interrupted boot. Only the
 * distinctive prefix matches, so real saves are never touched. Prompt
 * deletion plus this sweep keeps each copy transient, which is why no
 * cloud-sync detection exists: there is nothing long-lived to sync.
 * Never throws; returns the removed paths.
 */
function sweepStaleStagingCopies(roots) {
  const removed = [];
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (!root) continue;
    for (const side of ['Single', 'Multi']) {
      let entries;
      try {
        entries = fs.readdirSync(path.join(root, side), { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.startsWith(STAGING_PREFIX)) continue;
        const full = path.join(root, side, e.name);
        try {
          fs.unlinkSync(full);
          removed.push(full);
        } catch (_) {
          /* a running game may hold it; the next start retries */
        }
      }
    }
  }
  return removed;
}

/**
 * Startup reconcile: a leftover boot flag means a previous run crashed
 * mid-boot, so restore the backup now (the staged copy noted in the flag
 * goes with it). Stale staged copies are swept on the same path whether
 * or not a flag exists. Always safe to call; reports whether it did
 * anything so the caller can log the single line.
 */
function reconcileUnrestoredBoot(appOptions, opts = {}) {
  const target = appOptions || appOptionsPath();
  let flagged = false;
  try {
    flagged = fs.statSync(flagPathOf(target)).isFile();
  } catch (_) {
    flagged = false;
  }
  const stagedRemoved = sweepStaleStagingCopies(knownSavesRoots(opts));
  if (!flagged) {
    if (!stagedRemoved.length) return { reconciled: false };
    console.log('Play-from-save: removed a leftover temporary launch file from an interrupted boot.');
    return { reconciled: false, stagedRemoved };
  }
  const r = restoreAppOptions(target);
  if (r.restored) {
    console.log('Play-from-save: restored AppOptions left over from an interrupted boot.'
      + (stagedRemoved.length ? ' A leftover temporary launch file was removed too.' : ''));
  }
  return { reconciled: r.restored, stagedRemoved };
}

// ---- save listing ---------------------------------------------------------

// How far below a saves root saves nest (Single/auto/prev is 2).
const SAVE_SCAN_DEPTH = 2;

/** Save files under root (walks auto/ subfolders, never reads contents). */
function scanSaveFiles(root) {
  const out = [];
  (function walk(dir, depth) {
    if (depth > SAVE_SCAN_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/\.Civ6(Save|cfg)$/i.test(e.name) && depth < SAVE_SCAN_DEPTH) walk(full, depth + 1);
        continue;
      }
      if (!/\.Civ6Save$/i.test(e.name)) continue;
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (!stat.isFile()) continue;
      out.push({ name: e.name, path: full, rel: path.relative(root, full), mtimeMs: stat.mtimeMs });
    }
  })(root, 0);
  return out;
}

/**
 * Best display title for a save's required-mod entry. Titles are often a
 * localization JSON blob; prefer its en_US text, else the raw string, else
 * null so the caller falls back to the mod id (which always names the mod).
 */
function modDisplayTitle(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const text = raw.trim();
  if (!text.startsWith('{')) return text.length <= 120 ? text : null;
  try {
    const obj = JSON.parse(text);
    const key = Object.keys(obj)[0];
    const rows = obj[key];
    if (!Array.isArray(rows) || !rows.length) return null;
    const en = rows.find((r) => r && r.locale === 'en_US' && r.text) || rows.find((r) => r && r.text);
    return en && en.text ? String(en.text) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Turn and required mods from one parsed save. Accepts the simple-shaped
 * parse ({GAME_TURN: n, MOD_BLOCK_*: [{MOD_ID, MOD_TITLE}]}) and the raw
 * shape ({marker, type, data}) so picker and preflight share it.
 */
function saveInfoOf(parsed) {
  let turn = null;
  const rawTurn = parsed ? parsed.GAME_TURN : null;
  const n = typeof rawTurn === 'number' ? rawTurn : rawTurn && rawTurn.data;
  if (Number.isInteger(n)) turn = n;
  const mods = [];
  const seen = new Set();
  for (const key of Object.keys(parsed || {})) {
    if (!key.startsWith('MOD_BLOCK_')) continue;
    const rows = Array.isArray(parsed[key]) ? parsed[key] : parsed[key] && parsed[key].data;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const rawId = row && (row.MOD_ID === undefined ? row.MOD_ID_2 : row.MOD_ID);
      const id = rawId && typeof rawId === 'object' ? rawId.data : rawId;
      if (typeof id !== 'string' || !id.trim()) continue;
      const norm = normId(id);
      if (seen.has(norm)) continue;
      seen.add(norm);
      const rawTitle = row && (row.MOD_TITLE === undefined ? row.MOD_TITLE_2 : row.MOD_TITLE);
      const title = rawTitle && typeof rawTitle === 'object' ? rawTitle.data : rawTitle;
      mods.push({ id: id.trim(), title: modDisplayTitle(title) || id.trim() });
    }
  }
  return { turn, mods };
}

/**
 * Parse one save file (best effort: unparseable files still list, with
 * parseError instead of turn/mods). parseFn is injectable for tests.
 */
function readSaveInfo(savePath, parseFn) {
  const parse = parseFn || ((buf) => saveParser.parse(buf, { simple: true }).parsed);
  try {
    return { turn: null, mods: [], parseError: null, ...saveInfoOf(parse(fs.readFileSync(savePath))) };
  } catch (e) {
    return { turn: null, mods: [], parseError: e && e.message ? e.message : String(e) };
  }
}

/**
 * Picker rows for one saves folder: name, relative path, age, turn and
 * required mods, newest first. Files that do not parse still list.
 */
function listSaves(savesRoot, opts = {}) {
  return scanSaveFiles(savesRoot)
    .map((f) => ({ ...f, ...readSaveInfo(f.path, opts.parseFn) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

/** Newest autosave across saves roots, by file modification time. */
function findLatestAutosave(roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  let best = null;
  for (const root of list) {
    if (!root) continue;
    for (const f of scanSaveFiles(root)) {
      if (!/auto/i.test(f.name)) continue;
      if (!best || f.mtimeMs > best.mtimeMs) best = f;
    }
  }
  return best;
}

// ---- preflight ------------------------------------------------------------

/**
 * Player-words warning naming every required mod the save needs but the
 * library lacks. Null when nothing is missing: boot may proceed.
 */
function missingModsWarning(missing, saveName) {
  if (!missing.length) return null;
  const named = missing.map((m) => `"${m.title}" (${m.id})`).join(', ');
  const count = missing.length === 1 ? 'a mod that is not installed' : `${missing.length} mods that are not installed`;
  return `The save "${saveName}" needs ${count}: ${named}. ` +
    'The game would start without them and the save may fail to load. ' +
    'Install the missing mods first, or play anyway knowing it may break.';
}

/**
 * Mod ids the game database knows, including official DLC and persona packs
 * that have no folder in the mod library. Read-only, best effort: an
 * unreadable database contributes nothing instead of failing the preflight.
 */
function dbModIds(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare('SELECT ModId AS id FROM Mods').all().map((r) => r.id);
    } finally {
      db.close();
    }
  } catch (_) {
    return [];
  }
}

/**
 * Everything the game could load without a download: scanned mod folders
 * plus database-known content. The union keeps official DLC out of the
 * missing-mod warning, which names only what is truly absent.
 */
function liveLibrary() {
  let scanned = [];
  try {
    scanned = scanMods(paths.getSources());
  } catch (_) {
    scanned = [];
  }
  let dbIds = [];
  try {
    const modsDb = paths.getModsDb();
    if (modsDb.exists) dbIds = dbModIds(modsDb.path);
  } catch (_) {
    dbIds = [];
  }
  return [...scanned, ...dbIds.map((id) => ({ id }))];
}

/**
 * Check a save's required mods against the installed library before
 * booting. installed defaults to a live scan; tests pass a fixed list.
 * opts.knownIds unions extra known ids (e.g. database content in tests).
 */
function preflight(savePath, installed, opts = {}) {
  const info = readSaveInfo(savePath, opts.parseFn);
  const lib = installed || liveLibrary();
  const have = new Set(lib.map((m) => normId(m.id || m.idNorm)));
  for (const id of opts.knownIds || []) have.add(normId(id));
  const missing = info.mods.filter((m) => !have.has(normId(m.id)));
  return {
    save: savePath,
    name: path.basename(savePath),
    turn: info.turn,
    mods: info.mods,
    parseError: info.parseError,
    missing,
    warning: missingModsWarning(missing, path.basename(savePath)),
  };
}

// ---- game exe -------------------------------------------------------------

const GAME_DIR_NAME = "Sid Meier's Civilization VI";
const EXE_BY_VARIANT = { dx11: 'CivilizationVI.exe', dx12: 'CivilizationVI_DX12.exe' };

/** Steam library roots: the registry path plus its extra libraries. */
function steamLibraryRoots(steamPath) {
  const roots = [];
  if (steamPath) roots.push(steamPath);
  for (const vdf of steamPath
    ? [path.join(steamPath, 'steamapps', 'libraryfolders.vdf'),
      path.join(steamPath, 'config', 'libraryfolders.vdf')]
    : []) {
    try {
      const text = fs.readFileSync(vdf, 'utf8');
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/gi)) roots.push(m[1].replace(/\\\\/g, '\\'));
    } catch (_) {
      /* single-library install */
    }
  }
  return [...new Set(roots)];
}

/**
 * Full path to the game exe for a DX variant ('dx12' default). Env
 * CIV6_EXE pins it for tests and relocated installs; otherwise the Steam
 * libraries are searched. Null when not found (never throws).
 */
function findGameExe(variant, opts = {}) {
  const exe = EXE_BY_VARIANT[String(variant || 'dx12').toLowerCase()] || EXE_BY_VARIANT.dx12;
  const pinned = opts.exePath || process.env.CIV6_EXE;
  if (pinned) {
    try {
      if (fs.statSync(pinned).isFile()) return pinned;
    } catch (_) {
      /* pinned but absent */
    }
    return null;
  }
  let steam = null;
  try {
    steam = paths.steamPathFromRegistry();
  } catch (_) {
    steam = null;
  }
  const libs = [...steamLibraryRoots(steam),
    'C:/Program Files (x86)/Steam', 'C:/Program Files/Steam',
    'D:/Steam', 'D:/SteamLibrary', 'E:/SteamLibrary'];
  for (const lib of [...new Set(libs)]) {
    const candidate = path.join(lib, 'steamapps', 'common', GAME_DIR_NAME, 'Base', 'Binaries', 'Win64Steam', exe);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      /* next library */
    }
  }
  return null;
}

// ---- boot pipeline ----------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spawn the game detached so it outlives the toolkit (never hidden). */
function defaultLauncher(exe) {
  const child = spawn(paths.toNativePath(exe), [], { detached: true, stdio: 'ignore' });
  child.unref();
  return Promise.resolve({ exe });
}

/**
 * The saves folder a save lives under, with its Saves-relative path, or
 * null when the save sits outside every known folder. Shared by the plant
 * shape and the staging plan so both agree on the root.
 */
function findSavesRoot(savePath, opts = {}) {
  const candidates = [];
  if (opts.savesRoot) candidates.push(opts.savesRoot);
  if (process.env.CIV6_SAVES) candidates.push(process.env.CIV6_SAVES);
  try {
    const single = paths.getSavesDir('single');
    if (single && single.custom && single.root) candidates.push(single.root);
    else if (single && single.root) candidates.push(path.dirname(single.root));
  } catch (_) {
    /* defaults unavailable */
  }
  try {
    const abs = path.resolve(savePath);
    const parts = abs.split(path.sep);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (parts[i].toLowerCase() === 'saves') {
        candidates.push(parts.slice(0, i + 1).join(path.sep));
        break;
      }
    }
  } catch (_) {
    /* not resolvable */
  }
  for (const root of candidates) {
    if (!root) continue;
    try {
      const rel = path.relative(root, savePath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { root, rel };
    } catch (_) {
      /* next candidate */
    }
  }
  return null;
}

/**
 * Value the game reads: the save below the Saves folder with forward
 * slashes and no leading prefix.
 */
function toPlayNowSaveValue(savePath, opts = {}) {
  const found = findSavesRoot(savePath, opts);
  if (found) {
    return String(found.rel).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  }
  return String(path.basename(savePath)).replace(/\\/g, '/');
}

/**
 * Staging plan for a boot: the game only loads saves one level below a
 * side folder (Single/X), so a deeper save (Single/auto/X) boots through
 * a byte copy staged beside it as Single/ToolkitBoot_X, and the copy's
 * value is planted instead. The original file is never moved or changed.
 */
function stagingPlanFor(savePath, opts = {}) {
  const found = findSavesRoot(savePath, opts);
  if (!found) return { needsStaging: false };
  const segs = String(found.rel).split(/[\\/]/).filter(Boolean);
  if (segs.length <= 2) return { needsStaging: false };
  const side = segs[0];
  const dest = path.join(found.root, side, `${STAGING_PREFIX}${path.basename(savePath)}`);
  return {
    needsStaging: true,
    root: found.root,
    side,
    dest,
    plantedCopy: `${side}/${STAGING_PREFIX}${path.basename(savePath)}`,
  };
}

/**
 * Whether the logs confirm the save loaded. True on a fresh join marker;
 * never throws.
 */
function defaultLoadConfirmed(opts = {}) {
  const sinceMs = opts.loadSinceMs || 0;
  const dirs = [];
  if (opts.logsDir) dirs.push(opts.logsDir);
  if (process.env.CIV6_LOGS_DIR) dirs.unshift(process.env.CIV6_LOGS_DIR);
  try {
    const ld = paths.getLogsDir();
    if (ld && ld.root) dirs.push(ld.root);
  } catch (_) {
    /* ignore */
  }
  try {
    const m = paths.myGamesRoot();
    if (m) dirs.push(path.join(m, 'Logs'));
  } catch (_) {
    /* ignore */
  }
  try {
    const l = paths.localGamesRoot();
    if (l) dirs.push(path.join(l, 'Logs'));
  } catch (_) {
    /* ignore */
  }
  const checks = [
    ['net_message_debug.log', /MultiplayerJoinGameComplete/],
    ['LoadGameViewState.log', /GAMECORE_UNSERIALIZE_GAMESTATE took/],
    ['Lua.log', /OnLoadGameViewStateDone/],
  ];
  for (const dir of [...new Set(dirs.filter(Boolean))]) {
    for (const [name, re] of checks) {
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (sinceMs && st.mtimeMs < sinceMs) continue;
        if (re.test(fs.readFileSync(fp, 'utf8'))) return true;
      } catch (_) {
        /* missing log */
      }
    }
  }
  return false;
}

/**
 * After a successful launch, restore only once the logs confirm the save
 * loaded. On any timeout the plant stays for the next startup reconcile
 * instead of restoring too early. Never throws.
 */
async function waitForGameThenRestore(appOptions, opts = {}) {
  const statusFn = opts.gameStatusFn || gameStatus;
  const wait = opts.sleeper || sleep;
  const interval = opts.pollIntervalMs == null ? 1000 : opts.pollIntervalMs;
  const timeout = opts.pollTimeoutMs == null ? 60000 : opts.pollTimeoutMs;
  const loadTimeout = opts.loadTimeoutMs == null ? 10 * 60 * 1000 : opts.loadTimeoutMs;
  const bootMs = Date.now();
  const confirmedFn = opts.loadConfirmedFn
    || (() => defaultLoadConfirmed({ ...opts, loadSinceMs: bootMs }));
  const started = Date.now();
  for (;;) {
    let running = false;
    try {
      running = (await statusFn()).running;
    } catch (_) {
      running = false;
    }
    if (running) break;
    if (Date.now() - started > timeout) {
      console.log('Play-from-save: the game was not seen starting, AppOptions restores on the next toolkit start.');
      return { restored: false, deferred: true };
    }
    await wait(interval);
  }
  const loadStart = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await confirmedFn();
    } catch (_) {
      ok = false;
    }
    if (ok) break;
    if (Date.now() - loadStart > loadTimeout) {
      console.log('Play-from-save: load not yet confirmed, AppOptions stays planted and restores on the next toolkit start.');
      return { restored: false, deferred: true };
    }
    await wait(interval);
  }
  const r = restoreAppOptions(appOptions);
  return { restored: r.restored, deferred: !r.restored };
}

/**
 * One shared boot: refuse while running, preflight required mods, back up
 * AppOptions, plant the PlayNowSave, launch, then restore only after the
 * logs confirm the load. Deeper saves boot through a staged byte copy,
 * deleted with the restore. Missing mods warn BEFORE anything is written
 * unless proceedWithoutMods is set (see reconcileUnrestoredBoot).
 */
async function bootSave(savePath, opts = {}) {
  let isFile = false;
  try {
    isFile = fs.statSync(savePath).isFile();
  } catch (_) {
    isFile = false;
  }
  if (!isFile) return { ok: false, code: 'no-save', error: `That save was not found: ${path.basename(savePath)}` };

  const statusFn = opts.gameStatusFn || gameStatus;
  const game = await statusFn();
  if (game.running) return { ok: false, code: 'civ6-running', error: REFUSAL_RUNNING };

  const pre = preflight(savePath, opts.installed, { parseFn: opts.parseFn, knownIds: opts.knownIds });
  if (pre.missing.length && !opts.proceedWithoutMods) {
    return { ok: false, code: 'missing-mods', warning: pre.warning, missing: pre.missing, save: savePath, turn: pre.turn };
  }

  let exe = opts.exePath || process.env.CIV6_EXE || findGameExe(opts.variant);
  try {
    if (!exe || !fs.statSync(exe).isFile()) exe = null;
  } catch (_) {
    exe = null;
  }
  if (!exe) {
    const want = EXE_BY_VARIANT[String(opts.variant || 'dx12').toLowerCase()] || EXE_BY_VARIANT.dx12;
    return { ok: false, code: 'no-exe', error: `The game (${want}) was not found in the Steam library. Set CIV6_EXE to its full path, then try again.` };
  }

  const appOptions = opts.appOptions || appOptionsPath();
  backupAppOptions(appOptions, opts);
  const plan = stagingPlanFor(savePath, opts);
  let planted;
  if (plan.needsStaging) {
    let taken = false;
    try {
      taken = fs.statSync(plan.dest).isFile();
    } catch (_) {
      taken = false;
    }
    if (taken) {
      restoreAppOptions(appOptions);
      return { ok: false, code: 'staging-collision', error: stagingCollisionError(path.basename(savePath), plan.plantedCopy), save: savePath };
    }
    try {
      fs.copyFileSync(savePath, plan.dest, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      restoreAppOptions(appOptions);
      if (e && e.code === 'EEXIST') {
        return { ok: false, code: 'staging-collision', error: stagingCollisionError(path.basename(savePath), plan.plantedCopy), save: savePath };
      }
      return { ok: false, code: 'staging-failed', error: `The save "${path.basename(savePath)}" could not be prepared for launch. Nothing was changed - try again.`, save: savePath };
    }
    noteStagedCopy(appOptions, plan.dest);
    planted = plan.plantedCopy;
  } else {
    planted = toPlayNowSaveValue(savePath, opts);
  }
  writePlayNowSave(appOptions, planted);

  if (opts.dryRun || process.env.CIV6_NO_BOOT) {
    restoreAppOptions(appOptions);
    return { ok: true, dryRun: true, save: savePath, planted, exe, turn: pre.turn, warning: pre.warning, restored: true };
  }

  const launcher = opts.launcherFn || defaultLauncher;
  let launched = false;
  let launchError = null;
  try {
    await launcher(exe);
    launched = true;
  } catch (e) {
    launchError = e;
  } finally {
    if (!launched) restoreAppOptions(appOptions);
  }
  if (!launched) {
    return { ok: false, code: 'launch-failed', error: launchError && launchError.message ? launchError.message : 'The game could not be started.' };
  }
  const done = await waitForGameThenRestore(appOptions, opts);
  return { ok: true, save: savePath, planted, exe, turn: pre.turn, warning: pre.warning, restored: done.restored, deferred: !!done.deferred };
}

/**
 * A1, play-latest: boot the newest autosave across the saves folders with
 * no picker. mode narrows to one side ('single' or 'multi').
 */
async function playLatest(opts = {}) {
  const sides = [];
  const mode = String(opts.mode || 'both').toLowerCase();
  if (mode !== 'multi') sides.push(paths.getSavesDir('single'));
  if (mode !== 'single') sides.push(paths.getSavesDir('multi'));
  const latest = findLatestAutosave(sides.filter((s) => s.exists).map((s) => s.root));
  if (!latest) return { ok: false, code: 'no-saves', error: NO_SAVES };
  return bootSave(latest.path, opts);
}

module.exports = {
  REFUSAL_RUNNING,
  STAGING_PREFIX,
  appOptionsPath,
  backupAppOptions,
  noteStagedCopy,
  writePlayNowSave,
  readPlayNowSave,
  setPlayNowSave,
  toPlayNowSaveValue,
  stagingPlanFor,
  sweepStaleStagingCopies,
  defaultLoadConfirmed,
  waitForGameThenRestore,
  restoreAppOptions,
  reconcileUnrestoredBoot,
  listSaves,
  findLatestAutosave,
  readSaveInfo,
  saveInfoOf,
  modDisplayTitle,
  preflight,
  missingModsWarning,
  findGameExe,
  dbModIds,
  liveLibrary,
  bootSave,
  playLatest,
};
