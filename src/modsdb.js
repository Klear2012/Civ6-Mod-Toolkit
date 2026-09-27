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

module.exports = {
  readModState, readModDetails, applyChanges, classifyPath,
  listGroups, createGroup, duplicateGroup, renameGroup, deleteGroup, activateGroup,
  exportGroup, importGroup, EXPORT_TOOLKIT, EXPORT_VERSION,
};
