'use strict';

// UI file-shadowing enumeration (conflict-diagnosis task 3.1).
//
// Enumerates every UI path claimed by more than one enabled mod, sourcing
// file claims from Components/ComponentFiles/ModFiles UNION script-replacement
// claims from ComponentProperties.LuaReplace.
//
// The union is the whole point: a ReplaceUIScript action carries NO
// ComponentFiles links (see phase4 Test 14 - "the action with no <File> gets
// no link"), so its LuaReplace target is invisible to any file-list-only scan.
// A contest that exists only via LuaReplace reads as uncontested without it.
//
// Read-only: every query below is a SELECT. Callers open the database with
// node:sqlite { readOnly: true } and pass the handle in; this module never
// opens or writes anything itself.
//
// Scope: task 3.1 is enumeration with per-path claimant lists; task 3.2 adds
// the winner rule (strictly-greatest declared LoadOrder, else undefined with
// reason) in decideContestedPath / resolveWinners below; task 3.3 adds the
// timed envelope (scope counts + contested/decidable/undefined-by-reason +
// wall-clock) in buildEnvelope / formatEnvelope. No secondary signals
// live here by construction: the only table the winner rule reads beyond the
// claimant lists is ComponentProperties LoadOrder.

// Slash-unify and trim so a ModFiles row of `UI\Panel.lua` and a LuaReplace
// value of `UI/Panel.lua` join on one key. Case is preserved: the database
// stores the strings as written and this module does not second-guess them.
function normalizePath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').trim();
}

// The selected mod group, or null when the database names none (a minimal
// fixture without ModGroups). Null means "no scoping" downstream.
function activeGroupId(db) {
  try {
    const g = db.prepare('SELECT ModGroupRowId AS id FROM ModGroups WHERE Selected = 1 LIMIT 1').get();
    return g ? g.id : null;
  } catch (_) {
    return null;
  }
}

// ModRowIds switched on in the group, or null when there is no group to scope
// to. A mod with no ModGroupItems row in the group is NOT enabled (same rule
// as the load-order profile read: membership is by row, not by ModId).
function enabledModRowIds(db, groupId) {
  if (groupId == null) return null;
  try {
    const rows = db.prepare(
      'SELECT ModRowId AS id FROM ModGroupItems WHERE ModGroupRowId = ? AND Disabled = 0'
    ).all(groupId);
    return new Set(rows.map((r) => r.id));
  } catch (_) {
    return null;
  }
}

// ModRowId -> { modId, name }. Best-effort English name: the mod's own text
// for its Name tag, else the raw tag value, else the ModId. Never throws;
// a bare Mods table is enough.
function modIndex(db) {
  const out = new Map();
  for (const m of db.prepare('SELECT ModRowId AS rowId, ModId AS modId FROM Mods').all()) {
    out.set(m.rowId, { modId: String(m.modId), name: String(m.modId) });
  }
  let props = [];
  try {
    props = db.prepare("SELECT ModRowId AS rowId, Value AS value FROM ModProperties WHERE Name = 'Name'").all();
  } catch (_) {
    return out;
  }
  let texts = [];
  try {
    texts = db.prepare("SELECT ModRowId AS rowId, Tag AS tag, Text AS text FROM LocalizedText WHERE Locale = 'en_US'").all();
  } catch (_) {
    texts = [];
  }
  const textOf = new Map();
  for (const t of texts) textOf.set(`${t.rowId}\n${t.tag}`, t.text);
  for (const p of props) {
    const e = out.get(p.rowId);
    if (!e || p.value == null) continue;
    e.name = textOf.get(`${p.rowId}\n${p.value}`) || String(p.value);
  }
  return out;
}

// Every claim in the database: normalized path -> Map(modRowId -> entry).
// Unscoped and unfiltered - scoping and the >1-claimant cut happen in
// enumerateContested, so a caller that wants the raw union can have it.
function collectClaims(db) {
  const byPath = new Map();
  const add = (rawPath, modRowId, claim) => {
    const path = normalizePath(rawPath);
    if (!path) return;
    let mods = byPath.get(path);
    if (!mods) {
      mods = new Map();
      byPath.set(path, mods);
    }
    let entry = mods.get(modRowId);
    if (!entry) {
      entry = { sources: new Set(), components: [] };
      mods.set(modRowId, entry);
    }
    entry.sources.add(claim.source);
    entry.components.push(claim);
  };

  for (const r of db.prepare(
    `SELECT c.ModRowId AS modRowId, c.ComponentRowId AS componentRowId,
            c.ComponentType AS componentType, c.ComponentId AS componentId,
            f.Path AS filePath
       FROM ComponentFiles cf
       JOIN Components c ON c.ComponentRowId = cf.ComponentRowId
       JOIN ModFiles f ON f.FileRowId = cf.FileRowId`
  ).all()) {
    add(r.filePath, r.modRowId, {
      source: 'file',
      componentRowId: r.componentRowId,
      componentType: r.componentType,
      componentId: r.componentId,
    });
  }

  // ReplaceUIScript targets live ONLY here, with zero ComponentFiles links.
  for (const r of db.prepare(
    `SELECT c.ModRowId AS modRowId, c.ComponentRowId AS componentRowId,
            c.ComponentType AS componentType, c.ComponentId AS componentId,
            p.Value AS target
       FROM ComponentProperties p
       JOIN Components c ON c.ComponentRowId = p.ComponentRowId
      WHERE p.Name = 'LuaReplace'`
  ).all()) {
    add(r.target, r.modRowId, {
      source: 'LuaReplace',
      componentRowId: r.componentRowId,
      componentType: r.componentType,
      componentId: r.componentId,
    });
  }
  return byPath;
}

// [{ path, claimants: [{ modId, name, sources, components }] }], sorted by
// path (claimants sorted by modId). Only paths with more than one ENABLED
// claimant mod appear; a path claimed twice by one mod, or by one enabled
// mod plus disabled ones, is uncontested and omitted.
function enumerateContested(db) {
  const enabled = enabledModRowIds(db, activeGroupId(db));
  const mods = modIndex(db);
  const byPath = collectClaims(db);
  const out = [];
  for (const [path, claimants] of byPath) {
    const list = [];
    for (const [modRowId, entry] of claimants) {
      if (enabled && !enabled.has(modRowId)) continue;
      const m = mods.get(modRowId) || { modId: String(modRowId), name: String(modRowId) };
      list.push({
        modId: m.modId,
        name: m.name,
        sources: [...entry.sources].sort(),
        components: entry.components.map((c) => ({ ...c })),
      });
    }
    if (list.length > 1) {
      list.sort((a, b) => (a.modId < b.modId ? -1 : a.modId > b.modId ? 1 : 0));
      out.push({ path, claimants: list });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

module.exports = {
  normalizePath,
  activeGroupId,
  enabledModRowIds,
  modIndex,
  collectClaims,
  enumerateContested,
  parseLoadOrderValue,
  componentLoadOrders,
  claimantLoadOrder,
  decideContestedPath,
  resolveWinners,
  scopeCounts,
  buildEnvelope,
  formatEnvelope,
};

// Winner rule (task 3.2): strictly-greatest declared LoadOrder wins, else the
// path is undefined with reason no-declared-order (no claimant declares) or
// tie (shared max). Read-only; never picks, ranks, or implies a winner by any
// secondary signal (no content hashing, no filename heuristics, no install or
// scan order).

// A declared LoadOrder value, or null when there is none. Only the correctly
// spelled ComponentProperties row counts: a misspelled row (LaodOrder,
// LoadingOrder) is invisible to the engine, so for winner purposes the action
// declares nothing. Non-integer values are likewise undeclared rather than
// guessed at.
function parseLoadOrderValue(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n)) return null;
  return n;
}

// ComponentRowId -> declared integer LoadOrder, for every component carrying
// a correctly spelled, integer-parsable LoadOrder row. One SELECT per
// enumeration, shared by every contested path.
function componentLoadOrders(db) {
  const out = new Map();
  for (const r of db.prepare(
    "SELECT ComponentRowId AS cr, Value AS value FROM ComponentProperties WHERE Name = 'LoadOrder'"
  ).all()) {
    const n = parseLoadOrderValue(r.value);
    if (n !== null) out.set(r.cr, n);
  }
  return out;
}

// One claimant mod's declared value for a path: the max LoadOrder across the
// claiming components only (the components array of one enumerateContested
// claimant), or null when none of them declares. A LoadOrder on some other
// action of the same mod does not contend for this path, so it must not
// count: only the actions actually claiming the path decide. Two components
// of one mod claiming one path fold to their max, since the mod's
// latest-loading claim is the one that would contend.
function claimantLoadOrder(loadMap, components) {
  let best = null;
  for (const c of components || []) {
    const n = loadMap.get(c.componentRowId);
    if (n === undefined) continue;
    if (best === null || n > best) best = n;
  }
  return best;
}

// One enumerateContested entry ->
//   { path, status, reason, winner, tied, claimants }
// where status is 'decided' (winner { modId, name, value }, reason null) or
// 'undefined' (winner null, reason 'no-declared-order' with tied null, or
// reason 'tie' with value and tied [{ modId, name }] listing the sharers of
// the max). claimants carries every claimant with its per-mod value (null
// when that mod declares nothing for this path), in the entry's existing
// (modId-sorted) order. Tied claimants keep that order and are never ranked:
// a sorted claimant list is deterministic output order, not a verdict, and
// winner stays null on every undefined path.
function decideContestedPath(loadMap, entry) {
  const claimants = (entry.claimants || []).map((c) => ({
    modId: c.modId,
    name: c.name,
    sources: [...c.sources],
    value: claimantLoadOrder(loadMap, c.components),
  }));
  const declared = claimants.filter((c) => c.value !== null);
  if (!declared.length) {
    return { path: entry.path, status: 'undefined', reason: 'no-declared-order', winner: null, tied: null, claimants };
  }
  const max = declared.reduce((m, c) => (c.value > m ? c.value : m), declared[0].value);
  const top = declared.filter((c) => c.value === max);
  if (top.length === 1) {
    return {
      path: entry.path, status: 'decided', reason: null,
      winner: { modId: top[0].modId, name: top[0].name, value: max },
      tied: null, claimants,
    };
  }
  return {
    path: entry.path, status: 'undefined', reason: 'tie', value: max,
    winner: null, tied: top.map((c) => ({ modId: c.modId, name: c.name })), claimants,
  };
}

// Every contested path with its winner decision, sorted by path. Builds the
// LoadOrder map once; contested may be supplied (e.g. from
// enumerateContested) or read when omitted.
function resolveWinners(db, contested) {
  const list = contested || enumerateContested(db);
  const loadMap = componentLoadOrders(db);
  return list.map((e) => decideContestedPath(loadMap, e));
}

// Enumeration envelope (task 3.3): the enabled scope plus the timed
// enumerate-then-decide outcome. Read-only; wall-clock covers the
// enumerateContested + resolveWinners pass only, never fixture seeding.
function scopeCounts(db) {
  const enabled = enabledModRowIds(db, activeGroupId(db));
  if (!enabled) {
    return {
      mods: db.prepare('SELECT count(*) AS n FROM Mods').get().n,
      components: db.prepare('SELECT count(*) AS n FROM Components').get().n,
    };
  }
  const ids = [...enabled];
  if (!ids.length) return { mods: 0, components: 0 };
  const holes = ids.map(() => '?').join(',');
  return {
    mods: ids.length,
    components: db.prepare(
      `SELECT count(*) AS n FROM Components WHERE ModRowId IN (${holes})`
    ).get(...ids).n,
  };
}

function buildEnvelope(db) {
  const t0 = Date.now();
  const contested = enumerateContested(db);
  const decided = resolveWinners(db, contested);
  const wallClockMs = Date.now() - t0;
  let decidable = 0;
  let noDeclaredOrder = 0;
  let ties = 0;
  for (const d of decided) {
    if (d.status === 'decided') decidable += 1;
    else if (d.reason === 'tie') ties += 1;
    else noDeclaredOrder += 1;
  }
  const scope = scopeCounts(db);
  return {
    mods: scope.mods,
    components: scope.components,
    contested: contested.length,
    decidable,
    undefined: decided.length - decidable,
    noDeclaredOrder,
    ties,
    wallClockMs,
  };
}

function formatEnvelope(env) {
  return `envelope: ${env.mods} mods / ${env.components} components / ` +
    `${env.contested} contested (${env.decidable} decidable / ` +
    `${env.noDeclaredOrder} no-declared-order / ${env.ties} tie) in ${env.wallClockMs}ms`;
}
