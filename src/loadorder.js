'use strict';

// Per-action LoadOrder overrides in one JSON file, global not per profile:
// order is installation property (see ADR-003). Mods key by modinfo.normId
// GUID, actions by (ComponentType, id, file list) (see ADR-005); never ModRowId.
// Reads never throw: an unparsable file degrades to overrides-with-message.

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { normId } = require('./modinfo');
const { fileTimeOf, mutateDb, MOD_NAME_SQL, prettyName } = require('./modsdb');
const { gameStatus } = require('./game');
const { readSetup, gameSetupFile, idKey } = require('./gamesetup');
const { MISSPELLINGS, declaredValueOf, evalCondition, setupKeysFor, isAssumedMatch, verdictOf } = require('./gates');
const fit = require('./loadorder-fit');
// Store layer lives in ./loadorder-store.js; the names below are its
// functions and consts, destructured here so every use site and the
// module.exports block stay textually identical.
const { VERSION, SENTINEL, overridesFile, cleanValue, isModId, cleanKey, cleanModId, readOverrides, writeOverrides, readForWrite, setOverride, clearOverride, recordApplied } = require('./loadorder-store');

// A block move is one mod's positioned actions - real ones number in the low
// hundreds - so 1000 never binds a real move but stops a runaway or hand-built
// packet becoming an unbounded single transaction. Checked up front in
// applyBulk, before the guard and before any write, so a reject costs nothing.
const MAX_BULK_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Action identity
// ---------------------------------------------------------------------------

// The key is (ComponentType, id, sorted file list), newline separated. It
// survives rescans, renames, and author LoadOrder bumps - LoadOrder itself is
// deliberately NOT part of the key, since it changes on exactly the updates an
// override must survive. No ordinal tiebreak: a wrong ordinal silently moves a
// neighbour's action, while a dropped override is noticed at once. Parts are
// one-line-normalized below. Measured rationale: see ADR-005.

// Newlines would make the key ambiguous, and a path cannot contain one, but an
// XML attribute value could. Collapse whitespace so every part is one line.
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function keyFor(type, id, files) {
  const lines = [oneLine(type), oneLine(id)];
  for (const f of [...(files || [])].map((x) => oneLine(x).split('\\').join('/')).sort()) {
    if (f) lines.push(f);
  }
  return lines.join('\n');
}

// Read one action's identity out of the database. The game wrote these rows, and
// they agree with the .modinfo on disk, so there is no need to parse any file here.
function actionKey(db, componentRowId) {
  const c = db.prepare('SELECT ComponentType AS type, ComponentId AS id FROM Components WHERE ComponentRowId = ?')
    .get(componentRowId);
  if (!c) return null;
  const files = db.prepare(
    `SELECT f.Path AS path
       FROM ComponentFiles cf
       JOIN ModFiles f ON f.FileRowId = cf.FileRowId
      WHERE cf.ComponentRowId = ?
      ORDER BY f.Path`
  ).all(componentRowId).map((r) => r.path);
  return keyFor(c.type, c.id, files);
}

const FIND = 'found';
const MISSING = 'missing';
const AMBIGUOUS = 'ambiguous';

// Find the action one stored key names, inside one mod.
//
// Exactly one match, or a report. Never a best guess, and never an ordinal
// fallback (see ADR-005): actions sharing a key are ones their own author never
// told apart, so the user cannot say which one they meant either.
function resolveAction(db, modIdNorm, key) {
  const mod = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(modIdNorm);
  if (!mod) return { state: MISSING, candidates: [] };

  const wanted = String(key == null ? '' : key);
  const rows = db.prepare('SELECT ComponentRowId FROM Components WHERE ModRowId = ? ORDER BY ComponentRowId')
    .all(mod.ModRowId);
  const hits = [];
  for (const r of rows) {
    if (actionKey(db, r.ComponentRowId) === wanted) hits.push(r.ComponentRowId);
  }
  if (hits.length === 1) return { state: FIND, componentRowId: hits[0], candidates: hits };
  if (hits.length === 0) return { state: MISSING, candidates: [] };
  return { state: AMBIGUOUS, componentRowId: null, candidates: hits };
}

// ---------------------------------------------------------------------------
// Action files
// ---------------------------------------------------------------------------

// Basenames only. Full relative paths never leave the server: the client gets
// `Data.sql`, never `Patches/Data.sql`, and no request-supplied path is ever
// echoed back.
function fileBase(p) {
  return String(p == null ? '' : p).split(/[/\\]/).pop();
}

// One action's file list, resolved strictly from the database
// (ComponentFiles -> ModFiles). Null when no action has that row id, so the
// route can answer 404: an empty list is a real answer (the action genuinely
// has no files), while an unknown id is not.
function actionFiles(db, componentRowId) {
  const row = db.prepare('SELECT ComponentRowId FROM Components WHERE ComponentRowId = ?').get(componentRowId);
  if (!row) return null;
  return db.prepare(
    `SELECT f.Path AS path
       FROM ComponentFiles cf
       JOIN ModFiles f ON f.FileRowId = cf.FileRowId
      WHERE cf.ComponentRowId = ?
      ORDER BY f.Path`
  ).all(componentRowId).map((r) => fileBase(r.path));
}

function notFound(msg) {
  const e = new Error(msg);
  e.code = 'NOT_FOUND';
  return e;
}

// The route's single-action shape. A malformed id is a 400 about the request;
// an unknown one carries NOT_FOUND, which the route maps to 404.
function actionFilesOf(dbPath, rawId) {
  const t = String(rawId == null ? '' : rawId).trim();
  if (!/^-?\d+$/.test(t)) throw new Error('that action id is not a whole number');
  const db = openDb(dbPath);
  try {
    const files = actionFiles(db, Number(t));
    if (files === null) throw notFound('no such action');
    return { componentRowId: Number(t), files };
  } finally {
    db.close();
  }
}

// The route's batch shape: every action of one mod, in row order. Read-only,
// so like every other GET it works while Civ6 runs.
function modActionFilesOf(dbPath, rawMod) {
  const id = cleanModId(rawMod);
  const db = openDb(dbPath);
  try {
    const mod = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(id);
    if (!mod) throw notFound('no such mod');
    const rows = db.prepare('SELECT ComponentRowId FROM Components WHERE ModRowId = ? ORDER BY ComponentRowId')
      .all(mod.ModRowId);
    return {
      modId: id,
      actions: rows.map((r) => ({ componentRowId: r.ComponentRowId, files: actionFiles(db, r.ComponentRowId) || [] })),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Storing: validators, parse/view, file read/write, set/clear/recordApplied
// ---------------------------------------------------------------------------
// Moved to ./loadorder-store.js, destructured at the top; nothing below
// duplicates it.

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

// Read-only, and closed by the caller. modsdb.readModState opens its own the
// same way: one connection per operation, no cache, so a value written a
// moment ago is always the value read.
function openDb(dbPath, { readOnly = true } = {}) {
  return new DatabaseSync(dbPath, { readOnly });
}

// The mod's .modinfo on disk, and whether we could find it.
//
// Some rows are base-game or DLC assets recorded with relative ../../../
// paths, so they are not on disk under any local or workshop root and their
// mtime cannot be read. Nothing can keep their stamp, so an override on one of
// them is re-derived on the next rescan. They are reported as not protected
// rather than quietly treated as safe.
function modFile(db, modRowId) {
  const row = db.prepare(
    `SELECT s.ScannedFileRowId AS scannedFileRowId, s.Path AS path
       FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId
      WHERE m.ModRowId = ?`
  ).get(modRowId);
  if (!row) return null;
  try {
    fs.statSync(row.path);
    return { ...row, onDisk: true };
  } catch (_) {
    return { ...row, onDisk: false };
  }
}

// The stamp the game compares the file's mtime against, and the value we must
// write to make it see "nothing changed". A string, always - the column does not
// fit a JavaScript number and throws RangeError on conversion.
//
// fileTimeOf carries the file's FULL nanosecond mtime. Rounding to whole
// milliseconds leaves the stamp about half a millisecond behind, which reads as
// exactly the change we are trying to hide, and an experiment that did that
// reported a confident false FAIL.
function stampFor(filePath) {
  return fileTimeOf(filePath).toString();
}

// Whether the game will re-register this mod on its next launch: it will, if
// the stamp in the database does not already match the file. Null when the
// file is not on disk, because then there is nothing to compare and nothing to
// keep up to date.
function stampIsStale(db, modRowId) {
  const file = modFile(db, modRowId);
  if (!file || !file.onDisk) return null;
  // CAST to TEXT, always. A Windows FILETIME is ~1.34e17, which does not fit a
  // JavaScript number, and the driver throws RangeError rather than rounding.
  // This has bitten three times in this project; the cast is not optional and
  // the column must never be read as a number.
  const row = db.prepare('SELECT CAST(LastWriteTime AS TEXT) AS t FROM ScannedFiles WHERE ScannedFileRowId = ?')
    .get(file.scannedFileRowId);
  if (!row) return true;
  return String(row.t) !== stampFor(file.path);
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function modRowOf(db, modIdNorm) {
  const r = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(modIdNorm);
  return r ? r.ModRowId : null;
}

// What the game currently has for one action. The correctly spelled row wins;
// a misspelled one is the fallback, because it is the only other record of what
// the mod asked for.
function currentValue(db, componentRowId) {
  const row = db.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'")
    .get(componentRowId);
  if (row) return String(row.v);
  for (const name of MISSPELLINGS) {
    const alt = db.prepare('SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = ?')
      .get(componentRowId, name);
    if (alt) return String(alt.v);
  }
  return null;
}

// Always the correctly spelled row: update it if it exists, and add it if not,
// so an action that declared no position can be given one. A misspelled row is
// left exactly as the mod shipped it, and never blocks the write.
function writeValue(db, componentRowId, value) {
  const r = db.prepare("UPDATE ComponentProperties SET Value = ? WHERE ComponentRowId = ? AND Name = 'LoadOrder'")
    .run(String(value), componentRowId);
  if (r.changes === 0) {
    db.prepare("INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, 'LoadOrder', ?)")
      .run(componentRowId, String(value));
  }
}

function writeStamp(db, scannedFileRowId, value) {
  db.prepare('UPDATE ScannedFiles SET LastWriteTime = ? WHERE ScannedFileRowId = ?').run(value, scannedFileRowId);
}

// One stored override, and what is actually true of it right now.
function inspect(db, modIdNorm, key, wanted) {
  const res = resolveAction(db, modIdNorm, key);
  const out = { modId: modIdNorm, key, state: res.state, componentRowId: res.componentRowId, candidates: res.candidates };
  if (res.state !== FIND) return out;
  const before = currentValue(db, res.componentRowId);
  return {
    ...out,
    before,
    wanted: String(wanted),
    // A missing row is drift too: the action declares nothing, and the override
    // is what gives it a position.
    drifted: before !== String(wanted),
  };
}

// One mod's worth of work: the overrides on it, and whether its stamp needs
// re-writing. The stamp is maintained whether or not any value drifted, because
// it is what stops the game re-deriving the whole mod.
function planMod(db, modIdNorm, set) {
  const modRowId = modRowOf(db, modIdNorm);
  if (modRowId === null) {
    return { modId: modIdNorm, missing: true, entries: [], stale: false, protectable: false };
  }
  const entries = Object.entries(set).map(([key, e]) => inspect(db, modIdNorm, key, e.value));
  const file = modFile(db, modRowId);
  return {
    modId: modIdNorm,
    modRowId,
    missing: false,
    entries,
    // null means not on disk: nothing to stamp, and nothing to claim.
    stale: stampIsStale(db, modRowId),
    protectable: !!(file && file.onDisk),
    scannedFileRowId: file ? file.scannedFileRowId : null,
  };
}

function needsWrite(mods) {
  return mods.some((m) => !m.missing && (m.stale === true || m.entries.some((e) => e.drifted && e.state === FIND)));
}

// The write itself, shared by apply and sync so the two cannot drift.
//
// Every entry's value and the mod's stamp go in the same transaction, because
// a value committed with a stale stamp is a value the game removes on its next
// launch: the user watches it apply and then vanish. If the stamp cannot be
// written, the value must not be either.
function writeAll(db, mods) {
  const applied = [];
  for (const m of mods) {
    if (m.missing) continue;
    for (const e of m.entries) {
      if (e.state !== FIND || !e.drifted) continue;
      // `wanted`, not `value`: inspect() returns the wanted value under that
      // name, and reading e.value wrote the string "undefined" into the
      // database while every check that only counted rows went green.
      writeValue(db, e.componentRowId, e.wanted);
      // The row it landed on, so a caller can show or re-check it. It is the
      // NEW id after a rescan, which is the whole point of resolving by key.
      applied.push({ modId: m.modId, key: e.key, value: Number(e.wanted), declared: e.before, componentRowId: e.componentRowId });
    }
    if (m.protectable && m.stale === true) writeStamp(db, m.scannedFileRowId, stampFor(modFile(db, m.modRowId).path));
  }
  return applied;
}

function summarise(mods, applied, backupPath) {
  const drifted = [];
  const orphans = [];
  const ambiguous = [];
  const unprotectable = [];
  for (const m of mods) {
    if (m.missing) { orphans.push({ modId: m.modId, reason: 'no such mod' }); continue; }
    if (!m.protectable) unprotectable.push(m.modId);
    for (const e of m.entries) {
      const at = { modId: m.modId, key: e.key, candidates: e.candidates };
      if (e.state === MISSING) orphans.push({ ...at, reason: 'no action matches that key' });
      else if (e.state === AMBIGUOUS) ambiguous.push({ ...at, reason: `${e.candidates.length} actions match that key` });
      else if (e.drifted) drifted.push({ ...at, from: e.before, to: e.wanted });
    }
  }
  const sentinels = applied.filter((a) => a.value >= SENTINEL).map((a) => ({ modId: a.modId, key: a.key, value: a.value }));
  return {
    changed: applied.length > 0 || mods.some((m) => m.stale === true),
    applied, drifted, orphans, ambiguous, unprotectable, sentinels, backupPath,
  };
}

// Apply a set of overrides by hand. One transaction, one backup, whatever the
// size of the set.
//
// The game check is inside this function and awaited, not left to the caller.
// An experiment script during the investigation read the result of an async
// gameStatus() as a plain object, so `running` was always undefined and the
// guard never fired - it looked like it was refusing to write while Civ6 ran
// and was not. A safety check that cannot fail is not a safety check.
async function applyOverrides(dbPath, entries, opts = {}) {
  const file = opts.file || overridesFile();
  // Injectable so the guard can be tested without starting Civilization VI.
  // The default is the real check, and there is no way to pass "skip it".
  const status = opts.statusFn || gameStatus;
  if (!Array.isArray(entries) || !entries.length) throw new Error('no overrides to apply');

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const stored = readOverrides(file);
  if (stored.unusable) throw new Error(`${stored.error} - nothing was written`);

  const clean = entries.map((e) => ({
    modId: cleanModId(e.modId), key: cleanKey(e.key), value: cleanValue(e.value),
  }));

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const mods = clean.map((e) => planMod(db, e.modId, { [e.key]: { value: e.value } }));
    return summarise(mods, writeAll(db, mods), null);
  });
  // The store is written after the database commits, never before. A store
  // write that failed would leave an override that works but is not recorded, so
  // it is not re-applied after an update - loud, and fixable. The other order
  // would leave an override that does not work at all.
  recordApplied(file, result.applied);
  return { ...result, backupPath };
}

// Bulk apply for a block move: one transaction, one backup, grouped by mod
// through the applyOverrides path so value+stamp land together (see ADR-006).
// Entries mix { modId, key, value } and { modId, componentRowId, value } (key
// derived via actionKey, stale=orphaned, twins=ambiguous, never written).
// Values pass cleanValue; store folds after commit; refused while Civ6 runs.
async function applyBulk(dbPath, entries, opts = {}) {
  const file = opts.file || overridesFile();
  const status = opts.statusFn || gameStatus;
  if (!Array.isArray(entries) || !entries.length) throw new Error('no overrides to apply');
  if (entries.length > MAX_BULK_ENTRIES) {
    throw new Error(`that batch names ${entries.length} actions (limit ${MAX_BULK_ENTRIES}) - nothing was written`);
  }

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const stored = readOverrides(file);
  if (stored.unusable) throw new Error(`${stored.error} - nothing was written`);

  const clean = entries.map((e) => {
    const modId = cleanModId(e.modId);
    const value = cleanValue(e.value);
    if (e.key !== undefined && e.key !== null) return { modId, key: cleanKey(e.key), value };
    const cr = Number(e.componentRowId);
    if (!Number.isInteger(cr) || cr <= 0) throw new Error('that action id is not a whole number');
    return { modId, componentRowId: cr, value };
  });

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const byMod = new Map();
    const earlyOrphans = [];
    const setOf = (id) => {
      let m = byMod.get(id);
      if (!m) { m = new Map(); byMod.set(id, m); }
      return m;
    };
    for (const e of clean) {
      if (e.key !== undefined) { setOf(e.modId).set(e.key, e.value); continue; }
      const row = db.prepare(
        'SELECT m.ModId AS mid FROM Components c JOIN Mods m ON m.ModRowId = c.ModRowId WHERE c.ComponentRowId = ?'
      ).get(e.componentRowId);
      if (!row || normId(row.mid) !== e.modId) {
        earlyOrphans.push({ modId: e.modId, key: null, componentRowId: e.componentRowId, candidates: [],
          reason: row ? 'that action is not part of this mod' : 'no action matches that key' });
        continue;
      }
      const key = actionKey(db, e.componentRowId);
      if (key === null) {
        earlyOrphans.push({ modId: e.modId, key: null, componentRowId: e.componentRowId, candidates: [],
          reason: 'no action matches that key' });
        continue;
      }
      setOf(e.modId).set(key, e.value); // last wins; twins resolve AMBIGUOUS below anyway
    }
    const mods = [...byMod].map(([id, m]) =>
      planMod(db, id, Object.fromEntries([...m].map(([k, v]) => [k, { value: v }]))));
    const summary = summarise(mods, writeAll(db, mods), null);
    summary.orphans.push(...earlyOrphans);
    return summary;
  });
  recordApplied(file, result.applied);
  return { ...result, backupPath };
}

// Put one action back to the author's value, in the database and in the store.
async function resetOverride(dbPath, modId, key, opts = {}) {
  const file = opts.file || overridesFile();
  const status = opts.statusFn || gameStatus;
  const id = cleanModId(modId);
  const k = cleanKey(key);

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const stored = readOverrides(file);
  if (stored.unusable) throw new Error(`${stored.error} - nothing was written`);
  const entry = (stored.overrides[id] || {})[k];
  if (!entry) throw new Error('no override is stored for that action');
  if (entry.declared === undefined) {
    throw new Error("the author's value for that action was never recorded, so there is nothing to go back to");
  }

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const mods = [planMod(db, id, { [k]: { value: entry.declared } })];
    return summarise(mods, writeAll(db, mods), null);
  });
  clearOverride(file, id, k);
  return { ...result, restored: entry.declared, backupPath };
}

// Put every override of one mod back to its recorded author value, in the
// database and in the store. One transaction, one backup, whatever the size
// of the set: the entries are folded into a single planMod so a value and
// its mod's stamp land together or not at all, reusing the single-entry
// write path (planMod/writeAll/summarise).
//
// Refuses when any entry lacks a recorded declared value, before any write,
// so nothing is half-done: neither the database nor the store is touched.
async function resetModOverrides(dbPath, modId, opts = {}) {
  const file = opts.file || overridesFile();
  const status = opts.statusFn || gameStatus;
  const id = cleanModId(modId);

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const stored = readOverrides(file);
  if (stored.unusable) throw new Error(`${stored.error} - nothing was written`);
  const set = stored.overrides[id];
  if (!set || !Object.keys(set).length) throw new Error('no overrides are stored for that mod');
  const entries = Object.entries(set);
  const missing = entries.filter(([, e]) => e.declared === undefined);
  if (missing.length) {
    throw new Error(`the author's value for ${missing.length} action${missing.length === 1 ? '' : 's'} was never recorded, so there is nothing to go back to - nothing was written`);
  }

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const wanted = Object.fromEntries(entries.map(([k, e]) => [k, { value: e.declared }]));
    const mods = [planMod(db, id, wanted)];
    return summarise(mods, writeAll(db, mods), null);
  });
  const current = readForWrite(file, null);
  const next = { ...current.overrides };
  delete next[id];
  writeOverrides(file, next);
  return { ...result, restored: entries.map(([k, e]) => ({ key: k, value: e.declared })), backupPath };
}

// Forget every override of one mod WITHOUT touching the database. The values
// stay where the last apply put them, which the client says in its confirm:
// discarding is not the same as resetting, and only one of them undoes what
// the override did. One file write, reusing the single-entry clear path's
// read-and-write shape. Refused while Civ6 runs like all writes.
async function discardModOverrides(dbPath, modId, opts = {}) {
  const file = opts.file || overridesFile();
  const status = opts.statusFn || gameStatus;
  const id = cleanModId(modId);

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const current = readForWrite(file, null);
  if (!current.overrides[id] || !Object.keys(current.overrides[id]).length) {
    throw new Error('no overrides are stored for that mod');
  }
  const count = Object.keys(current.overrides[id]).length;
  const next = { ...current.overrides };
  delete next[id];
  writeOverrides(file, next);
  return { discarded: count, modId: id };
}

// Run on server start, before the mod list is served. That is what makes an
// override correct on the FIRST launch after a mod update, which is the only
// launch that matters.
//
// Reads first and opens the write path only if something is actually wrong: the
// app keeps ten database backups and spends them deliberately, and this runs on
// every launch.
function syncOverrides(dbPath, opts = {}) {
  const file = opts.file || overridesFile();
  const stored = readOverrides(file);
  if (stored.unusable) {
    return { ok: false, deferred: false, error: stored.error, applied: [], drifted: [], orphans: [], ambiguous: [], unprotectable: [] };
  }
  if (opts.gameRunning) {
    // Reported, never silently skipped: the overrides stay as they are and the
    // mod list says the sync was deferred.
    return { ok: true, deferred: true, reason: 'Civilization VI is running', changed: false, applied: [], drifted: [], orphans: [], ambiguous: [], unprotectable: [] };
  }
  if (stored.count === 0) {
    return { ok: true, deferred: false, changed: false, applied: [], drifted: [], orphans: [], ambiguous: [], unprotectable: [] };
  }

  const d = openDb(dbPath);
  let mods;
  try {
    mods = Object.keys(stored.overrides).map((id) => planMod(d, id, stored.overrides[id]));
  } finally {
    d.close();
  }

  if (!needsWrite(mods)) {
    const survey = summarise(mods, [], null);
    return { ...survey, ok: true, deferred: false, changed: false, backupPath: null };
  }

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    // Re-planned inside the transaction, so what is written is decided from the
    // state being written to rather than from a read that has since gone stale.
    const fresh = Object.keys(stored.overrides).map((id) => planMod(db, id, stored.overrides[id]));
    return summarise(fresh, writeAll(db, fresh), null);
  });
  return { ...result, ok: true, deferred: false, backupPath };
}

// Which mods have an override and a stamp the game will not agree with - that
// is, the ones it will re-register and re-derive on its next launch. Read-only,
// one stat per overridden mod, and the thing the mod list turns into
// "N mods updated since your last sync".
function staleMods(dbPath, opts = {}) {
  const file = opts.file || overridesFile();
  const stored = readOverrides(file);
  if (stored.unusable) return { stale: [], error: stored.error, unusable: true };
  if (stored.count === 0) return { stale: [], error: null, unusable: false };

  const d = openDb(dbPath);
  const stale = [];
  try {
    for (const id of Object.keys(stored.overrides)) {
      const modRowId = modRowOf(d, id);
      if (modRowId === null) continue;
      if (stampIsStale(d, modRowId) === true) stale.push(id);
    }
  } finally {
    d.close();
  }
  return { stale, error: null, unusable: false };
}

// Appended to src/loadorder.js: the read side behind the load order view.
//
// The view is the profile's load order as one flat list, sorted by the value the
// game will use. This builds that list. It reads only - there is no write
// anywhere in this section, and phase7 asserts that no write route is reachable
// from the page which renders it.

// The smallest gap worth showing as a row. A free run of two is real but says
// nothing you could act on, so below this the list simply steps from one value
// to the next.
const MIN_FREE_RUN = 5;

function groupsOf(db) {
  return db.prepare('SELECT ModGroupRowId AS id, Name AS name, Selected AS selected FROM ModGroups ORDER BY SortIndex, ModGroupRowId').all();
}

function activeGroupId(db) {
  const g = db.prepare('SELECT ModGroupRowId AS id FROM ModGroups WHERE Selected = 1 LIMIT 1').get();
  return g ? g.id : null;
}

// A resolved name, or a readable one when nothing localised the tag.
//
// ModProperties.Name holds a localization TAG, not text - the game resolves it
// through LocalizedText, which MOD_NAME_SQL does. The base game and DLC rows have
// no such entry, because they are not mods and nothing localises them, so they
// arrive here still tagged. prettyName is modsdb's reader for that case, reused
// rather than rewritten, so the mod manager and this view call a DLC row the same
// thing.
//
// A GUID is left alone: it is not a tag, and dressing it up as one would be worse
// than showing it.
function displayNameOf(resolved, modId) {
  if (resolved && !/LOC_[A-Z0-9_]+/i.test(resolved)) return resolved;
  if (resolved) return prettyName(resolved) || resolved;
  return modId;
}

// Every mod the game knows. Needed to say whether a criterion names a mod you
// have, which is the difference between "will not run, ever" and "cannot tell".
function installedMods(db) {
  const byId = new Map();
  for (const m of db.prepare(
    `SELECT m.ModRowId AS modRowId, m.ModId AS modId, ${MOD_NAME_SQL('p')} AS name
       FROM Mods m
       LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name'`
  ).all()) {
    const id = normId(m.modId);
    byId.set(id, { modRowId: m.modRowId, modId: id, name: displayNameOf(m.name, m.modId) });
  }
  return byId;
}

function enabledMods(db, groupId) {
  const on = new Map();
  const rowToNorm = new Map();
  for (const m of db.prepare(
    `SELECT m.ModRowId AS modRowId, m.ModId AS modId, ${MOD_NAME_SQL('p')} AS name
       FROM ModGroupItems i
       JOIN Mods m ON m.ModRowId = i.ModRowId
       LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name'
      WHERE i.ModGroupRowId = ? AND i.Disabled = 0`
  ).all(groupId)) {
    const id = normId(m.modId);
    on.set(id, { modRowId: m.modRowId, modId: id, name: displayNameOf(m.name, m.modId) });
    rowToNorm.set(m.modRowId, id);
  }
  return { on, rowToNorm };
}

// Everything in one profile, in four queries.
//
// The identity key is deliberately NOT built here for every action: each build
// reads a file list, and only the handful of actions an override names need one.
function readProfile(db, groupId) {
  const { on, rowToNorm } = enabledMods(db, groupId);

  const actions = db.prepare(
    `SELECT c.ComponentRowId AS componentRowId, c.ModRowId AS modRowId,
            c.ComponentType AS type, c.ComponentId AS id
       FROM Components c
       JOIN ModGroupItems i ON i.ModRowId = c.ModRowId
       JOIN Mods m         ON m.ModRowId = c.ModRowId
      WHERE i.ModGroupRowId = ? AND i.Disabled = 0
      ORDER BY c.ComponentRowId`
  ).all(groupId);

  // Correctly spelled row and both misspellings, kept apart so the view can say
  // a mod spelled it wrong.
  const declared = new Map();
  for (const p of db.prepare(
    `SELECT cp.ComponentRowId AS cr, cp.Name AS name, cp.Value AS value
       FROM ComponentProperties cp
       JOIN Components c     ON c.ComponentRowId = cp.ComponentRowId
       JOIN ModGroupItems i  ON i.ModRowId = c.ModRowId
      WHERE i.ModGroupRowId = ? AND i.Disabled = 0
        AND cp.Name IN ('LoadOrder','LaodOrder','LoadingOrder')`
  ).all(groupId)) {
    if (!declared.has(p.cr)) declared.set(p.cr, {});
    declared.get(p.cr)[p.name] = String(p.value);
  }

  // One item per CONDITION, not per property. The obvious join is wrong here:
  // a ConfigurationValueMatches condition carries three properties -
  // ConfigurationId, Group and Value - so joining CriterionProperties into the
  // condition query yields three rows for one condition.
  //
  // No verdict was wrong, because every criterion type the view can decide
  // happens to carry exactly one property. But multi-property conditions inflated
  // that way, each of those rows listing the same unreadable reason once per
  // property - and the row's own "and N more it cannot see" count was counting
  // one condition as three. The duplication was already putting wrong information
  // on screen.
  const condRows = db.prepare(
    `SELECT cc.ComponentRowId AS cr, k.Any AS any, cr.CriterionRowId AS id,
            cr.CriterionType AS type, cr.Inverse AS inverse
       FROM ComponentCriteria cc
       JOIN Components c    ON c.ComponentRowId = cc.ComponentRowId
       JOIN ModGroupItems i ON i.ModRowId = c.ModRowId
       JOIN Criteria k      ON k.CriteriaRowId = cc.CriteriaRowId
       JOIN Criterion cr    ON cr.CriteriaRowId = k.CriteriaRowId
      WHERE i.ModGroupRowId = ? AND i.Disabled = 0`
  ).all(groupId);

  // Properties are read whole and attached, rather than pivoted into columns,
  // because which property carries the meaning depends on the criterion type and
  // the reasons below need to name it. Keyed through idKey like the catalog:
  // the same two id domains meet in JS here, and an affinity split must never
  // silently detach properties from their conditions.
  const critProps = new Map();
  for (const p of db.prepare('SELECT CriterionRowId AS id, Name AS name, Value AS value FROM CriterionProperties').all()) {
    const id = idKey(p.id);
    if (!critProps.has(id)) critProps.set(id, {});
    critProps.get(id)[p.name] = p.value;
  }

  const conds = new Map();
  for (const c of condRows) {
    if (!conds.has(c.cr)) conds.set(c.cr, { any: !!c.any, items: [] });
    const kv = critProps.get(idKey(c.id)) || {};
    conds.get(c.cr).items.push({
      type: c.type,
      inverse: !!c.inverse,
      value: kv.Value === undefined ? null : kv.Value,
      props: kv,
    });
  }

  return { on, rowToNorm, actions, declared, conds };
}

// Which overrides point where, so a row can be labelled without building an
// identity key for every action in the library.
function overrideIndex(db, stored) {
  const index = new Map();
  const unmatched = [];
  for (const [id, set] of Object.entries(stored.overrides)) {
    for (const [key, entry] of Object.entries(set)) {
      const res = resolveAction(db, id, key);
      if (res.state === FIND) {
        index.set(res.componentRowId, { state: 'overridden', entry, key, modId: id });
      } else {
        unmatched.push({
          modId: id,
          key,
          value: entry.value,
          declared: entry.declared === undefined ? null : entry.declared,
          state: res.state === AMBIGUOUS ? 'ambiguous' : 'orphaned',
          candidates: res.state === AMBIGUOUS ? res.candidates.length : 0,
        });
      }
    }
  }
  return { index, unmatched };
}

// The list. One band per value, ties grouped and never ordered within the
// group, with the free runs between them as rows of their own.
function buildList(rows) {
  const withPos = rows.filter((r) => r.effective !== null);
  const undeclared = rows.filter((r) => r.effective === null);
  withPos.sort((a, b) => Number(a.effective) - Number(b.effective)
    || a.modName.localeCompare(b.modName) || a.componentRowId - b.componentRowId);

  const bands = [];
  let i = 0;
  while (i < withPos.length) {
    const value = Number(withPos[i].effective);
    const members = [];
    while (i < withPos.length && Number(withPos[i].effective) === value) { members.push(withPos[i]); i++; }
    bands.push({ kind: 'value', value, actions: members, tie: members.length > 1 });
    const next = i < withPos.length ? Number(withPos[i].effective) : null;
    if (next !== null && next - value - 1 >= MIN_FREE_RUN) {
      bands.push({ kind: 'free', from: value + 1, to: next - 1, count: next - value - 1 });
    }
  }
  if (withPos.length) {
    const last = Number(withPos[withPos.length - 1].effective);
    bands.push({ kind: 'headroom', from: last + 1, to: null, count: null });
  }
  return { bands, undeclared };
}

// The whole view, for one profile. Read-only.
function profileLoadOrder(dbPath, opts = {}) {
  const file = opts.file || overridesFile();
  const stored = readOverrides(file);
  const db = openDb(dbPath);
  try {
    const groups = groupsOf(db);
    const groupId = opts.groupId != null ? Number(opts.groupId) : activeGroupId(db);
    const blank = { ok: false, error: 'the mod database has no active profile', groups, profile: null, bands: [], undeclared: [], undeclaredTotal: 0, unmatched: [], summary: {} };
    if (groupId === null || !groups.some((g) => g.id === groupId)) return blank;
    const group = groups.find((g) => g.id === groupId);

    const { on, rowToNorm, actions, declared, conds } = readProfile(db, groupId);
    // Assumed game setup, read-only. opts.asserted overrides the file for
    // tests; opts.gameSetupFile / opts.gameSetupKnown override the path and
    // the prune set the catalog will supply. A missing, empty or unusable file
    // reads as no assertions - measured-only, byte-identical - and nothing
    // here ever writes the store or the game database.
    let asserted = null;
    if (opts.asserted !== undefined && opts.asserted !== null) {
      asserted = opts.asserted;
    } else {
      try {
        const v = readSetup(opts.gameSetupFile || gameSetupFile(), opts.gameSetupKnown || null);
        asserted = (v && v.asserted) || {};
      } catch (_) {
        asserted = null;
      }
    }
    const ctx = { installed: installedMods(db), on, asserted };
    const { index, unmatched } = overrideIndex(db, stored);

    // Comparing two profiles is cheaper than it looks: ComponentRowId belongs to
    // the database, not to a profile, so a mod's actions have the same row ids in
    // both. Two profiles differ only in which mods are switched on, and a row is
    // in the other profile exactly when its mod is.
    const compareGroupId = opts.compareGroupId != null ? Number(opts.compareGroupId) : null;
    const compareOn = compareGroupId != null && groups.some((g) => g.id === compareGroupId)
      ? enabledMods(db, compareGroupId).on
      : null;

    // Some rows are base-game or DLC assets whose .modinfo is not on disk.
    // Nothing can keep their stamp, so an override on one is re-derived on the
    // next rescan, and the view says so instead of implying protection.
    const unprotectable = new Set();
    for (const [id, m] of on) if (!modFile(db, m.modRowId).onDisk) unprotectable.add(id);

    const rows = actions.map((a) => {
      const modId = rowToNorm.get(a.modRowId);
      const mod = on.get(modId);
      const props = declared.get(a.componentRowId) || {};
      const declaredValue = declaredValueOf(declared, a.componentRowId);
      const misspelled = declaredValue !== null && props.LoadOrder === undefined;
      const ov = index.get(a.componentRowId);
      const v = verdictOf(conds.get(a.componentRowId), ctx);
      // Two different values, and conflating them is how a view ends up telling
      // the user their own override is what the mod declared. `effective` is
      // what the game will use - it is what the list sorts by, and it is the
      // database row. `declared` is what the author asked for, which once an
      // override is applied is only in the store, because the database now holds
      // ours.
      return {
        modId,
        modName: (mod && mod.name) || modId || 'unknown mod',
        componentRowId: a.componentRowId,
        type: a.type,
        id: a.id,
        effective: declaredValue,
        declared: ov && ov.entry.declared !== undefined ? String(ov.entry.declared) : declaredValue,
        misspelled,
        override: ov ? { value: ov.entry.value, declared: ov.entry.declared === undefined ? null : ov.entry.declared } : null,
        state: ov ? (String(props.LoadOrder) === String(ov.entry.value) ? 'overridden' : 'drifted') : 'author default',
        protected: !unprotectable.has(modId),
        willRun: v.willRun,
        reason: v.reason,
        unknown: v.unknown,
        assumed: !!v.assumed,
        // null when nothing is being compared, so the client can tell "not
        // compared" from "compared and absent".
        inCompare: compareOn ? compareOn.has(modId) : null,
      };
    });

    const { bands, undeclared } = buildList(rows);

    // The undeclared block, grouped by mod: an action declaring nothing relies on
    // ordering nobody controls. The verdict counts ride along, because "declares
    // no position and will not run anyway" is a different thing from either alone.
    const byMod = new Map();
    for (const r of undeclared) {
      if (!byMod.has(r.modId)) byMod.set(r.modId, { modId: r.modId, name: r.modName, count: 0, willNotRun: 0, unknown: 0 });
      const e = byMod.get(r.modId);
      e.count++;
      if (r.willRun === false) e.willNotRun++;
      else if (r.willRun === null) e.unknown++;
    }
    const undeclaredList = [...byMod.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const values = rows.filter((r) => r.effective !== null).map((r) => Number(r.effective));
    const distinct = [...new Set(values)].sort((a, b) => a - b);

    return {
      ok: true,
      error: null,
      groups,
      profile: { id: group.id, name: group.name },
      bands,
      undeclared: undeclaredList,
      undeclaredTotal: undeclared.length,
      undeclaredWillNotRun: undeclared.filter((r) => r.willRun === false).length,
      unmatched,
      compare: compareOn && groups.some((g) => g.id === compareGroupId)
        ? { id: compareGroupId, name: (groups.find((g) => g.id === compareGroupId) || {}).name, modsOn: compareOn.size }
        : null,
      stale: staleMods(dbPath, { file }),
      labelsError: stored.error,
      labelsUnusable: stored.unusable,
      summary: {
        modsOn: on.size,
        actions: rows.length,
        positioned: rows.length - undeclared.length,
        undeclared: undeclared.length,
        willNotRun: rows.filter((r) => r.willRun === false).length,
        unknown: rows.filter((r) => r.willRun === null).length,
        assumed: rows.filter((r) => r.assumed).length,
        distinctValues: distinct.length,
        min: distinct.length ? distinct[0] : null,
        max: distinct.length ? distinct[distinct.length - 1] : null,
        overrides: index.size,
        unmatched: unmatched.length,
        unprotectable: unprotectable.size,
      },
    };
  } finally {
    db.close();
  }
}

// Block-move proposal lives in ./loadorder-fit.js; the names below are its
// functions, re-exported here so every require path stays identical. Only the
// DB-layer deps (modFile, stampIsStale) are injected: the store consts and
// cleanValue now come from ./loadorder-store.js, which fit requires directly.
fit.initFit({ modFile, stampIsStale });
const { describeBlock, occupiedOf, proposeBlock, buildEvenSpacing, buildOverflow, buildManual } = fit;

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

// Every stored override, with what is actually true of it right now: does its
// key still resolve, is the database carrying the value, and can the stamp be
// maintained for the mod it is on.
//
// The identity key is stored as a readable string on purpose, so a user
// reporting "my override stopped matching" can be answered by looking at the
// file rather than at a hash.
function listOverrides(dbPath, opts = {}) {
  const file = opts.file || overridesFile();
  const stored = readOverrides(file);
  const out = [];
  const groups = [];
  const db = openDb(dbPath);
  try {
    for (const [id, set] of Object.entries(stored.overrides)) {
      const modRowId = modRowOf(db, id);
      const meta = modRowId === null ? null : db.prepare(
        `SELECT ${MOD_NAME_SQL('p')} AS name FROM Mods m LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name' WHERE m.ModRowId = ?`
      ).get(modRowId);
      const onDisk = modRowId !== null && modFile(db, modRowId).onDisk;
      const modName = displayNameOf(meta && meta.name, id);

      for (const [key, entry] of Object.entries(set)) {
        const row = { modId: id, modName, modInstalled: modRowId !== null, protected: onDisk, key, value: entry.value, declared: entry.declared === undefined ? null : entry.declared };
        if (modRowId === null) {
          out.push({ ...row, state: 'orphaned', reason: 'that mod is not in the database' });
          continue;
        }
        const res = resolveAction(db, id, key);
        if (res.state === AMBIGUOUS) {
          out.push({ ...row, state: 'ambiguous', candidates: res.candidates.length, reason: `${res.candidates.length} actions in that mod match this key` });
          continue;
        }
        if (res.state === MISSING) {
          out.push({ ...row, state: 'orphaned', reason: 'no action in that mod matches this key any more' });
          continue;
        }
        const comp = db.prepare('SELECT ComponentType AS type, ComponentId AS id FROM Components WHERE ComponentRowId = ?')
          .get(res.componentRowId);
        const before = currentValue(db, res.componentRowId);
        out.push({
          ...row,
          state: before === String(entry.value) ? 'applied' : 'drifted',
          componentRowId: res.componentRowId,
          type: comp.type,
          id: comp.id,
          inDatabase: before,
          reason: before === String(entry.value) ? null : `the database has ${before === null ? 'no value' : before}`,
        });
      }
    }
    for (const g of groupsOf(db)) groups.push({ id: g.id, name: g.name, selected: !!g.selected });
    return {
      ok: true,
      error: stored.error,
      unusable: stored.unusable,
      groups,
      stale: staleMods(dbPath, { file }),
      count: out.length,
      overrides: out,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  VERSION, FIND, MISSING, AMBIGUOUS, SENTINEL, MIN_FREE_RUN, MAX_BULK_ENTRIES,
  overridesFile, openDb,
  keyFor, actionKey, resolveAction, isModId,
  readOverrides, writeOverrides, setOverride, clearOverride,
  modFile, stampFor, stampIsStale,
  applyOverrides, applyBulk, resetOverride, resetModOverrides, discardModOverrides, syncOverrides, staleMods, listOverrides,
  profileLoadOrder, verdictOf, evalCondition, setupKeysFor, isAssumedMatch,
  actionFiles, actionFilesOf, modActionFilesOf,
  describeBlock, proposeBlock, occupiedOf,
  buildEvenSpacing, buildOverflow, buildManual,
};
