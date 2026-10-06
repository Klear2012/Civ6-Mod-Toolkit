'use strict';

// File store behind the load order editor: validating, reading, and writing
// load-order-overrides.json, plus folding applied values back in. Split out of
// src/loadorder.js (facade re-export there). This module owns VERSION,
// MAX_KEY, MIN/MAX_VALUE, SENTINEL, and GUID; everyone else requires the
// owner, never duplicates. Requires only leaves (fs, path, ./editor,
// ./modinfo), so the require graph stays acyclic.

const fs = require('fs');
const path = require('path');
const { normId } = require('./modinfo');
const { atomicWrite } = require('./editor');

const VERSION = 1;
// A key is a type, an id and a file list. Nothing in the library makes one this
// long; the cap is here so a hand-edited file cannot put megabytes in a key.
const MAX_KEY = 4000;
// The library contains -200, 4, 1e8 and 22222 as legitimate author choices, so
// values are checked for being whole numbers and not for being in a range.
const MIN_VALUE = -1e9;
const MAX_VALUE = 1e12;
// Civ6's "load last, override everything" sentinel. Moving an action off one of
// these changes the author's intent, so the caller is told - it is not refused,
// because a refusal here would be the toolkit overruling a decision the user
// made on purpose.
const SENTINEL = 10000000;

// Where the file lives. Overridable, for tests and for a relocated install.
function overridesFile() {
  return process.env.CIV6_LOADORDER_FILE || path.join(__dirname, '..', 'load-order-overrides.json');
}

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

// Fold what was applied into the store, in one file write.
//
// A declared value already on file always wins over one read out of the database
// during this apply. By then the database holds the override, not the author's
// choice, so taking the fresh reading would replace 9999 with 4242 and leave
// reset restoring the override. Only a first apply, which has nothing on file,
// takes the value it read.
function recordApplied(file, applied) {
  const current = readForWrite(file, null);
  const next = { ...current.overrides };
  for (const a of applied) {
    const id = normId(a.modId);
    const set = { ...(next[id] || {}) };
    const onFile = set[a.key] ? set[a.key].declared : undefined;
    const declared = onFile !== undefined ? onFile : a.declared;
    set[a.key] = declared === undefined || declared === null ? { value: a.value } : { value: a.value, declared };
    next[id] = set;
  }
  writeOverrides(file, next);
  return readOverrides(file, null);
}

module.exports = {
  VERSION, MAX_KEY, MIN_VALUE, MAX_VALUE, SENTINEL, GUID,
  overridesFile,
  cleanValue, isModId, cleanKey, cleanModId,
  parse, view, readOverrides, writeOverrides, readForWrite,
  setOverride, clearOverride, recordApplied,
};
