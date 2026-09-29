'use strict';

// Overrides for individual mod actions' LoadOrder, in one JSON file beside
// civ6-paths.json. Global, not per profile: LoadOrder is a property of the
// installation, and two profiles holding the same mod should load that mod's
// actions at the same position.
//
// Keys are modinfo.normId() output - the mod's own GUID from its .modinfo,
// lowercased and unbraced - and NOT ModRowId, which the game renumbers on every
// rescan. The action key inside a mod is (ComponentType, id, file list); see
// actionKey() for why those three and nothing else.
//
// Reading never throws and never writes. A file we wrote ourselves that we can
// no longer parse must degrade to "no overrides with a message", never take the
// mod list down with it.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normId } = require('./modinfo');
const { atomicWrite } = require('./editor');
const { fileTimeOf } = require('./modsdb');

const VERSION = 1;
// A key is a type, an id and a file list. Nothing in the library makes one this
// long; the cap is here so a hand-edited file cannot put megabytes in a key.
const MAX_KEY = 4000;
// The library contains -200, 4, 1e8 and 22222 as legitimate author choices, so
// values are checked for being whole numbers and not for being in a range.
const MIN_VALUE = -1e9;
const MAX_VALUE = 1e12;

// Where the file lives. Overridable, for tests and for a relocated install.
function overridesFile() {
  return process.env.CIV6_LOADORDER_FILE || path.join(__dirname, '..', 'load-order-overrides.json');
}

// ---------------------------------------------------------------------------
// Action identity
// ---------------------------------------------------------------------------

// The key is (ComponentType, id, sorted file list), newline separated.
//
// The components were chosen by measuring collisions within a mod across all
// 3176 actions in the library:
//
//   id alone                        760 (23.91%)  - Civ6's editor leaves NewAction
//   (id, type)                       99 ( 3.12%)
//   (file list, type)               286 ( 9.00%)  - 8.2% of actions have no files
//   (file list, type, id)            11 ( 0.35%)  <- chosen
//   the same, plus an ordinal          0           <- rejected, see below
//
// The declared LoadOrder is deliberately NOT part of the key: it is the one
// thing that changes on exactly the updates an override has to survive, so
// including it would orphan every override the moment its author bumped it.
//
// An ordinal was rejected rather than added. It is unique within a mod by
// construction, so it drives the count to zero - and that is why it is wrong.
// 48 mods hold 286 actions in 65 groups sharing an identical type and file list;
// in 38 of those the file list is empty, so the ordinal would be the only
// discriminator. Those are the large multi-action mods, and an author inserting
// one action renumbers everything after it. A wrong ordinal does not error: it
// silently moves a neighbour's action, and the user finds out three sessions
// later. A dropped override is noticed immediately. For a tool writing to a
// live game database the loud failure is worth more than the quiet one.

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
// they were measured to agree with the .modinfo on disk for 384 of 384 mods, so
// there is no need to parse any file here.
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
// fallback: the 0.35% that do not resolve uniquely are actions their own author
// never told apart, so the user cannot say which one they meant either.
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
// Storing
// ---------------------------------------------------------------------------

// A whole number, and in range. Not a range check on the author - the library
// uses -200 and 100000001 - but a bound wide enough that a typo cannot put a
// 10^30 into the database.
function cleanValue(v) {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) throw new Error('a load order must be a whole number');
  if (n < MIN_VALUE || n > MAX_VALUE) throw new Error('that load order is out of range');
  return n;
}

// A Civ6 mod id is a GUID. Every one of the 426 distinct ModIds in a real
// library is GUID-shaped once normId has stripped the braces some mods carry -
// measured, not assumed, because a check that could reject a real mod would be
// worse than the junk it filters.
//
// normId itself does not validate: it lowercases and strips braces, so a
// hand-edited key of "not-a-guid" survives it. That is right for a comparison
// key and wrong for a storage key, because such an entry can never match a mod
// and would sit in the file forever claiming to be an override.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isModId(k) {
  return !!k && GUID.test(k);
}

// A key arrives from the database or from a hand-edited file, so it is checked
// for shape rather than trusted.
function cleanKey(k) {
  const s = String(k == null ? '' : k);
  if (!s) throw new Error('which action?');
  if (s.length > MAX_KEY) throw new Error(`that action key is longer than ${MAX_KEY} characters`);
  return s;
}

function cleanModId(id) {
  const k = normId(id);
  if (!k) throw new Error('which mod?');
  if (!isModId(k)) throw new Error(`"${k}" is not a mod id`);
  return k;
}

// The file's own text -> { overrides, error, unusable }. Two levels of failure,
// and the difference matters: a file that is not the shape we write is unusable
// as a whole, while one bad entry among good ones costs only that entry.
function parse(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { overrides: {}, error: `load-order-overrides.json is not valid JSON (${e.message})`, unusable: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrides: {}, error: 'load-order-overrides.json does not contain an object', unusable: true };
  }
  // A missing version is treated as the current one, so a file written before
  // the field existed still loads. A different one we did not write, and whose
  // shape we cannot vouch for, is refused rather than half-understood.
  if (raw.version !== undefined && raw.version !== VERSION) {
    return {
      overrides: {},
      error: `load-order-overrides.json is version ${JSON.stringify(raw.version)}; this toolkit reads version ${VERSION}`,
      unusable: true,
    };
  }
  if (raw.overrides === undefined || raw.overrides === null) return { overrides: {}, error: null };
  if (typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)) {
    return { overrides: {}, error: 'load-order-overrides.json has no "overrides" object', unusable: true };
  }

  const overrides = {};
  let dropped = 0;
  for (const [rawId, byKey] of Object.entries(raw.overrides)) {
    const id = normId(rawId);
    if (!isModId(id) || !byKey || typeof byKey !== 'object' || Array.isArray(byKey)) { dropped++; continue; }
    const set = {};
    for (const [rawKey, entry] of Object.entries(byKey)) {
      // A bare number is accepted so a hand-written file works. The richer form
      // carries the author's declared value, which is the only copy left once
      // we have overwritten the database - see setOverride.
      const value = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry.value : entry;
      let n;
      try { n = cleanValue(value); } catch (_) { dropped++; continue; }
      const out = { value: n };
      if (entry && typeof entry === 'object' && entry.declared !== undefined) {
        try { out.declared = cleanValue(entry.declared); } catch (_) { /* not fatal - reset is the only thing it is for */ }
      }
      set[cleanKey(rawKey)] = out;
    }
    if (Object.keys(set).length) overrides[id] = set;
  }
  return {
    overrides,
    error: dropped
      ? `${dropped} entr${dropped === 1 ? 'y' : 'ies'} in load-order-overrides.json could not be read and ${dropped === 1 ? 'was' : 'were'} ignored`
      : null,
  };
}

function view(overrides, error, unusable = false) {
  let count = 0;
  for (const set of Object.values(overrides)) count += Object.keys(set).length;
  return { overrides, count, error: error || null, unusable };
}

// Read the file. Nothing is written here, ever.
//
// `known` is the set of mod ids the caller can vouch for, or null when it
// cannot - the database would not read, or the game is part-way through a
// rescan. Pruning against an incomplete set would delete real overrides, so
// those reads prune nothing.
function readOverrides(file = overridesFile(), known = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // No file is the normal state. Having no overrides is not a failure.
    if (e.code === 'ENOENT') return view({}, null);
    return view({}, `load-order-overrides.json could not be read (${e.message})`, true);
  }
  if (!text.trim()) return view({}, null); // an empty file is no overrides

  const { overrides, error, unusable } = parse(text);
  if (known) {
    for (const id of Object.keys(overrides)) {
      if (!known.has(id)) delete overrides[id];
    }
  }
  return view(overrides, error, unusable);
}

// Write the map out. One plain file and no backups, on the same reasoning as
// mod-labels.json: it is a few kilobytes, written by one synchronous handler,
// and a lost override is a nuisance rather than a hazard. Mods.sqlite earns its
// ten backups because the game writes it too and can be interrupted mid-write.
//
// Keys are written in sorted order so the file is stable and diffable by hand -
// which matters because the action key is a readable string on purpose, so a
// user reporting "my override stopped matching" can be answered by looking.
function writeOverrides(file, overrides) {
  const body = { version: VERSION, overrides: {} };
  for (const id of Object.keys(overrides).sort()) {
    const set = overrides[id];
    if (!set || !Object.keys(set).length) continue;
    const out = {};
    for (const k of Object.keys(set).sort()) {
      const e = set[k];
      out[k] = e && e.declared !== undefined ? { value: e.value, declared: e.declared } : e.value;
    }
    body.overrides[id] = out;
  }
  atomicWrite(file, JSON.stringify(body, null, 2));
}

// The read a write is built on. Refuses outright if the file exists but is not
// the shape we write: building on an unreadable file would replace whatever it
// holds, and a corrupt file is fixed or deleted by hand rather than overwritten
// by a click the user did not think of as destructive.
function readForWrite(file, known) {
  const v = readOverrides(file, known);
  if (v.unusable) {
    throw new Error(`${v.error} - nothing was written. Fix or delete load-order-overrides.json, then try again.`);
  }
  return v;
}

// Store one action's override, and return the refreshed view.
//
// `declared` is the author's value as the game currently has it, and it is kept
// because the moment we write the override the database no longer holds it -
// nothing else does. Reset needs it, and it is what the view shows as
// "author declares 5000".
//
// The file is re-read inside the call rather than sent by the caller: two tabs
// open, each overriding a different action, and a client that PUT the whole file
// would silently discard the other tab's change. Node handles one request at a
// time on one thread, so read-modify-write needs no lock.
function setOverride(file, modId, key, value, declared) {
  const id = cleanModId(modId);
  const k = cleanKey(key);
  const v = cleanValue(value);
  const current = readForWrite(file, null);

  const entry = { value: v };
  if (declared !== undefined && declared !== null) {
    try { entry.declared = cleanValue(declared); } catch (_) { /* optional */ }
  }
  const set = { ...(current.overrides[id] || {}) };
  // A new declared value is only recorded when we have one. Losing a recorded
  // one because the caller could not read the current value would be worse than
  // not having recorded it.
  if (entry.declared === undefined && set[k] && set[k].declared !== undefined) {
    entry.declared = set[k].declared;
  }
  set[k] = entry;

  const next = { ...current.overrides, [id]: set };
  writeOverrides(file, next);
  return readOverrides(file, null);
}

// Forget one action's override. The caller restores the author's value in the
// database; this only stops the toolkit putting it back on the next sync.
function clearOverride(file, modId, key) {
  const id = cleanModId(modId);
  const k = cleanKey(key);
  const current = readForWrite(file, null);
  if (!current.overrides[id] || !(k in current.overrides[id])) {
    throw new Error('no override is stored for that action');
  }
  const set = { ...current.overrides[id] };
  delete set[k];
  const next = { ...current.overrides };
  if (Object.keys(set).length) next[id] = set; else delete next[id];

  writeOverrides(file, next);
  return readOverrides(file, null);
}

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
// 42 of 427 rows are base-game or DLC assets recorded with relative ../../../
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

module.exports = {
  VERSION, FIND, MISSING, AMBIGUOUS,
  overridesFile, openDb,
  keyFor, actionKey, resolveAction, isModId,
  readOverrides, writeOverrides, setOverride, clearOverride,
  modFile, stampFor, stampIsStale,
};
