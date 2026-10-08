'use strict';

// Import/export of the global load-order override set (change
// loadorder-overrides-import-export).
//
// Home module for the transfer pair: export shaping plus import
// validate-and-replace-with-backup. Placement: the store module owns
// VERSION/keys/file primitives and requires only leaves, so importing the
// DB-bound resolveAction there would break that invariant; the apply engine
// (src/loadorder.js) is already ~1089 lines, so a ~300-line import pipeline
// there would trip the delta budget. This module sits between them: it calls
// into both, and neither requires it back, so the require graph stays
// acyclic (see tests/arch.test.js).
//
// Import semantics (owner-decided): REPLACES the whole store with a backup
// of the previous file (no merge), and validation LENIENT-SKIPS —
// MISSING/AMBIGUOUS/malformed entries are skipped and reported with a
// reason each, never written, never guessed (ADR-004). The game guard and
// the entry cap apply to every import path here.

const fs = require('fs');
const { normId } = require('./modinfo');
const { gameStatus } = require('./game');
const { backupFile } = require('./editor');
const store = require('./loadorder-store');
const lo = require('./loadorder');

function fail(msg) {
  throw new Error(msg);
}

// Export shaping: the store content as read, verbatim, in the store's
// canonical sorted shaping — byte-identical to a clean on-disk file, so an
// export→import roundtrip on the same mod set reproduces it byte-for-byte,
// `declared` values included. Fail-closed when the file is unusable, with
// the same message as every other write path. Read-only: no guard, so the
// route works while Civ6 runs (ADR-006).
function exportOverrides(file) {
  const f = file || store.overridesFile();
  const current = store.readForWrite(f, null);
  const body = { version: store.VERSION, overrides: {} };
  for (const id of Object.keys(current.overrides).sort()) {
    const set = current.overrides[id];
    const out = {};
    for (const k of Object.keys(set).sort()) {
      const e = set[k];
      // Same leaf shaping as writeOverrides: bare numbers stay bare, so the
      // serialised form matches the file writeOverrides would produce.
      out[k] = e && e.declared !== undefined ? { value: e.value, declared: e.declared } : e.value;
    }
    body.overrides[id] = out;
  }
  return body;
}

// How many leaf entries an upload names, for the cap check. Runs on the raw
// object without touching the database or the store file.
function countUploadEntries(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
  const byMod = data.overrides;
  if (!byMod || typeof byMod !== 'object' || Array.isArray(byMod)) return 0;
  let n = 0;
  for (const set of Object.values(byMod)) {
    if (!set || typeof set !== 'object' || Array.isArray(set)) continue;
    n += Object.keys(set).length;
  }
  return n;
}

// Whole-file shape, mirroring parse(): a version we did not write, or no
// overrides object at all, refuses the whole file rather than
// half-understanding it. A missing overrides section is an empty set, which
// the zero-valid refusal below catches. Cheap and side-effect free, so it
// runs before the game guard like the bulk route's entries check.
function checkUploadShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('that file is not a load-order overrides file - nothing was written');
  }
  if (data.version !== undefined && data.version !== store.VERSION) {
    fail(`that file is version ${JSON.stringify(data.version)}; this toolkit reads version ${store.VERSION} - nothing was written`);
  }
  const byMod = data.overrides;
  if (byMod === undefined || byMod === null) return {};
  if (typeof byMod !== 'object' || Array.isArray(byMod)) {
    fail('that file has no overrides list - nothing was written');
  }
  return byMod;
}

// Import pipeline: upload → validate per-entry → replace-with-backup under
// the game guard → skipped-entries report. Answers
// {...listOverrides(), imported, skipped: [{modId, key, reason}], backupPath}
// so the route can re-render the UI from the state really on disk.
//
// Order: shape, then entry cap, then game guard, then live-store read — the
// cap is checked before the guard and before any write, so an oversized
// batch costs nothing; a corrupt live store fails closed via readForWrite
// semantics (fixed or deleted by hand, never built on).
async function importOverrides(dbPath, data, opts = {}) {
  const file = opts.file || store.overridesFile();
  const status = opts.statusFn || gameStatus;

  const byMod = checkUploadShape(data);
  const total = countUploadEntries(data);
  if (total > lo.MAX_BULK_ENTRIES) {
    fail(`that file names ${total} actions (limit ${lo.MAX_BULK_ENTRIES}) - nothing was written`);
  }

  const game = await status();
  if (game.running) fail('close Civilization VI first - it has the mod database open');

  // Refuses to build on a file it cannot read, with the existing message.
  store.readForWrite(file, null);

  const db = lo.openDb(dbPath);
  try {
    const kept = {};
    const skipped = [];
    const modRowOf = (id) => db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(id);
    for (const [rawId, set] of Object.entries(byMod)) {
      const id = normId(rawId);
      if (!id || !store.isModId(id)) {
        skipped.push({ modId: String(rawId), key: null, reason: `"${normId(rawId) || rawId}" is not a mod id` });
        continue;
      }
      if (!set || typeof set !== 'object' || Array.isArray(set)) {
        skipped.push({ modId: id, key: null, reason: 'those entries could not be read' });
        continue;
      }
      for (const [rawKey, entry] of Object.entries(set)) {
        let key;
        let value;
        try {
          key = store.cleanKey(rawKey);
          const v = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry.value : entry;
          value = store.cleanValue(v);
        } catch (e) {
          skipped.push({ modId: id, key: String(rawKey == null ? '' : rawKey), reason: e.message });
          continue;
        }
        // A bad recorded author value is not fatal — reset is the only thing
        // it is for (same rule as the store's own reader).
        let declared;
        if (entry && typeof entry === 'object' && entry.declared !== undefined) {
          try { declared = store.cleanValue(entry.declared); } catch (_) { /* optional */ }
        }
        const res = lo.resolveAction(db, id, key);
        if (res.state === lo.FIND) {
          if (!kept[id]) kept[id] = {};
          kept[id][key] = declared === undefined ? { value } : { value, declared };
          continue;
        }
        if (res.state === lo.AMBIGUOUS) {
          skipped.push({ modId: id, key, reason: `${res.candidates.length} actions in that mod match this key` });
          continue;
        }
        skipped.push({
          modId: id,
          key,
          reason: modRowOf(id)
            ? 'no action in that mod matches this key any more'
            : 'that mod is not in the database',
        });
      }
    }

    let imported = 0;
    for (const set of Object.values(kept)) imported += Object.keys(set).length;
    if (!imported) {
      fail('nothing in that file could be used — nothing was written');
    }

    // Replace: the previous bytes are kept beside the store file first, so
    // every import is reversible by copying the backup back.
    let backupPath = null;
    if (fs.existsSync(file)) backupPath = backupFile(file);
    store.writeOverrides(file, kept);
    return { ...lo.listOverrides(dbPath, { file }), imported, skipped, backupPath };
  } finally {
    db.close();
  }
}

module.exports = {
  exportOverrides,
  importOverrides,
  countUploadEntries,
};
