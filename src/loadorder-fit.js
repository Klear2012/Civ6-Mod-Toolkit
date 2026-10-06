'use strict';

// Fit geometry behind the load order editor: which values one
// mod's actions move to, and what that move would disturb. Split out of
// src/loadorder.js (facade re-export there). Read-only: nothing here
// writes the database, the store, or a backup.
//
// Loadorder-owned deps (modFile, stampIsStale, cleanValue, SENTINEL,
// MIN/MAX_VALUE) arrive via initFit, called once by the facade - the
// parameter-passing fallback from the split design: the store module that
// would own cleanValue/SENTINEL does not exist yet, so fit cannot require
// them without a cycle. normId/MISSPELLINGS come from leaf modules.

const { normId } = require('./modinfo');
const { MISSPELLINGS } = require('./gates');

let modFile;
let stampIsStale;
let cleanValue;
let SENTINEL;
let MIN_VALUE;
let MAX_VALUE;

function initFit(deps) {
  modFile = deps.modFile;
  stampIsStale = deps.stampIsStale;
  cleanValue = deps.cleanValue;
  SENTINEL = deps.SENTINEL;
  MIN_VALUE = deps.MIN_VALUE;
  MAX_VALUE = deps.MAX_VALUE;
}

// Block-move proposal (load-order-edit 1.1, 1.2). Read-only: nothing below
// writes the database, the store, or a backup. describeBlock/proposeBlock
// read one mod plus caller-supplied profile bands; the builders are pure
// functions of those inputs. ComponentFiles is never read here: shared
// filenames are not conflicts and never warn. Identity is ComponentRowId;
// key mapping goes through resolveAction per key, never for all actions.
// Shapes: a block is describeBlock's return ({ actions:[{componentRowId,
// effective, offset, misspelled, drifted}], min/max/width/count/tie,
// undeclared, protectable }); a mapping row is {componentRowId, from, to}.
// Targets (proposeBlock/resolveBase): {base} literal start, {after} first
// value above it, {before} snug fit ending below it, {gap:{from,to}} an
// explicit free run (to null = headroom, unbounded). Fit returns
// {fits:true, base, need, gap, mapping, warnings}; no-fit returns
// {fits:false, need, gap, options:['even','overflow','manual']} and writes
// nothing. Builders return {strategy, mapping, warnings} plus their own
// extras (gap / direction+base / invalid+hints). Warnings (collectWarnings)
// are {kind, message} with kind tie/sentinel/range/misspelling/drifted/
// unprotectable; they never block, only no-fit does.
// One mod's positioned actions as a movable block. Reads only this mod's
// rows, never the library. Undeclared actions are counted and EXCLUDED from
// actions so no builder moves one by accident. opts.driftedByRow marks rows
// as { [componentRowId]: true | { before, wanted } } for the drift warning.
// Returns { modId, modRowId, missing, protectable, stale, actions, min, max,
// width, count, tie, undeclared, undeclaredCount }. Undeclared actions are
// counted only, never positioned, so no builder can move one by accident.
function describeBlock(db, modIdNorm, opts = {}) {
  const modId = normId(modIdNorm);
  const mod = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(modId);
  if (!mod) return { modId, modRowId: null, missing: true, protectable: false, stale: null,
    actions: [], min: null, max: null, width: 0, count: 0, tie: false,
    undeclared: [], undeclaredCount: 0 };
  const rows = db.prepare(
    `SELECT c.ComponentRowId AS cr, cp.Name AS name, cp.Value AS value
       FROM Components c
       LEFT JOIN ComponentProperties cp ON cp.ComponentRowId = c.ComponentRowId
         AND cp.Name IN ('LoadOrder','LaodOrder','LoadingOrder')
      WHERE c.ModRowId = ? ORDER BY c.ComponentRowId`
  ).all(mod.ModRowId);
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.cr)) seen.set(r.cr, {});
    if (r.name) seen.get(r.cr)[r.name] = String(r.value);
  }
  const positioned = [];
  const undeclared = [];
  for (const [cr, props] of seen) {
    if (props.LoadOrder !== undefined) {
      positioned.push({ componentRowId: cr, effective: Number(props.LoadOrder), misspelled: false });
    } else {
      const bad = MISSPELLINGS.find((m) => props[m] !== undefined);
      if (bad) positioned.push({ componentRowId: cr, effective: Number(props[bad]), misspelled: bad });
      else undeclared.push(cr);
    }
  }
  positioned.sort((a, b) => a.effective - b.effective || a.componentRowId - b.componentRowId);
  const min = positioned.length ? positioned[0].effective : null;
  const marks = opts.driftedByRow || {};
  for (const a of positioned) {
    a.offset = a.effective - min;
    const d = marks[a.componentRowId];
    a.drifted = !!d;
    a.drift = d && typeof d === 'object' ? d : null;
  }
  const file = modFile(db, mod.ModRowId);
  return { modId, modRowId: mod.ModRowId, missing: false,
    protectable: !!(file && file.onDisk), stale: stampIsStale(db, mod.ModRowId),
    actions: positioned, min, max: positioned.length ? positioned[positioned.length - 1].effective : null,
    width: positioned.length ? positioned[positioned.length - 1].effective - min : 0,
    count: positioned.length,
    tie: new Set(positioned.map((a) => a.effective)).size < positioned.length,
    undeclared, undeclaredCount: undeclared.length };
}
// Occupied values from profile bands. A value counts as taken by others
// only when a holder from another mod sits on it; the moving block's own
// values free up once it moves. Bands without holder ids (fixtures) fall
// back to treating the block's own values as its own.
function occupiedOf(bands, block) {
  const all = new Set();
  const other = new Set();
  const own = new Set((block && block.actions ? block.actions : []).map((a) => a.effective));
  const want = block ? normId(block.modId) : null;
  for (const b of bands || []) {
    if (!b || b.kind !== 'value') continue;
    all.add(b.value);
    const tagged = (b.actions || []).filter((h) => h && h.modId);
    if (tagged.length) {
      if (tagged.some((h) => normId(h.modId) !== want)) other.add(b.value);
    } else if (!own.has(b.value)) other.add(b.value);
  }
  return { all: [...all].sort((x, y) => x - y), other };
}

// Preserve offsets: new = base + offset, so spread and order never change.
function fitMapping(block, base) {
  return [...block.actions]
    .sort((a, b) => a.effective - b.effective || a.componentRowId - b.componentRowId)
    .map((a) => ({ componentRowId: a.componentRowId, from: a.effective, to: base + a.offset }));
}
// Target shapes: { base } literal start; { after } first value above it;
// { before } snug fit ending below it; { gap: { from, to } } an explicit
// free run, to null meaning headroom (unbounded). Reports the free-slot
// count from the base, so no-fit can state need-vs-gap numbers.
function resolveBase(block, bands, target) {
  const t = target || {};
  const occ = occupiedOf(bands, block);
  const need = block.width;
  const slots = need + 1; // [base, base+width] holds width+1 integers
  const freeFrom = (b) => {
    let next = null;
    for (const v of occ.all) if (occ.other.has(v) && v >= b && (next === null || v < next)) next = v;
    return { base: b, gap: next === null ? null : next - b, end: next === null ? null : next - 1 };
  };
  if (t.gap) {
    const from = Math.trunc(t.gap.from);
    if (!Number.isInteger(from)) throw new Error('that gap has no start');
    if (t.gap.to === null || t.gap.to === undefined) return { ...freeFrom(from), fits: true, need };
    const to = Math.trunc(t.gap.to);
    if (!Number.isInteger(to) || to < from) throw new Error('that gap ends before it starts');
    const r = freeFrom(from);
    const inside = to - from + 1;
    const clash = [...occ.other].some((v) => v >= from && v <= from + need);
    return { base: from, gap: Math.min(inside, r.gap === null ? inside : r.gap),
      end: to, fits: inside >= slots && !clash, need };
  }
  if (t.before !== undefined) {
    const end = Math.trunc(t.before);
    if (!Number.isInteger(end)) throw new Error('that anchor is not a whole number');
    let prev = null;
    for (const v of occ.all) if (occ.other.has(v) && v < end && (prev === null || v > prev)) prev = v;
    const gap = prev === null ? null : end - prev - 1;
    return { base: end - slots, gap, end: end - 1, fits: gap === null || gap >= slots, need };
  }
  const anchor = t.after !== undefined ? t.after : t.base;
  const b = Math.trunc(anchor === undefined ? NaN : anchor) + (t.after !== undefined ? 1 : 0);
  if (!Number.isInteger(b)) throw new Error('that target is not a whole number');
  const r = freeFrom(b);
  return { ...r, fits: r.gap === null || r.gap >= slots, need };
}
// Honest warnings, never blocks (no-fit is reported, not warned).
// Tie/sentinel/range read the mapping; misspelling/unprotectable/drifted
// read the block. Filenames are never examined here on purpose.
// One entry per kind: tie (with holders), sentinel (load-last range),
// range (outside MIN/MAX_VALUE, will be refused), misspelling, drifted,
// unprotectable. Warnings describe; no-fit is reported, not warned.
function collectWarnings(block, bands, mapping, opts = {}) {
  const warnings = [];
  const occ = occupiedOf(bands, block);
  const list = mapping || [];
  for (const m of list) {
    if (!occ.other.has(m.to)) continue;
    const band = (bands || []).find((b) => b && b.kind === 'value' && b.value === m.to);
    const holders = band && band.actions
      ? [...new Set(band.actions.filter((h) => h && h.modId && normId(h.modId) !== normId(block.modId))
        .map((h) => h.modName || h.modId))]
      : [];
    warnings.push({ kind: 'tie', componentRowId: m.componentRowId, value: m.to, holders,
      message: `load order ${m.to} is already taken`
        + (holders.length ? ` by ${holders.join(', ')}` : ' by another action')
        + ' - the game picks between tied actions arbitrarily' });
  }
  const pastLast = list.filter((m) => m.to >= SENTINEL);
  if (pastLast.length) warnings.push({ kind: 'sentinel',
    componentRowIds: pastLast.map((m) => m.componentRowId),
    message: `values at or past ${SENTINEL} load last - that changes the author's intent` });
  for (const m of list) {
    if (m.to < MIN_VALUE || m.to > MAX_VALUE) warnings.push({ kind: 'range',
      componentRowId: m.componentRowId, value: m.to,
      message: `load order ${m.to} is outside the writable range and will be refused` });
  }
  const byRow = new Map((block.actions || []).map((a) => [a.componentRowId, a]));
  for (const m of list) {
    const a = byRow.get(m.componentRowId);
    if (a && a.misspelled) warnings.push({ kind: 'misspelling', componentRowId: m.componentRowId,
      message: `that action ships ${a.misspelled} instead of LoadOrder`
        + ' - the write goes to a correctly spelled row and the typo stays untouched' });
    if (a && a.drifted) warnings.push({ kind: 'drifted', componentRowId: m.componentRowId, drift: a.drift || null,
      message: 'the database already differs from the stored override'
        + (a.drift && a.drift.before !== undefined ? ` (${a.drift.before} vs ${a.drift.wanted})` : '')
        + ' - applying overwrites that drift' });
  }
  if (!block.protectable) warnings.push({ kind: 'unprotectable',
    message: 'that mod has no .modinfo on disk, so nothing can keep its stamp'
      + ' - the value applies but the game may re-derive it' });
  return warnings;
}
// The 1.1 entry point. Read-only: measures the target gap from profile
// bands and either preserves offsets (fit) or reports need-vs-gap with
// the three no-fit options. Writes nothing, ever.
// In: (db, modIdNorm, target, { bands, driftedByRow }); bands is required
// and comes from profileLoadOrder. Missing mod -> {missing:true}; a mod with
// no positioned actions -> {empty:true, reason}. Otherwise fit or no-fit.
function proposeBlock(db, modIdNorm, target, opts = {}) {
  if (!opts.bands) throw new Error('proposeBlock needs profile bands - pass { bands } from profileLoadOrder');
  const block = describeBlock(db, modIdNorm, { driftedByRow: opts.driftedByRow });
  if (block.missing) return { missing: true, modId: block.modId, mapping: [], warnings: [] };
  if (!block.actions.length) return { empty: true, modId: block.modId, mapping: [], warnings: [],
    undeclaredCount: block.undeclaredCount, reason: 'that mod has no positioned actions to move' };
  const r = resolveBase(block, opts.bands, target);
  if (r.fits) {
    const mapping = fitMapping(block, r.base);
    return { fits: true, modId: block.modId, base: r.base, need: r.need, gap: r.gap,
      mapping, warnings: collectWarnings(block, opts.bands, mapping, opts) };
  }
  return { fits: false, modId: block.modId, base: r.base, need: r.need, gap: r.gap,
    mapping: [], warnings: [], options: ['even', 'overflow', 'manual'] };
}
// No-fit path 1: order-preserving even re-space inside an explicit gap.
// A headroom gap (to null) falls back to sequential placement from `from`.
// In: (block, bands, gap{from,to|null}, opts). Out: {strategy:'even', gap, mapping, warnings}.
function buildEvenSpacing(block, bands, gap, opts = {}) {
  if (!block || !block.actions.length) throw new Error('that mod has no positioned actions to move');
  if (!gap || gap.from === null || gap.from === undefined) throw new Error('even re-space needs a gap to fill');
  const from = Math.trunc(gap.from);
  if (!Number.isInteger(from)) throw new Error('that gap has no start');
  const ordered = [...block.actions].sort((a, b) => a.effective - b.effective || a.componentRowId - b.componentRowId);
  let values;
  if (gap.to === null || gap.to === undefined) {
    values = ordered.map((_, i) => from + i);
  } else {
    const to = Math.trunc(gap.to);
    if (!Number.isInteger(to) || to < from) throw new Error('that gap ends before it starts');
    if (ordered.length === 1) values = [from];
    else {
      const step = (to - from) / (ordered.length - 1);
      values = ordered.map((_, i) => Math.round(from + i * step));
    }
  }
  const mapping = ordered.map((a, i) => ({ componentRowId: a.componentRowId, from: a.effective, to: values[i] }));
  return { strategy: 'even', gap: { from, to: gap.to == null ? null : Math.trunc(gap.to) },
    mapping, warnings: collectWarnings(block, bands, mapping, opts) };
}
// No-fit path 2: below the occupied range, preserving offsets. The block ends
// at globalMin - 1; the end is unbounded and negatives are allowed (the
// library ships -200). Spill is below-only; the open-ended free band covers
// the other end explicitly.
// In: (block, bands, opts). Out: {strategy:'overflow', direction:'below', base, mapping, warnings}.
function buildOverflow(block, bands, opts = {}) {
  if (!block || !block.actions.length) throw new Error('that mod has no positioned actions to move');
  if (typeof opts === 'string' || typeof bands === 'string') throw new Error('spill is below-only - target the open-ended free band for the other end');
  const { all } = occupiedOf(bands, block);
  const base = !all.length ? -(block.width + 1) : all[0] - 1 - block.width;
  const mapping = fitMapping(block, base);
  return { strategy: 'overflow', direction: 'below', base, mapping,
    warnings: collectWarnings(block, bands, mapping, opts) };
}
// No-fit path 3: per-action whole numbers. Undeclared actions are
// accepted ONLY here and only when explicitly listed; every other path
// excludes them. Unknown rows and non-integers land in invalid, never in
// mapping. hints reuses the profile's own free/headroom runs.
// In: (block, bands, {componentRowId:value}, opts). Out: {strategy:'manual',
// mapping, invalid:[{componentRowId, reason}], warnings, hints}.
function buildManual(block, bands, valuesByRowId, opts = {}) {
  const entries = Object.entries(valuesByRowId || {});
  if (!entries.length) throw new Error('no manual values to map');
  const byRow = new Map((block.actions || []).map((a) => [a.componentRowId, a]));
  const undeclared = new Set(block.undeclared || []);
  const mapping = [];
  const invalid = [];
  for (const [rawRow, rawVal] of entries) {
    const cr = Number(rawRow);
    if (!Number.isInteger(cr)) { invalid.push({ componentRowId: rawRow, reason: 'not an action id' }); continue; }
    let v;
    try { v = cleanValue(rawVal); } catch (e) { invalid.push({ componentRowId: cr, reason: e.message }); continue; }
    const known = byRow.get(cr);
    if (!known && !undeclared.has(cr)) {
      invalid.push({ componentRowId: cr, reason: 'that action is not part of this mod' }); continue;
    }
    mapping.push({ componentRowId: cr, from: known ? known.effective : null, to: v });
  }
  mapping.sort((a, b) => a.componentRowId - b.componentRowId);
  const hints = (bands || []).filter((b) => b && (b.kind === 'free' || b.kind === 'headroom'))
    .map((b) => (b.kind === 'free' ? { kind: 'free', from: b.from, to: b.to, count: b.count }
      : { kind: 'headroom', from: b.from }));
  const warnings = collectWarnings(block, bands, mapping.filter((m) => m.from !== null), opts);
  return { strategy: 'manual', mapping, invalid, warnings, hints };
}

module.exports = {
  initFit,
  describeBlock, occupiedOf, fitMapping, resolveBase, collectWarnings, proposeBlock,
  buildEvenSpacing, buildOverflow, buildManual,
};
