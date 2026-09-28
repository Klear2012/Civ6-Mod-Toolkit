'use strict';

// Civ6 Mod Toolkit: local web server + browser UI (dashboard, .Civ6Cfg editor,
// mod manager). Binds to 127.0.0.1 only.
//
//   npm start            # starts on http://127.0.0.1:8673 and opens a browser
//   PORT=1234 npm start  # custom port

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const paths = require('./paths');
const cfg = require('./civ6cfg');
const { scanMods, normId } = require('./modinfo');
const inventory = require('./inventory');
const editor = require('./editor');
const {
  readModState, readModDetails, applyChanges,
  listGroups, createGroup, duplicateGroup, renameGroup, deleteGroup, activateGroup,
  exportGroup, importGroup, registerMods, findUnregistered,
  findRemoved, removeMods, classifyPath, modFolderFault,
} = require('./modsdb');
const { gameStatus } = require('./game');

const { version: VERSION } = require('../package.json');
const PORT = parseInt(process.env.PORT, 10) || 8673;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');

// -------- helpers -----------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
    req.on('error', reject);
  });
}

function isConfigPath(p) {
  return typeof p === 'string' && /\.Civ6Cfg$/i.test(p);
}

// Mod group ids are the integer primary key. Anything else is no group.
function groupId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function listConfigs() {
  const saves = paths.getSavesDir();
  const out = [];
  if (saves.exists) {
    for (const f of fs.readdirSync(saves.root)) {
      if (!/\.Civ6Cfg$/i.test(f)) continue;
      const full = path.join(saves.root, f);
      let mods = null;
      try { mods = cfg.listMods(fs.readFileSync(full)).mods.length; } catch (_) { /* skip */ }
      out.push({ name: f, path: full, mods });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { savesRoot: saves.root, savesExists: saves.exists, configs: out };
}

// Everything the mod manager shows: the game's database joined with the mod
// folders on disk. Mods found on disk but not yet in the database (the game
// hasn't rescanned) are listed with scanned=false and can't be toggled.
function modList() {
  const installed = scanMods(paths.getSources());
  const modsDb = paths.getModsDb();
  const st = modsDb.exists ? readModState(modsDb.path) : { ok: false, error: 'Mod database not found.', mods: [] };
  const disk = new Map(installed.map((m) => [m.idNorm, m]));
  // What a sync would add, from the one place that decides. Passing the state
  // we already read avoids opening the database a second time per request.
  const todo = st.ok ? findUnregistered(modsDb.path, paths.getSources(), st) : { pending: [] };
  const needsSync = new Set(todo.pending.map((p) => p.idNorm));
  const out = [];
  const isLoc = (n) => !n || /^LOC_[A-Z0-9_]+$/i.test(n);
  for (const d of st.mods) {
    // Base-game scenarios/maps and entries the game hides aren't user-facing.
    if (d.source === 'base' || d.hidden || !/\.modinfo$/i.test(d.path)) continue;
    const f = disk.get(d.idNorm);
    out.push({
      id: d.modId,
      idNorm: d.idNorm,
      name: isLoc(d.name) && f ? f.name : d.name,
      source: f ? f.type : d.source,
      enabled: d.disabled == null ? null : !d.disabled,
      scanned: true,
      // A sync would give this mod the row it is missing, so the mod manager
      // can point at Rescan rather than offering its own button.
      needsSync: needsSync.has(d.idNorm),
      teaser: d.teaser,
      workshopId: f ? f.workshopId || null : null,
      folder: f ? f.folder : null,
      requires: d.requires,
      blocks: d.blocks,
    });
  }
  if (st.ok) {
    const inDb = new Set(st.mods.map((m) => m.idNorm));
    for (const f of installed) {
      if (inDb.has(f.idNorm)) continue;
      out.push({
        id: f.id, idNorm: f.idNorm, name: f.name, source: f.type, enabled: null, scanned: false, teaser: null,
        needsSync: true,
        workshopId: f.workshopId || null, folder: f.folder, requires: [], blocks: [],
      });
    }
  }
  const plain = (n) => n.replace(/\[[^\]]*\]/g, '').trim(); // sort without Civ [COLOR_*] markup
  out.sort((a, b) => plain(a.name).localeCompare(plain(b.name), undefined, { sensitivity: 'base' }));
  // A sync writes a row in every profile, so the UI needs to know how many
  // there are to describe what will happen.
  const groups = st.ok ? listGroups(modsDb.path).groups.length : 0;
  return {
    modsDb, ok: st.ok, error: st.error || null, activeGroup: st.activeGroup || null,
    profiles: groups, needsSync: todo.pending.length, mods: out,
  };
}

// What the last sync did, for the dashboard to report. Held in memory only -
// it describes one run, and the next run overwrites it.
let lastSync = null;

// Bring the game's database up to date with the mod folders: register anything
// the game has never scanned, and give anything it knows but that has no row in
// the profile in use a row in every profile.
//
// NOTHING is ever switched on. A newly added mod comes up visible and tickable
// but off, which is the state every mod is already in inside a profile the
// toolkit created. That is the whole reason this is safe to run without asking:
// it can put a mod in front of you, but it cannot change what the game loads.
//
// Runs at startup and whenever the dashboard's Rescan is used, so subscribing
// to mods after the toolkit is already open is handled the same way. Every
// write is refused while Civ6 runs, and the reason is returned rather than
// attempted and failed.
async function syncMods() {
  const run = { at: new Date().toISOString(), added: [], failed: [], skipped: null, error: null, pending: 0, backupPath: null };
  lastSync = run;

  const game = await gameStatus();
  if (game.running) {
    run.skipped = 'civ6-running';
    return run;
  }
  const modsDb = paths.getModsDb();
  if (!modsDb.exists) {
    run.error = 'Mod database not found.';
    return run;
  }
  const todo = findUnregistered(modsDb.path, paths.getSources());
  if (!todo.ok) {
    run.error = todo.error;
    return run;
  }
  run.pending = todo.count;
  // Nothing new: return before registerMods so no backup is made. Otherwise
  // every Rescan click would spend one of the ten backups the app keeps.
  if (!todo.count) return run;

  const active = listGroups(modsDb.path).active;
  if (!active) {
    run.error = 'the mod database has no mod group';
    return run;
  }
  try {
    const r = registerMods(modsDb.path, todo.pending.map((p) => p.path), false, active.id);
    run.added = r.registered.map((x) => ({ modId: x.modId, name: x.name, isNew: x.isNew }));
    run.failed = r.failed.map((f) => ({ file: path.basename(f.file), error: f.error }));
    run.backupPath = r.backupPath;
  } catch (e) {
    // registerMods restores its own backup and says so in the message.
    run.error = e.message;
  }
  return run;
}

// Size, file count and newest modification time of a mod folder.
function folderStats(dir) {
  const st = { files: 0, bytes: 0, modified: 0 };
  (function walk(d, depth) {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      try {
        const s = fs.statSync(full);
        st.files++; st.bytes += s.size; st.modified = Math.max(st.modified, s.mtimeMs);
      } catch (_) { /* skip */ }
    }
  })(dir, 0);
  return st;
}

// -------- API ---------------------------------------------------------------

async function handleApi(req, res, url) {
  // GET /api/state -> paths, config list, installed inventory
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const sources = paths.getSources();
    const installed = scanMods(sources);
    return send(res, 200, {
      sources,
      saves: paths.getSavesDir(),
      ...listConfigs(),
      installed: installed.map((m) => ({ id: m.id, idNorm: m.idNorm, name: m.name, type: m.type })),
    });
  }

  // GET /api/dashboard -> counts, folder setup, game status
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const sources = paths.getSources();
    const installed = scanMods(sources);
    const modsDb = paths.getModsDb();
    const dbState = modsDb.exists ? readModState(modsDb.path) : { ok: false, error: 'Mod database not found.', mods: [] };
    const byNorm = new Map(dbState.mods.map((m) => [m.idNorm, m]));

    // Totals come from the folders on disk; "enabled" from the game's database.
    const count = (type) => {
      const mods = installed.filter((m) => m.type === type);
      return {
        total: mods.length,
        enabled: mods.filter((m) => { const d = byNorm.get(m.idNorm); return d && d.disabled === false; }).length,
      };
    };
    const official = dbState.mods.filter((m) => m.source === 'dlc');
    const { configs } = listConfigs();
    // Same list the mod manager and the sync use, so "needs adding" can never
    // read differently in two places. This used to be worked out a third time,
    // here, from the folders alone - which missed the mods the game knew but
    // had no row for.
    const todo = dbState.ok ? findUnregistered(modsDb.path, sources, dbState) : { pending: [] };
    const types = new Map(installed.map((m) => [m.idNorm, m.type]));
    return send(res, 200, {
      version: VERSION,
      sources,
      saves: paths.getSavesDir(),
      modsDb: { ...modsDb, ok: dbState.ok, error: dbState.error || null, activeGroup: dbState.activeGroup || null },
      game: await gameStatus(),
      counts: {
        workshop: count('workshop'),
        local: count('local'),
        dlc: { total: official.length, enabled: official.filter((m) => m.disabled === false).length },
        configs: configs.length,
      },
      // On disk but not yet switchable: never scanned by the game, or known to
      // it but with no row in the profile in use. A sync adds them all.
      needsSync: todo.pending.map((p) => ({ id: p.id, name: p.name, type: types.get(p.idNorm) || 'local', reason: p.reason })),
      // Recorded by the game but no longer on disk: unsubscribed, or deleted by
      // hand. Listed, never removed on our own initiative - a mod still
      // downloading looks exactly like one just unsubscribed.
      gone: dbState.ok ? findRemoved(modsDb.path, sources) : { removed: [], removable: 0 },
      // What the last sync did, so the page can say so rather than the user
      // having to remember.
      sync: lastSync,
    });
  }

  // GET /api/mods -> mod manager list
  if (req.method === 'GET' && url.pathname === '/api/mods') {
    const list = modList();
    return send(res, 200, { ...list, game: await gameStatus() });
  }

  // GET /api/mods/details?id=... -> everything the details panel shows
  if (req.method === 'GET' && url.pathname === '/api/mods/details') {
    const idNorm = normId(url.searchParams.get('id'));
    const list = modList();
    const mod = list.mods.find((m) => m.idNorm === idNorm);
    if (!mod) return send(res, 404, { error: 'mod not found' });
    const inConfigs = [];
    for (const c of listConfigs().configs) {
      try {
        if (cfg.listMods(fs.readFileSync(c.path)).mods.some((m) => normId(m.id) === idNorm)) inConfigs.push(c.name);
      } catch (_) { /* unreadable config: skip */ }
    }
    return send(res, 200, {
      mod,
      db: list.ok ? readModDetails(list.modsDb.path, mod.id) : null,
      disk: mod.folder ? { folder: mod.folder, ...folderStats(mod.folder) } : null,
      requiredBy: list.mods.filter((m) => m.requires.some((r) => r.id === idNorm)).map((m) => ({ id: m.idNorm, name: m.name, enabled: m.enabled })),
      blockedBy: list.mods.filter((m) => m.blocks.some((r) => r.id === idNorm)).map((m) => ({ id: m.idNorm, name: m.name, enabled: m.enabled })),
      inConfigs,
    });
  }

  // POST /api/mods/apply { changes:[{ id, enabled }] } -> write enable flags
  if (req.method === 'POST' && url.pathname === '/api/mods/apply') {
    const { changes } = await readBody(req);
    if (!Array.isArray(changes) || !changes.length) return send(res, 400, { error: 'no changes' });
    const game = await gameStatus();
    if (game.running) return send(res, 409, { error: 'Civilization VI is running. Close the game first, then apply your changes.' });

    const list = modList();
    if (!list.ok) return send(res, 400, { error: list.error });
    const byNorm = new Map(list.mods.map((m) => [m.idNorm, m]));
    const clean = [];
    for (const c of changes) {
      const m = byNorm.get(normId(c && c.id));
      if (!m) return send(res, 400, { error: `unknown mod: ${c && c.id}` });
      if (!m.scanned) return send(res, 400, { error: `"${m.name}" can't be changed until the game has scanned it (start Civ6 once).` });
      if (m.enabled == null) return send(res, 400, { error: `"${m.name}" isn't in the game's active mod group, so it can't be turned on or off.` });
      clean.push({ modId: m.id, enabled: !!c.enabled });
    }
    try {
      const r = applyChanges(list.modsDb.path, clean);
      return send(res, 200, { ok: true, ...r });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // POST /api/sync -> add everything on disk that is not yet switchable, and
  // switch on nothing. The dashboard's Rescan calls this; so does startup.
  // Without it a newly subscribed mod cannot be turned on until Civ6 has
  // launched once.
  // No ids, no paths: the server works out for itself what is missing, from the
  // mod folders and the database. The browser cannot name a file. Writes nothing
  // if there is nothing to add. See syncMods() and FINDINGS.md.
  if (req.method === 'POST' && url.pathname === '/api/sync') {
    const run = await syncMods();
    return send(res, 200, { ok: !run.error, ...run });
  }

  // POST /api/mods/open-folder { ids: [id] } -> show a mod's folder in Explorer.
  //
  // A page cannot open Explorer by itself - file:// links are blocked from an
  // http:// page - so the server does it. It cannot delete anything, but it does
  // hand a path to another program, so it takes the same care as removal: ids
  // only from the request, the folder re-derived from the database, and the same
  // modFolderFault() rules. Not blocked while Civ6 runs - this reads nothing.
  if (req.method === 'POST' && url.pathname === '/api/mods/open-folder') {
    const { ids } = await readBody(req);
    const list = Array.isArray(ids) ? ids.map(normId) : [];
    if (!list.length) return send(res, 400, { error: 'no mods were named' });
    if (list.length > 1) return send(res, 400, { error: 'one mod at a time' });

    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const sources = paths.getSources();
    const roots = sources.filter((s) => s.exists)
      .map((s) => String(s.root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());

    const st = readModState(modsDb.path);
    if (!st.ok) return send(res, 400, { error: st.error });
    const rec = st.mods.find((m) => m.idNorm === list[0]);
    if (!rec) return send(res, 400, { error: 'that mod is not in the database' });

    const folder = path.dirname(String(rec.path || '').replace(/\\/g, '/'));
    const fault = modFolderFault(folder, rec.path, roots);
    if (fault) return send(res, 400, { error: fault });
    try {
      if (!fs.statSync(folder).isDirectory()) return send(res, 400, { error: 'that path is not a folder' });
    } catch (e) {
      return send(res, 400, { error: e.code === 'ENOENT' ? 'folder not found' : e.message });
    }
    // explorer.exe is a GUI program and its exit code means nothing: it returns
    // 1 for a folder that opened perfectly well, and 1 for one that does not
    // exist. So the code is ignored - the statSync above already proved the
    // folder is there - and only Explorer failing to launch at all is worth
    // reporting, which surfaces as ENOENT.
    execFile('explorer.exe', [folder], { windowsHide: true }, (err) => {
      if (err && err.code === 'ENOENT') console.error('explorer.exe could not be launched');
    });
    return send(res, 200, { ok: true, folder });
  }

  // POST /api/mods/remove { ids: [...] } -> take mods out of the game and
  // delete their folders.
  //
  // The browser sends mod ids only. Folders come from the database and are
  // re-checked against the mod sources before anything is deleted, so a stale or
  // tampered request cannot name a path to delete - least of all a base-game or
  // DLC one, which the game also records and which must never be touched.
  if (req.method === 'POST' && url.pathname === '/api/mods/remove') {
    const { ids } = await readBody(req);
    const list = Array.isArray(ids) ? ids.map(normId) : [];
    if (!list.length) return send(res, 400, { error: 'no mods were named' });
    if (list.length > 200) return send(res, 400, { error: 'too many mods at once' });

    const game = await gameStatus();
    if (game.running) return send(res, 409, { error: 'Civilization VI is running. Close the game first, then remove mods.' });
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });

    const sources = paths.getSources();
    const roots = sources.filter((s) => s.exists)
      .map((s) => String(s.root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
    // Folders come from the database, never from the request.
    const st = readModState(modsDb.path);
    if (!st.ok) return send(res, 400, { error: st.error });
    const byId = new Map(st.mods.map((m) => [m.idNorm, m]));
    const expected = {};
    const rejected = [];
    for (const id of list) {
      const rec = byId.get(id);
      if (!rec) { rejected.push({ modId: id, reason: 'not in the database' }); continue; }
      const folder = path.dirname(String(rec.path || '').replace(/\\/g, '/'));
      const fault = modFolderFault(folder, rec.path, roots);
      if (fault) { rejected.push({ modId: id, name: rec.name, reason: fault }); continue; }
      expected[id] = folder;
    }
    if (!Object.keys(expected).length) return send(res, 400, { error: 'none of those could be removed', refused: rejected });

    let r;
    try {
      // roots go too, so the data layer can refuse a folder that is - or holds -
      // a mod source folder. That check is what stands between a bug here and
      // deleting somebody's entire mod library.
      r = removeMods(modsDb.path, Object.keys(expected), expected, sources.filter((s) => s.exists).map((s) => s.root));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }

    // Files last. The mod is already out of the game, so a failure here is
    // reported rather than fatal - but it matters, because files left behind
    // are re-registered by the game on its next scan.
    const kept = [];
    for (const m of r.removed) {
      // Checked again immediately before deleting, not just earlier. Passing the
      // folder where the .modinfo path would go is deliberate: classifyPath keys
      // off the same root markers, and "workshop/.../12345" and the folder
      // ".../12345" classify the same way.
      const fault = modFolderFault(m.folder, m.folder, roots);
      if (fault) { kept.push({ ...m, error: fault }); continue; }
      try {
        if (!fs.lstatSync(m.folder).isDirectory()) { kept.push({ ...m, error: 'that path is not a folder' }); continue; }
        fs.rmSync(m.folder, { recursive: true, force: true });
      } catch (e) {
        kept.push({ modId: m.modId, name: m.name, folder: m.folder, error: e.code === 'ENOENT' ? 'already gone' : e.message });
      }
    }
    return send(res, 200, { ok: true, removed: r.removed, kept, refused: [...rejected, ...r.refused], backupPath: r.backupPath });
  }

  // ---- mod groups (player profiles) ---------------------------------------
  // Every write here changes Mods.sqlite, so it is refused while the game runs
  // and each one returns the refreshed group list for the UI.

  if (req.method === 'GET' && url.pathname === '/api/modgroups') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const list = listGroups(modsDb.path);
    if (!list.ok) return send(res, 500, { error: list.error });
    return send(res, 200, { ...list, game: await gameStatus() });
  }

  // GET /api/modgroups/export?id=... -> the profile as a downloadable .json
  // file. Read-only, so it also works while the game is running.
  if (req.method === 'GET' && url.pathname === '/api/modgroups/export') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const id = groupId(url.searchParams.get('id'));
    if (id === null) return send(res, 400, { error: 'which profile?' });
    let file;
    try {
      file = exportGroup(modsDb.path, id);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
    // Keep the name readable but out of the file name: quotes, slashes and
    // Windows' forbidden characters would break the download.
    const safe = file.name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'profile';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="civ6-profile-${safe}.json"`,
    });
    return res.end(JSON.stringify(file, null, 2));
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/modgroups/')) {
    const action = url.pathname.slice('/api/modgroups/'.length);
    const body = await readBody(req);
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });

    // A mod group can't be changed while the game has the database open.
    const game = await gameStatus();
    if (game.running) return send(res, 409, { error: 'Civilization VI is running. Close the game first, then try again.' });

    const id = groupId(action === 'import' ? null : body.id);
    if (id === null && action !== 'create' && action !== 'import') return send(res, 400, { error: 'which profile?' });
    try {
      let r;
      if (action === 'create') r = createGroup(modsDb.path, body.name);
      else if (action === 'duplicate') r = duplicateGroup(modsDb.path, id, body.name);
      else if (action === 'rename') r = renameGroup(modsDb.path, id, body.name);
      else if (action === 'delete') r = deleteGroup(modsDb.path, id, body.fallbackId);
      else if (action === 'activate') r = activateGroup(modsDb.path, id);
      else if (action === 'import') r = importGroup(modsDb.path, body.profile);
      else return send(res, 404, { error: 'not found' });
      // Re-read so the UI always gets the state that is really on disk.
      const list = listGroups(modsDb.path);
      return send(res, 200, { ok: true, ...r, groups: list.groups, active: list.active, game });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // GET /api/game -> is Civ6 running (polled by the UI)
  if (req.method === 'GET' && url.pathname === '/api/game') {
    return send(res, 200, await gameStatus());
  }

  // GET /api/config?path=... -> enabled + available-to-add for one config
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const p = url.searchParams.get('path');
    if (!isConfigPath(p) || !fs.existsSync(p)) return send(res, 400, { error: 'invalid config path' });
    const installed = scanMods(paths.getSources());
    let view;
    try { view = inventory.configView(fs.readFileSync(p), installed); }
    catch (e) { return send(res, 500, { error: `parse failed: ${e.message}` }); }
    return send(res, 200, { path: p, name: path.basename(p), ...view });
  }

  // POST /api/paths -> persist overrides to civ6-paths.json
  if (req.method === 'POST' && url.pathname === '/api/paths') {
    const body = await readBody(req);
    const file = path.join(__dirname, '..', 'civ6-paths.json');
    const obj = {};
    if (body.localMods) obj.localMods = body.localMods;
    if (body.workshop) obj.workshop = body.workshop;
    if (body.saves) obj.saves = body.saves;
    if (body.modsDb) obj.modsDb = body.modsDb;
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return send(res, 200, { ok: true, file });
  }

  // POST /api/save -> apply edits
  if (req.method === 'POST' && url.pathname === '/api/save') {
    const body = await readBody(req);
    const { path: p, add = [], remove = [], mode = 'overwrite', newName } = body;
    if (!isConfigPath(p) || !fs.existsSync(p)) return send(res, 400, { error: 'invalid config path' });

    const installed = scanMods(paths.getSources());
    const byNorm = new Map(installed.map((m) => [m.idNorm, m]));
    const adds = [];
    for (const id of add) {
      const m = byNorm.get(normId(id));
      if (!m) return send(res, 400, { error: `mod not installed: ${id}` });
      adds.push({ id: m.id, name: m.name });
    }

    let outPath = p;
    if (mode === 'new') {
      let base = String(newName || '').trim();
      base = path.basename(base); // no directory traversal
      if (!base) return send(res, 400, { error: 'newName required for "new" mode' });
      if (!/\.Civ6Cfg$/i.test(base)) base += '.Civ6Cfg';
      outPath = path.join(path.dirname(p), base);
      if (fs.existsSync(outPath)) return send(res, 409, { error: `file already exists: ${base}` });
    }

    try {
      const summary = editor.saveConfig(p, {
        adds,
        removes: remove,
        outPath,
        backup: mode === 'overwrite',
      });
      return send(res, 200, { ok: true, summary });
    } catch (e) {
      return send(res, 500, { error: e.message, problems: e.problems || null });
    }
  }

  // POST /api/delete -> back up then delete a config file
  if (req.method === 'POST' && url.pathname === '/api/delete') {
    const body = await readBody(req);
    const p = body.path;
    if (!isConfigPath(p) || !fs.existsSync(p)) return send(res, 400, { error: 'invalid config path' });
    try {
      const backupPath = editor.backupFile(p); // recoverable delete
      fs.unlinkSync(p);
      return send(res, 200, { ok: true, backupPath });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // POST /api/shutdown -> stop the server (used by the launcher's menu)
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    send(res, 200, { ok: true });
    console.log('Civ6 Mod Toolkit stopped.');
    setTimeout(() => process.exit(0), 100); // let the response go out first
    return;
  }

  return send(res, 404, { error: 'not found' });
}

// -------- static files ------------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

// -------- server ------------------------------------------------------------

// The API changes files on disk, so only our own page (and local tools such as
// the launcher, which send no Origin) may call it. Checking Host blocks DNS
// rebinding; requiring a JSON content type on POST forces a CORS preflight for
// any cross-site request, which we never answer; checking Origin covers the rest.
const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function apiAllowed(req) {
  if (!OWN_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && !OWN_HOSTS.has(origin.replace(/^https?:\/\//i, '').toLowerCase())) return false;
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/') && !apiAllowed(req)) return send(res, 403, { error: 'forbidden' });
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

const addr = `http://${HOST}:${PORT}`;

function openBrowser() {
  if (process.env.NO_OPEN) return;
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', addr], () => {});
  else if (process.platform === 'darwin') execFile('open', [addr], () => {});
  else execFile('xdg-open', [addr], () => {});
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Already running (e.g. launcher double-clicked twice) — just reopen the tab.
    console.log(`Civ6 Mod Toolkit is already running at ${addr} — opening browser.`);
    openBrowser();
    process.exit(0);
  }
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Civ6 Mod Toolkit running at ${addr}`);
  if (!process.env.CIV6_LAUNCHER) console.log('Press Ctrl+C to stop.'); // the launcher has its own menu
  openBrowser();

  // Pick up anything subscribed to since last time, the way the game would on
  // its own next launch - but without waiting for a launch, and without
  // switching anything on. Not awaited: the browser is already open, and a
  // first run over a large library can take a moment.
  syncMods().then((run) => {
    if (run.error) console.log(`Sync: ${run.error}`);
    else if (run.skipped === 'civ6-running') console.log('Sync: skipped, Civ6 is running. Close it and rescan.');
    else if (run.added.length) {
      console.log(`Sync: added ${run.added.length} mod${run.added.length === 1 ? '' : 's'} (off in every profile)` +
        (run.failed.length ? `, ${run.failed.length} could not be read` : ''));
    } else if (run.pending) console.log(`Sync: ${run.pending} mod${run.pending === 1 ? '' : 's'} could not be read.`);
  }).catch((e) => console.log(`Sync: ${e.message}`));
});
