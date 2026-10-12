'use strict';

// Mod-set switch for play-from-save: snapshot the active group's enabled
// flags, switch to the save's required set, and put the previous set back
// after quit. One responsibility (ADR-013): this module owns the snapshot
// sidecar and the switch math; the boot order (when to switch, when to
// undo) stays in play-save.js, and the write itself stays in modsdb.

const fs = require('fs');
const paths = require('./paths');
const { normId } = require('./modinfo');
const { readModState, applyChanges } = require('./modsdb');

// Sidecar holding the pre-boot enabled set. Wrong extension on purpose:
// the game never scans it, and it survives a server restart so the
// restore banner can find it.
function modsetSidecarPath(dbPath) {
  const base = dbPath || (() => { try { return paths.getModsDb().path; } catch (_) { return null; } })();
  return base ? `${base}.toolkit-modset` : null;
}

// Previous enabled set as [{ modId, enabled }]. Mods with no row in the
// active group (disabled null) are not switchable and stay out.
function previousOf(state) {
  return (state.mods || [])
    .filter((m) => m.disabled != null)
    .map((m) => ({ modId: m.modId, enabled: m.disabled === false }));
}

// Player-words refusal naming every required mod the switch cannot reach:
// not in the game's database yet, or known but outside the active group.
function unswitchableWarning(unknown, saveName) {
  const named = unknown.map((m) => `"${m.title || m.id}" (${m.id})`).join(', ');
  const count = unknown.length === 1 ? 'a mod the game has not listed yet' : `${unknown.length} mods the game has not listed yet`;
  return `The save "${saveName}" needs ${count}: ${named}. `
    + 'Start Civilization VI once with those mods present so the game lists them, '
    + 'then try again. Nothing was changed.';
}

// Record the current enabled set beside the database. readStateFn is
// injectable so tests never open the real database (see ADR-006).
function snapshotModSet(dbPath, opts = {}) {
  const base = dbPath || (() => { try { return paths.getModsDb().path; } catch (_) { return null; } })();
  if (!base) throw new Error('Mod database not found.');
  const read = opts.readStateFn || readModState;
  const state = read(base);
  if (!state.ok) throw new Error(state.error || 'Mod database not found.');
  const previous = previousOf(state);
  const sidecar = modsetSidecarPath(base);
  fs.writeFileSync(sidecar, JSON.stringify({ at: new Date().toISOString(), previous }));
  return { dbPath: base, snapshotPath: sidecar, previous };
}

// Switch the enabled set to exactly requiredIds (normalized). Unknown or
// ungrouped ids refuse with names before anything is written. A required
// mod that is ungrouped but default-on counts as satisfied: the game loads
// it with no row in the active group, so there is nothing to flip and
// nothing to write. The default-on flag is readModState's predicate alone
// (see src/modsdb.js) and is only read here, never recomputed (see ADR-013).
function switchToSaveMods(dbPath, requiredIds, opts = {}) {
  const base = dbPath || (() => { try { return paths.getModsDb().path; } catch (_) { return null; } })();
  if (!base) throw new Error('Mod database not found.');
  const wanted = new Set((requiredIds || []).map((id) => normId(id)));
  const read = opts.readStateFn || readModState;
  const state = read(base);
  if (!state.ok) throw new Error(state.error || 'Mod database not found.');
  const rows = new Map((state.mods || []).map((m) => [normId(m.modId), m]));
  const unknown = [];
  for (const id of wanted) {
    const row = rows.get(id);
    if (!row || (row.disabled == null && !row.defaultOn)) {
      const fromSave = (opts.saveMods || []).find((m) => normId(m.id) === id);
      unknown.push({ id: fromSave ? fromSave.id : id, title: fromSave ? fromSave.title : null });
    }
  }
  if (unknown.length) {
    const err = new Error('unswitchable');
    err.unknown = unknown;
    throw err;
  }
  const flips = [];
  for (const m of state.mods || []) {
    if (m.disabled == null) continue;
    const shouldBeOn = wanted.has(m.idNorm || normId(m.modId));
    if ((m.disabled === false) !== shouldBeOn) flips.push({ modId: m.modId, enabled: shouldBeOn });
  }
  if (!flips.length) return { dbPath: base, switched: false, changed: 0 };
  const snap = snapshotModSet(base, opts);
  const apply = opts.applyChangesFn || applyChanges;
  const r = apply(base, flips);
  return { dbPath: base, switched: true, changed: flips.length, backupPath: r.backupPath, snapshotPath: snap.snapshotPath };
}

// Put the snapshotted set back. Ids that vanished since are reported as
// skipped, never deleted. Refused while Civ6 runs (see ADR-006).
async function restoreModSet(dbPath, opts = {}) {
  const base = dbPath || (() => { try { return paths.getModsDb().path; } catch (_) { return null; } })();
  if (!base) return { ok: false, error: 'Mod database not found.' };
  const sidecar = modsetSidecarPath(base);
  let snap = null;
  try {
    snap = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  } catch (_) {
    return { ok: false, error: 'There is no saved mod set to put back.' };
  }
  const statusFn = opts.gameStatusFn || require('./game').gameStatus;
  const game = await statusFn();
  if (game.running) return { ok: false, code: 'civ6-running', error: 'Civilization VI is running. Quit the game first, then put your mods back.' };
  const read = opts.readStateFn || readModState;
  const state = read(base);
  if (!state.ok) return { ok: false, error: state.error || 'Mod database not found.' };
  const rows = new Map((state.mods || []).map((m) => [normId(m.modId), m]));
  const changes = [];
  const skipped = [];
  for (const p of snap.previous || []) {
    const row = rows.get(normId(p.modId));
    if (!row || row.disabled == null) { skipped.push(p.modId); continue; }
    if ((row.disabled === false) !== !!p.enabled) changes.push({ modId: row.modId, enabled: !!p.enabled });
  }
  if (changes.length) {
    const apply = opts.applyChangesFn || applyChanges;
    try {
      apply(base, changes);
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  try { fs.unlinkSync(sidecar); } catch (_) { /* already gone */ }
  return { ok: true, restored: changes.length, skipped };
}

// Undo a switch after a failed boot: best effort, never throws (the boot
// failure is the error that matters; a failed undo keeps the sidecar so
// the banner path retries it).
async function undoModSwitch(dbPath, opts = {}) {
  try {
    const r = await restoreModSet(dbPath, { ...opts, gameStatusFn: opts.gameStatusFn || (() => Promise.resolve({ running: false })) });
    return r;
  } catch (_) {
    return { ok: false };
  }
}

// Whether a previous set is waiting to be put back.
function modsSnapshotPending(dbPath) {
  const sidecar = modsetSidecarPath(dbPath);
  if (!sidecar) return false;
  try { return fs.statSync(sidecar).isFile(); } catch (_) { return false; }
}

module.exports = {
  modsetSidecarPath,
  snapshotModSet,
  switchToSaveMods,
  restoreModSet,
  undoModSwitch,
  modsSnapshotPending,
  unswitchableWarning,
};
