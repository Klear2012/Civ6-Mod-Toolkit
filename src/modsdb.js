'use strict';

// Access to the game's Mods.sqlite, which records which mods are enabled.
// Schema (user_version 24) as observed:
//   ModGroups(ModGroupRowId, Name, CanDelete, Selected, SortIndex)
//       one row per mod group; Selected=1 marks the active group
//   ModGroupItems(ModGroupRowId, ModRowId, Disabled)
//       Disabled=1 -> mod is off in that group
//   Mods(ModRowId, ScannedFileRowId, ModId, Version) + ScannedFiles(Path)
//   ModRelationships(ModRowId, OtherModId, Relationship, OtherModTitle)
//       Relationship: Dependency | Block | Reference | ReverseReference
// ModRowId can change when the game rescans, so everything here keys by ModId.
//
// Uses Node's built-in node:sqlite (Node 22.5+). On older Node the reader
// reports an error instead of crashing, and the rest of the app keeps working.

const fs = require('fs');
const path = require('path');
const { normId } = require('./modinfo');
const { backupFile } = require('./editor');

let DatabaseSync = null;
let loadError = null;
try {
  // Silence the one-time "SQLite is an experimental feature" warning (Node 22).
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...rest));
  ({ DatabaseSync } = require('node:sqlite'));
  process.emitWarning = origEmit;
} catch (e) {
  loadError = `Reading the mod database needs Node.js 22.5 or newer (you have ${process.version}).`;
}

const KEEP_BACKUPS = 10;

// Classify a ScannedFiles.Path. DLC / base game paths are stored relative to
// the game's install folder; user mods are absolute.
function classifyPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (/\/steamapps\/workshop\/content\//i.test(s)) return 'workshop';
  if (/^(\.\.\/)+DLC\//i.test(s)) return 'dlc';
  if (/^(\.\.\/)+Base\//i.test(s)) return 'base';
  return 'local';
}

function activeGroupOf(db) {
  const groups = db.prepare('SELECT ModGroupRowId AS id, Name AS name, Selected AS selected FROM ModGroups ORDER BY SortIndex, ModGroupRowId').all()
    .map((g) => ({ id: g.id, name: g.name, selected: !!g.selected }));
  return { groups, active: groups.find((g) => g.selected) || groups[0] || null };
}

// Last-resort readable name for an unresolved key, possibly JSON-wrapped:
// '{"LOC_RULERS_OF_CHINA_MOD_TITLE":[]}' -> 'Rulers of China'.
const KNOWN_NAMES = { EXPANSION1: 'Expansion: Rise and Fall', EXPANSION2: 'Expansion: Gathering Storm' };
function prettyName(s) {
  const m = String(s || '').match(/LOC_[A-Z0-9_]+/i);
  if (!m) return s;
  const key = m[0].replace(/^LOC_/i, '').replace(/_MOD_TITLE$/i, '').toUpperCase();
  if (KNOWN_NAMES[key]) return KNOWN_NAMES[key];
  const words = m[0].replace(/^LOC_/i, '').replace(/_(MOD_)?(TITLE|NAME)$/i, '').replace(/(^|_)MOD(_|$)/gi, '$1$2')
    .split('_').filter(Boolean).map((w) => w.toLowerCase());
  const small = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'on']);
  return words.map((w, i) => (i > 0 && small.has(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ') || s;
}

// SQL for a ModProperties row's text: the mod's own English text for the tag,
// else the tag's English text from any mod, else the raw value.
function resolved(alias) {
  return `COALESCE(
      (SELECT Text FROM LocalizedText WHERE ModRowId = ${alias}.ModRowId AND Tag = ${alias}.Value AND Locale = 'en_US'),
      (SELECT Text FROM LocalizedText WHERE Tag = ${alias}.Value AND Locale = 'en_US' LIMIT 1),
      ${alias}.Value)`;
}

// A resolved text that is still a bare LOC_ key (or JSON-wrapped one) is useless to show.
function usable(text) {
  return text && !/LOC_[A-Z0-9_]+/i.test(text) ? text : null;
}

// Display name: the mod's own English text, else the same LOC tag's English
// text from any mod (DLC titles are often stored under another row), else the
// title other mods use when they reference it, else the raw value.
const MODS_SQL = `
  SELECT m.ModId AS modId, s.Path AS path, gi.Disabled AS disabled,
    COALESCE(
      (SELECT Text FROM LocalizedText WHERE ModRowId = m.ModRowId AND Tag = p.Value AND Locale = 'en_US'),
      (SELECT Text FROM LocalizedText WHERE Tag = p.Value AND Locale = 'en_US' LIMIT 1),
      (SELECT OtherModTitle FROM ModRelationships WHERE lower(OtherModId) = lower(m.ModId)
         AND OtherModTitle IS NOT NULL AND instr(OtherModTitle, 'LOC_') = 0 LIMIT 1),
      p.Value) AS name,
    (SELECT ${resolved('t')} FROM ModProperties t WHERE t.ModRowId = m.ModRowId AND t.Name = 'Teaser') AS teaser,
    (SELECT Value FROM ModProperties WHERE ModRowId = m.ModRowId AND Name = 'ShowInBrowser') AS showInBrowser
  FROM Mods m
  JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId
  LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name'
  LEFT JOIN ModGroupItems gi ON gi.ModRowId = m.ModRowId AND gi.ModGroupRowId = ?`;

const REL_SQL = `
  SELECT m.ModId AS modId, r.OtherModId AS otherId, r.Relationship AS rel, r.OtherModTitle AS otherTitle
  FROM ModRelationships r JOIN Mods m ON m.ModRowId = r.ModRowId
  WHERE r.Relationship IN ('Dependency', 'Block')`;

// -> { ok, error?, activeGroup, groups:[], mods:[{ modId, idNorm, name, path,
//      source, disabled, teaser, hidden, requires:[{id,title}], blocks:[{id,title}] }] }
// disabled is null when the mod has no row in the active group.
function readModState(dbPath) {
  if (!DatabaseSync) return { ok: false, error: loadError, groups: [], mods: [] };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const { groups, active } = activeGroupOf(db);
    const rels = new Map();
    for (const r of db.prepare(REL_SQL).all()) {
      const k = normId(r.modId);
      if (!rels.has(k)) rels.set(k, { requires: [], blocks: [] });
      const entry = { id: normId(r.otherId), title: prettyName(r.otherTitle || r.otherId) };
      rels.get(k)[r.rel === 'Dependency' ? 'requires' : 'blocks'].push(entry);
    }
    const mods = db.prepare(MODS_SQL).all(active ? active.id : -1).map((r) => {
      const idNorm = normId(r.modId);
      const rel = rels.get(idNorm) || { requires: [], blocks: [] };
      return {
        modId: r.modId,
        idNorm,
        name: prettyName(r.name) || r.modId,
        path: r.path,
        source: classifyPath(r.path),
        disabled: r.disabled == null ? null : !!r.disabled,
        teaser: usable(r.teaser),
        hidden: r.showInBrowser === 'AlwaysHidden',
        requires: rel.requires,
        blocks: rel.blocks,
      };
    });
    return { ok: true, activeGroup: active, groups, mods };
  } catch (e) {
    return { ok: false, error: `Could not read the mod database: ${e.message}`, groups: [], mods: [] };
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

// Everything the details panel shows for one mod, or null if it isn't in the
// database: { version, properties:{Name: text}, components:{Type: n},
// settings:{Type: n}, fileCount }.
function readModDetails(dbPath, modId) {
  if (!DatabaseSync) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const mod = db.prepare('SELECT ModRowId AS rowId, Version AS version FROM Mods WHERE lower(ModId) = lower(?)').get(String(modId));
    if (!mod) return null;
    const properties = {};
    for (const r of db.prepare(`SELECT p.Name AS name, ${resolved('p')} AS text FROM ModProperties p WHERE p.ModRowId = ?`).all(mod.rowId)) {
      const t = usable(r.text);
      if (t != null) properties[r.name] = t;
    }
    const counts = (sql) => Object.fromEntries(db.prepare(sql).all(mod.rowId).map((r) => [r.type, r.n]));
    return {
      version: mod.version,
      properties,
      components: counts('SELECT ComponentType AS type, count(*) AS n FROM Components WHERE ModRowId = ? GROUP BY 1'),
      settings: counts('SELECT SettingType AS type, count(*) AS n FROM Settings WHERE ModRowId = ? GROUP BY 1'),
      fileCount: db.prepare('SELECT count(*) AS n FROM ModFiles WHERE ModRowId = ?').get(mod.rowId).n,
    };
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

// Keep only the newest KEEP_BACKUPS "Mods.sqlite.bak-YYYYMMDD-HHMMSS" copies.
// Other backups (e.g. hand-made ones) are never touched.
function pruneBackups(dbPath) {
  const dir = path.dirname(dbPath);
  const re = new RegExp(`^${path.basename(dbPath).replace(/\./g, '\\.')}\\.bak-\\d{8}-\\d{6}$`);
  const baks = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
  for (const f of baks.slice(0, Math.max(0, baks.length - KEEP_BACKUPS))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
  }
}

// The shared write path for every change to Mods.sqlite: back the file up, run
// `fn(db)` in one transaction, check the database, and read back what was
// written. If anything fails after the commit the backup is put back; if it
// failed before, the redundant backup is removed. `fn` throws on any problem it
// finds - that is what triggers the rollback/restore.
function mutateDb(dbPath, fn) {
  const backupPath = backupFile(dbPath);
  let db;
  let committed = false;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = fn(db);
      db.exec('COMMIT');
      committed = true;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    const check = db.prepare('PRAGMA quick_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error('database check failed after saving');

    db.close();
    db = null;
    pruneBackups(dbPath);
    return { result, backupPath };
  } catch (e) {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
    if (committed) {
      // Something went wrong after writing: put the untouched copy back.
      try { fs.copyFileSync(backupPath, dbPath); e.message += ' (the database was restored from the backup)'; }
      catch (_) { e.message += ` (restore failed; your backup is ${backupPath})`; }
    } else {
      // Nothing was written, so the backup is just a duplicate.
      try { fs.unlinkSync(backupPath); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}

function requireDb() {
  if (!DatabaseSync) throw new Error(loadError);
}

// changes: [{ modId, enabled }]. Caller must make sure the game is closed.
// Backs up the database, applies all changes in one transaction to the active
// mod group, then verifies; on any failure the backup is put back.
function applyChanges(dbPath, changes) {
  requireDb();
  if (!Array.isArray(changes) || !changes.length) throw new Error('no changes');

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const { active } = activeGroupOf(db);
    if (!active) throw new Error('the mod database has no mod group');

    const rowIds = new Map(db.prepare('SELECT ModId, ModRowId FROM Mods').all().map((r) => [normId(r.ModId), r.ModRowId]));
    const update = db.prepare('UPDATE ModGroupItems SET Disabled = ? WHERE ModGroupRowId = ? AND ModRowId = ?');

    for (const c of changes) {
      const rowId = rowIds.get(normId(c.modId));
      if (rowId == null) throw new Error(`mod ${c.modId} is not in the game's database yet (start the game once)`);
      const n = update.run(c.enabled ? 0 : 1, active.id, rowId).changes;
      if (n !== 1) throw new Error(`mod ${c.modId} is not part of the active mod group`);
    }

    // Read back what we wrote.
    const read = db.prepare('SELECT Disabled FROM ModGroupItems WHERE ModGroupRowId = ? AND ModRowId = ?');
    for (const c of changes) {
      const row = read.get(active.id, rowIds.get(normId(c.modId)));
      if (!row || !!row.Disabled === !!c.enabled) throw new Error(`verification failed for mod ${c.modId}`);
    }
    return { changed: changes.length, group: active };
  });
  return { backupPath, ...result };
}

// ---------------------------------------------------------------------------
// Mod groups (player profiles)
//
// A profile is a ModGroups row plus its ModGroupItems rows. The game shows them
// under Additional Content > Mod Groups. Custom groups are created with
// SortIndex 100, which is what the game itself uses.
// ---------------------------------------------------------------------------

const GROUPS_SQL = `
  SELECT g.ModGroupRowId AS id, g.Name AS name, g.CanDelete AS canDelete,
    g.Selected AS selected, g.SortIndex AS sortIndex,
    (SELECT count(*) FROM ModGroupItems i WHERE i.ModGroupRowId = g.ModGroupRowId) AS total,
    (SELECT count(*) FROM ModGroupItems i WHERE i.ModGroupRowId = g.ModGroupRowId AND i.Disabled = 0) AS enabled
  FROM ModGroups g
  ORDER BY g.SortIndex, g.ModGroupRowId`;

function readGroups(db) {
  return db.prepare(GROUPS_SQL).all().map((r) => ({
    id: r.id,
    name: r.name,
    canDelete: !!r.canDelete,
    selected: !!r.selected,
    sortIndex: r.sortIndex,
    total: r.total,
    enabled: r.enabled,
  }));
}

// One group by id, with its enabled/total counts. Throws when it isn't there.
function requireGroup(db, id) {
  const g = readGroups(db).find((x) => x.id === Number(id));
  if (!g) throw new Error('that mod group no longer exists');
  return g;
}

// Names are free-form; only emptiness and a sane length are rejected.
function cleanName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw new Error('the profile needs a name');
  if (n.length > 100) throw new Error('the profile name is too long (100 characters at most)');
  return n;
}

// Exactly one group must be selected - the game reads Selected to know which
// one it is using.
function selectGroup(db, id) {
  db.prepare('UPDATE ModGroups SET Selected = 0 WHERE Selected <> 0').run();
  const r = db.prepare('UPDATE ModGroups SET Selected = 1 WHERE ModGroupRowId = ?').run(Number(id));
  if (r.changes !== 1) throw new Error('that mod group no longer exists');
  const n = db.prepare('SELECT count(*) AS n FROM ModGroups WHERE Selected = 1').get().n;
  if (n !== 1) throw new Error('failed to select the mod group');
}

// A new profile with every known mod present but turned off, so it can be
// toggled right away (a group with no rows can't be changed at all).
function fillGroupDisabled(db, id) {
  db.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) SELECT ?, ModRowId, 1 FROM Mods').run(Number(id));
}

function copyGroupItems(db, fromId, toId) {
  db.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) SELECT ?, ModRowId, Disabled FROM ModGroupItems WHERE ModGroupRowId = ?')
    .run(Number(toId), Number(fromId));
}

function insertGroup(db, name) {
  const r = db.prepare('INSERT INTO ModGroups (Name, CanDelete, Selected, SortIndex) VALUES (?, 1, 0, 100)').run(cleanName(name));
  return r.lastInsertRowid;
}

function itemCount(db, id) {
  return db.prepare('SELECT count(*) AS n FROM ModGroupItems WHERE ModGroupRowId = ?').get(Number(id)).n;
}

// Reads every profile, plus the active one. Same read-only access as
// readModState: a failure is reported, not thrown.
function listGroups(dbPath) {
  if (!DatabaseSync) return { ok: false, error: loadError, groups: [], active: null };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const groups = readGroups(db);
    return { ok: true, groups, active: groups.find((g) => g.selected) || null };
  } catch (e) {
    return { ok: false, error: `Could not read the mod database: ${e.message}`, groups: [], active: null };
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

// Create an empty profile (everything off) and make it the active one.
function createGroup(dbPath, name) {
  requireDb();
  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const id = insertGroup(db, name);
    fillGroupDisabled(db, id);
    selectGroup(db, id);
    const group = requireGroup(db, id);
    const total = db.prepare('SELECT count(*) AS n FROM Mods').get().n;
    if (group.total !== total || group.enabled !== 0) throw new Error('the new profile was not created correctly');
    return { group, mods: total };
  });
  return { backupPath, ...result };
}

// Copy a profile's mods, under a new name, and make it the active one.
function duplicateGroup(dbPath, id, name) {
  requireDb();
  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const source = requireGroup(db, id);
    const newId = insertGroup(db, name);
    copyGroupItems(db, source.id, newId);
    selectGroup(db, newId);
    const group = requireGroup(db, newId);
    if (group.total !== source.total || group.enabled !== source.enabled) throw new Error('the profile was not copied correctly');
    return { group, from: source };
  });
  return { backupPath, ...result };
}

function renameGroup(dbPath, id, name) {
  requireDb();
  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const group = requireGroup(db, id);
    db.prepare('UPDATE ModGroups SET Name = ? WHERE ModGroupRowId = ?').run(cleanName(name), group.id);
    const after = requireGroup(db, group.id);
    if (after.name !== cleanName(name)) throw new Error('the profile was not renamed');
    return { group: after };
  });
  return { backupPath, ...result };
}

// Delete a profile and its mods. The built-in group and the last remaining group
// can't be deleted. Deleting the active one switches to `fallbackId` when given,
// otherwise to the built-in group, otherwise to the oldest one left.
function deleteGroup(dbPath, id, fallbackId) {
  requireDb();
  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const group = requireGroup(db, id);
    if (!group.canDelete) throw new Error('the Default profile cannot be deleted');
    const remaining = readGroups(db).filter((g) => g.id !== group.id);
    if (!remaining.length) throw new Error('this is your only profile, so it cannot be deleted');
    if (group.selected) {
      const fallback = (fallbackId != null && remaining.find((g) => g.id === Number(fallbackId)))
        || remaining.find((g) => !g.canDelete)
        || remaining[0];
      selectGroup(db, fallback.id);
    }
    db.prepare('DELETE FROM ModGroupItems WHERE ModGroupRowId = ?').run(group.id);
    const del = db.prepare('DELETE FROM ModGroups WHERE ModGroupRowId = ?').run(group.id);
    if (del.changes !== 1) throw new Error('the profile was not deleted');
    const groups = readGroups(db);
    if (groups.some((g) => g.id === group.id)) throw new Error('the profile was not deleted');
    if (itemCount(db, group.id) !== 0) throw new Error('the profile was not emptied');
    return { deleted: group.name, active: groups.find((g) => g.selected) || null, groups };
  });
  return { backupPath, ...result };
}

function activateGroup(dbPath, id) {
  requireDb();
  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const group = requireGroup(db, id);
    selectGroup(db, group.id);
    const active = readGroups(db).find((g) => g.selected);
    if (!active || active.id !== group.id) throw new Error('the profile was not activated');
    return { active };
  });
  return { backupPath, ...result };
}

// ---------------------------------------------------------------------------
// Export / import
//
// A profile file lists the mods by their stable ModId (never ModRowId, which
// changes when the game rescans) with the state they had in that profile.
// Importing always creates a new profile: it never overwrites an existing one.
// ---------------------------------------------------------------------------

const EXPORT_TOOLKIT = 'civ6-mod-toolkit';
const EXPORT_VERSION = 1;
const MAX_IMPORT_MODS = 10000;

// One profile as a portable object: every mod the profile lists, on or off.
function exportGroup(dbPath, id) {
  if (!DatabaseSync) throw new Error(loadError);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const group = readGroups(db).find((g) => g.id === Number(id));
    if (!group) throw new Error('that mod group no longer exists');
    const mods = db.prepare(`
      SELECT m.ModId AS modId, i.Disabled AS disabled
      FROM ModGroupItems i JOIN Mods m ON m.ModRowId = i.ModRowId
      WHERE i.ModGroupRowId = ?
      ORDER BY m.ModId`).all(group.id)
      .map((r) => ({ modId: r.modId, enabled: !r.disabled }));
    return { toolkit: EXPORT_TOOLKIT, version: EXPORT_VERSION, name: group.name, exportedAt: new Date().toISOString(), mods };
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

// "Name", "Name (2)", "Name (3)" ... so an import never silently replaces one.
function unusedName(db, wanted) {
  const taken = new Set(db.prepare('SELECT Name AS name FROM ModGroups').all().map((r) => String(r.name).toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${wanted} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${wanted} (${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')})`;
}

// Create a new profile from an exported file and make it the active one. Mods
// the game doesn't know (uninstalled, or from another installation) are skipped
// and reported rather than failing the whole import.
function importGroup(dbPath, data) {
  requireDb();
  if (!data || typeof data !== 'object') throw new Error('that file is not a profile');
  if (!Array.isArray(data.mods)) throw new Error('that file has no list of mods');
  if (data.mods.length > MAX_IMPORT_MODS) throw new Error('that file lists too many mods');
  // Leave room for the " (2)" suffix unusedName may add.
  const wanted = String(data.name == null ? '' : data.name).trim().slice(0, 90) || 'Imported profile';

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const known = new Map(db.prepare('SELECT ModId, ModRowId FROM Mods').all().map((r) => [normId(r.ModId), r.ModRowId]));
    const id = insertGroup(db, unusedName(db, wanted));
    fillGroupDisabled(db, id);
    const setFlag = db.prepare('UPDATE ModGroupItems SET Disabled = ? WHERE ModGroupRowId = ? AND ModRowId = ?');
    const skipped = [];
    let imported = 0;
    for (const m of data.mods) {
      const modId = m && typeof m.modId === 'string' ? m.modId : null;
      const rowId = modId ? known.get(normId(modId)) : null;
      if (rowId == null) { if (modId) skipped.push(modId); continue; }
      setFlag.run(m.enabled ? 0 : 1, id, rowId);
      imported++;
    }
    selectGroup(db, id);
    const group = requireGroup(db, id);
    if (group.total !== known.size) throw new Error('the profile was not imported correctly');
    return { group, imported, skipped };
  });
  return { backupPath, ...result };
}

// ---------------------------------------------------------------------------
// Registering a mod the game has not scanned yet
//
// The game normally owns this: on launch it walks the mod folders and writes
// ScannedFiles / Mods / ModProperties / ModGroupItems rows. Until it has, a mod
// on disk has no row and cannot be switched on. This writes the same rows, so
// a newly subscribed mod can be used without starting the game.
//
// Observed on a real database (2026-09-27):
//   - ScannedFiles.Path is absolute, uses forward slashes even on Windows, and
//     points at the .modinfo file itself rather than its folder.
//   - ScannedFiles.LastWriteTime is a Windows FILETIME (100ns ticks since 1601)
//     equal to the .modinfo's mtime. It does not fit in a JS number, so it is
//     always read back as TEXT.
//   - Mods.Version is the version= attribute of the <Mod> tag.
//   - The descriptive ModProperties (Name, Description, Teaser, Authors,
//     CompatibleVersions) are copied out of the .modinfo; without a Name the
//     mod is listed by its raw GUID.
// What the game does NOT do here is record ModFiles/Components/Settings - those
// say which files the mod contributes. See FINDINGS.md for what that means.
// ---------------------------------------------------------------------------

const MAX_REGISTER_MODS = 2000;

// .modinfo -> { id, version, properties }. Every <Properties> child becomes a
// ModProperties row, which is what the game does - a hardcoded list of known
// fields would silently drop the rest (Created, AffectsSavedGames,
// SubscriptionID, ...). Name matters most: without it the mod manager shows
// the mod by its raw GUID.
function readModinfoMeta(file) {
  const fs = require('fs');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    return null;
  }
  const tag = (text.match(/<Mod\b[^>]*>/) || [''])[0];
  const id = (tag.match(/\bid\s*=\s*"([^"]+)"/i) || [])[1];
  if (!id) return null;
  const version = Number((tag.match(/\bversion\s*=\s*"?(\d+)"?/i) || [])[1] || 1);
  // The mod's own <Properties> block, not any nested action properties.
  const own = xmlSections(text, 'Properties')[0] || '';
  const properties = {};
  for (const m of own.matchAll(/<([A-Za-z][A-Za-z0-9]*)>([\s\S]*?)<\/\1>/g)) {
    properties[m[1]] = m[2].trim();
  }
  return { id, version: Number.isFinite(version) && version > 0 ? version : 1, properties };
}

// The game's ScannedFiles.LastWriteTime is a Windows FILETIME - 100-nanosecond
// ticks since 1601-01-01 - and it holds the file's *full* mtime precision.
// A value rounded to milliseconds reads as a changed file, which makes the game
// rescan the mod and rebuild its profile membership, undoing a profile toggle
// written before the first launch. So take the nanosecond mtime: Node exposes it
// through statSync(..., { bigint: true }).
const FILETIME_EPOCH_TICKS = 116444736000000000n; // 1601-01-01 to 1970-01-01
function fileTimeOf(file) {
  const st = require('fs').statSync(file, { bigint: true });
  return st.mtimeNs / 100n + FILETIME_EPOCH_TICKS;
}

// Forward slashes, and the casing Windows actually has on disk. A Steam
// library path read from the registry can be all lower case.
function canonicalPath(file) {
  const fs = require('fs');
  try {
    return fs.realpathSync.native(file).split('\\').join('/');
  } catch (_) {
    return file.split('\\').join('/');
  }
}

// ---- .modinfo parsing ------------------------------------------------------
//
// Everything the game records about a mod comes out of the .modinfo, so a mod
// can be registered without the game scanning it. Verified against 380 real
// mods (2026-09-27):
//   ModFiles          <- <Files>/<File>, in order. Not a folder listing: 69 mods
//                        have files on disk that the game does not record.
//   Components        <- one per action element in <InGameActions>, in order,
//                        and Settings likewise from <FrontEndActions>. Actions
//                        may carry criteria="..." and some carry no id at all.
//   ComponentProperties <- the action's own <Properties> children (LoadOrder,
//                        LuaContext, LuaReplace, ...)
//   ComponentFiles    <- the action's <File> children only, Priority 0. An
//                        action with no <File> (e.g. ReplaceUIScript) gets none,
//                        even though it names a Lua file to replace.
//   Criteria          <- <ActionCriteria>/<Criteria id>, one Criterion row per
//                        condition element, its text stored as a 'Value'
//     property.
// These are deliberately simple regexes over consistent, machine-written XML,
// the same approach modinfo.js already takes.

// Every <name>...</name> block, in document order.
function xmlSections(text, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

// Direct <Tag>value</Tag> children of a block.
function xmlFields(block, ...names) {
  const out = {};
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    if (m) out[name] = m[1].trim();
  }
  return out;
}

// The action elements inside <InGameActions>/<FrontEndActions>. An element may
// carry extra attributes (criteria="Expansion1") and may have no id.
function xmlActions(blocks) {
  const out = [];
  for (const block of blocks) {
    const re = /<([A-Za-z][A-Za-z0-9]*)\s+([^>]*?)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(block))) {
      const attrs = m[2] || '';
      const id = (attrs.match(/\bid\s*=\s*"([^"]*)"/i) || [])[1] || null;
      const criteria = (attrs.match(/\bcriteria\s*=\s*"([^"]*)"/i) || [])[1] || null;
      const body = m[3] || '';
      out.push({
        type: m[1],
        id,
        criteria,
        // An action's own <Properties> block holds LoadOrder and friends; the
        // <File> children are what it contributes.
        properties: xmlSections(body, 'Properties').flatMap((b) => [
          ...b.matchAll(/<([A-Za-z][A-Za-z0-9]*)>([\s\S]*?)<\/\1>/g),
        ]).map((x) => ({ name: x[1], value: x[2].trim() })),
        // <File> may carry attributes - `<File priority="2">` is common - and a
        // regex for a bare <File> silently drops those files, losing their
        // links entirely. The priority itself is not copied: the game writes 0
        // for every link where the two disagree, which was every disagreement
        // seen across 6144 real links.
        files: [...body.matchAll(/<File\b[^>]*>([\s\S]*?)<\/File>/g)].map((x) => x[1].trim())
          .filter(Boolean),
      });
    }
  }
  return out;
}

// <ActionCriteria>/<Criteria id="X"> each holding condition elements. The
// condition's text is stored as a 'Value' property on the Criterion row.
function xmlCriteria(text) {
  const out = [];
  for (const block of xmlSections(text, 'ActionCriteria')) {
    const re = /<Criteria\b([^>]*)>([\s\S]*?)<\/Criteria>/g;
    let m;
    while ((m = re.exec(block))) {
      const attrs = m[1] || '';
      out.push({
        id: (attrs.match(/\bid\s*=\s*"([^"]*)"/i) || [])[1] || null,
        any: /(^|\s)any\s*=\s*"(1|true)"/i.test(attrs) ? 1 : 0,
        conditions: [...m[2].matchAll(/<([A-Za-z][A-Za-z0-9]*)([^>]*)>([\s\S]*?)<\/\1>/g)].map((c) => ({
          type: c[1],
          inverse: /(^|\s)inverse\s*=\s*"(1|true)"/i.test(c[2] || '') ? 1 : 0,
          value: c[3].trim(),
        })),
      });
    }
  }
  return out;
}

// <Dependencies><Mod id="..." title="..." /></Dependencies> - the mod's own
// requirement, stored as a ModRelationships row of type 'Dependency'. The
// element is self-closing, so it has to be matched without a closing tag.
function xmlDependencies(text) {
  return xmlSections(text, 'Dependencies').flatMap((block) =>
    [...block.matchAll(/<Mod\b([^>]*?)\/?>/g)].map((m) => {
      const attrs = m[1] || '';
      return {
        id: (attrs.match(/\bid\s*=\s*"([^"]+)"/i) || [])[1] || null,
        title: (attrs.match(/\btitle\s*=\s*"([^"]*)"/i) || [])[1] || null,
      };
    })).filter((d) => d.id);
}

// A .modinfo read in full: everything the game's registration is derived from.
function parseModinfo(file) {
  const fs = require('fs');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    return null;
  }
  const meta = readModinfoMeta(file);
  if (!meta) return null;
  return {
    ...meta,
    files: xmlSections(text, 'Files').flatMap((b) => [...b.matchAll(/<File\b[^>]*>([\s\S]*?)<\/File>/g)].map((x) => x[1].trim()))
      .filter(Boolean),
    inGame: xmlActions(xmlSections(text, 'InGameActions')),
    frontEnd: xmlActions(xmlSections(text, 'FrontEndActions')),
    criteria: xmlCriteria(text),
    dependencies: xmlDependencies(text),
  };
}

function registerMod(db, file, activeGroupId, enabled = true) {
  const fs = require('fs');
  const meta = readModinfoMeta(file);
  if (!meta) throw new Error('no mod id in the .modinfo');
  // The game stores forward slashes even on Windows, and the path with the
  // casing the filesystem really has - a Steam library found via the registry
  // can come out as "d:\steam", which is not what the game records.
  const rel = canonicalPath(file);
  const mtime = fileTimeOf(file);

  const seen = db.prepare('SELECT ScannedFileRowId FROM ScannedFiles WHERE Path = ?').get(rel);
  let fileRowId = seen && seen.ScannedFileRowId;
  if (fileRowId) {
    db.prepare('UPDATE ScannedFiles SET LastWriteTime = ? WHERE ScannedFileRowId = ?').run(mtime, fileRowId);
  } else {
    fileRowId = db.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, ?)').run(rel, mtime).lastInsertRowid;
  }

  const known = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(meta.id);
  const isNew = !known;
  const modRowId = isNew
    ? db.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, ?)').run(fileRowId, meta.id, meta.version).lastInsertRowid
    : known.ModRowId;

  // Only describe a mod we just created; never overwrite what the game wrote.
  if (isNew) {
    const put = db.prepare('INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, ?, ?)');
    for (const [name, value] of Object.entries(meta.properties)) {
      if (value) put.run(modRowId, name, value);
    }
    writeModContent(db, modRowId, parseModinfo(file));
  }

  // The game rescans on every launch, so this has to be safe to repeat.
  db.prepare(`INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, ?)
    ON CONFLICT (ModGroupRowId, ModRowId) DO UPDATE SET Disabled = excluded.Disabled`)
    .run(activeGroupId, modRowId, enabled ? 0 : 1);
  return { modId: meta.id, name: meta.properties.Name || meta.id, file, isNew, modRowId };
}

// Writes the parts of a registration that describe what the mod contributes:
// its files, the actions that use them, and the criteria that gate those
// actions. Everything is derived from the .modinfo (see parseModinfo).
function writeModContent(db, modRowId, info) {
  if (!info) return { files: 0, components: 0, settings: 0, criteria: 0 };

  // ModFiles, keyed by path so the links below can resolve them.
  const addFile = db.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)');
  const findFile = db.prepare('SELECT FileRowId FROM ModFiles WHERE ModRowId = ? AND Path = ?');
  const fileRowId = new Map();
  for (const rel of info.files) {
    const norm = rel.split('\\').join('/');
    if (fileRowId.has(norm)) continue;
    let row = findFile.get(modRowId, norm);
    if (!row) row = { FileRowId: addFile.run(modRowId, norm).lastInsertRowid };
    fileRowId.set(norm, row.FileRowId);
  }

  // Criteria first, so an action's criteria="..." can point at one.
  const criteriaRowId = new Map();
  const addCriteria = db.prepare('INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (?, ?, ?)');
  const addCriterion = db.prepare('INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, ?)');
  const addCriterionProp = db.prepare('INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, ?, ?)');
  for (const c of info.criteria) {
    if (!c.id) continue;
    const id = addCriteria.run(modRowId, c.id, c.any).lastInsertRowid;
    criteriaRowId.set(c.id, id);
    for (const cond of c.conditions) {
      const condId = addCriterion.run(id, cond.type, cond.inverse).lastInsertRowid;
      if (cond.value) addCriterionProp.run(condId, 'Value', cond.value);
    }
  }

  // Actions -> Components/Settings, then their <File> children as links.
  const writeActions = (actions, kind) => {
    const addAction = kind === 'component'
      ? db.prepare('INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, ?)')
      : db.prepare('INSERT INTO Settings (ModRowId, SettingId, SettingType) VALUES (?, ?, ?)');
    const addProp = db.prepare('INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, ?, ?)');
    const link = kind === 'component'
      ? db.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId, Priority) VALUES (?, ?, ?)')
      : db.prepare('INSERT INTO SettingFiles (SettingRowId, FileRowId, Priority) VALUES (?, ?, ?)');
    let count = 0;
    for (const a of actions) {
      const actionId = addAction.run(modRowId, a.id, a.type).lastInsertRowid;
      count++;
      if (kind === 'component') {
        for (const prop of a.properties) addProp.run(actionId, prop.name, prop.value);
      }
      for (const rel of a.files) {
        const target = fileRowId.get(rel.split('\\').join('/'));
        // A file the modinfo references but never lists is not loadable; skip
        // it rather than link a row that points at nothing.
        if (target != null) link.run(actionId, target, 0);
      }
    }
    return count;
  };

  const components = writeActions(info.inGame, 'component');
  const settings = writeActions(info.frontEnd, 'setting');

  // <Dependencies> - the mod's own requirement on another mod (usually DLC).
  const addRel = db.prepare('INSERT INTO ModRelationships (ModRowId, OtherModId, Relationship, OtherModTitle) VALUES (?, ?, ?, ?)');
  let dependencies = 0;
  for (const d of info.dependencies) {
    addRel.run(modRowId, d.id, 'Dependency', d.title);
    dependencies++;
  }

  return { files: fileRowId.size, components, settings, criteria: criteriaRowId.size, dependencies };
}

// The built-in group. Every mod the game knows has a row here - verified on a
// real database (2026-09-27): all 423 mods, no exceptions. When the game finds a
// mod it has not scanned before it registers it here, and rebuilds that mod's
// group membership from scratch, which is why a row written into another group
// does not survive the next launch. Registration therefore always targets this
// group, and the active profile is handled separately by applyChanges.
const DEFAULT_GROUP_NAME = 'LOC_MODS_GROUP_DEFAULT_NAME';

function defaultGroupOf(db) {
  const g = db.prepare('SELECT ModGroupRowId AS id FROM ModGroups WHERE CanDelete = 0 ORDER BY SortIndex, ModGroupRowId LIMIT 1').get();
  if (g) return g.id;
  const byName = db.prepare('SELECT ModGroupRowId AS id FROM ModGroups WHERE Name = ? LIMIT 1').get(DEFAULT_GROUP_NAME);
  if (byName) return byName.id;
  throw new Error('the mod database has no built-in mod group');
}

// Registers mods the way the game does, so they can be switched on without it
// having scanned them. `files` are .modinfo paths; the caller must make sure
// the game is closed.
//
// Every profile gets a row for the mod, so it stays switchable wherever you are:
// on in the built-in group and in `groupId` (the profile in use), off - but
// present - in the rest. Writing only the active profile's row left the mod
// reading "not available" as soon as you switched profile, which is the same
// untoggleable state a newly registered mod has. The game leaves an already
// scanned mod's rows alone, so the extra rows are permanent.
function registerMods(dbPath, files, enabled = true, groupId = null) {
  requireDb();
  if (!Array.isArray(files) || !files.length) return { registered: [], failed: [], backupPath: null };
  if (files.length > MAX_REGISTER_MODS) throw new Error('too many mods at once');

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const builtIn = defaultGroupOf(db);
    const extra = groupId == null ? null : Number(groupId);
    if (extra != null && !db.prepare('SELECT 1 FROM ModGroups WHERE ModGroupRowId = ?').get(extra)) {
      throw new Error('that mod group no longer exists');
    }
    // On in the built-in group and the profile being edited, present-but-off in
    // the rest - which is what a profile made by createGroup() looks like.
    const everyGroup = db.prepare('SELECT ModGroupRowId AS id FROM ModGroups ORDER BY SortIndex, ModGroupRowId').all().map((g) => g.id);
    const insert = db.prepare(`INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, ?)
      ON CONFLICT (ModGroupRowId, ModRowId) DO UPDATE SET Disabled = excluded.Disabled`);
    const registered = [];
    const failed = [];
    for (const file of files) {
      try {
        const entry = registerMod(db, file, builtIn, enabled);
        const on = new Set(extra == null ? [builtIn] : [builtIn, extra]);
        for (const gid of everyGroup) insert.run(gid, entry.modRowId, on.has(gid) ? 0 : 1);
        if (extra != null) entry.profileRow = true;
        entry.offElsewhere = everyGroup.length - on.size;
        registered.push(entry);
      } catch (e) {
        failed.push({ file, error: e.message });
      }
    }
    // Read back: every one of them must now have a row in the built-in group
    // and in every profile, so none of them can come back as "not available".
    if (registered.length) {
      const list = registered.map((r) => 'lower(?)').join(',');
      const ids = registered.map((r) => r.modId);
      const inBuiltIn = db.prepare(`SELECT count(*) AS n FROM Mods m JOIN ModGroupItems i ON i.ModRowId = m.ModRowId
        WHERE i.ModGroupRowId = ? AND lower(m.ModId) IN (${list})`).get(builtIn, ...ids).n;
      if (inBuiltIn !== registered.length) throw new Error('the mods were not registered correctly');
      const inAll = db.prepare(`SELECT count(*) AS n FROM (SELECT DISTINCT lower(m.ModId) AS id FROM Mods m
        JOIN ModGroupItems i ON i.ModRowId = m.ModRowId WHERE lower(m.ModId) IN (${list})
        GROUP BY lower(m.ModId) HAVING count(DISTINCT i.ModGroupRowId) = ?)`)
        .get(...ids, everyGroup.length).n;
      if (inAll !== registered.length) throw new Error('the mods are not available in every profile');
    }
    return { registered, failed, group: extra == null ? builtIn : extra, builtIn, profiles: everyGroup.length };
  });
  return { backupPath, ...result };
}

module.exports = {
  readModState, readModDetails, applyChanges, classifyPath,
  listGroups, createGroup, duplicateGroup, renameGroup, deleteGroup, activateGroup,
  exportGroup, importGroup, EXPORT_TOOLKIT, EXPORT_VERSION,
  registerMod, registerMods, readModinfoMeta, parseModinfo, fileTimeOf,
};
