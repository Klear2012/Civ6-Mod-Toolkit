'use strict';

// Conflict-diagnosis selfcheck over HTTP plus read-only guards (see ADR-010).
// Owns seed+run, moved from server.js behavior-free; deps inject the server
// handle and builders, leaves required directly, never requiring server back.
// Fake DBs in OS temp only, never the live game database (see ADR-006).

const setupStore = require('./gamesetup');
function conflictSelfcheckSeed(dir) {
  const fsSc = require('fs');
  const pathSc = require('path');
  const { DatabaseSync: DbSc } = require('node:sqlite');
  const MOD_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const MOD_B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const GONE = 'dddddddd-4444-4444-8444-444444444444';
  const modsDir = pathSc.join(dir, 'Mods');
  fsSc.mkdirSync(pathSc.join(modsDir, 'ModA', 'data'), { recursive: true });
  fsSc.mkdirSync(pathSc.join(modsDir, 'ModB', 'data'), { recursive: true });
  const modinfoA = pathSc.join(modsDir, 'ModA', 'ModA.modinfo');
  const modinfoB = pathSc.join(modsDir, 'ModB', 'ModB.modinfo');
  fsSc.writeFileSync(modinfoA, '<Mod></Mod>');
  fsSc.writeFileSync(modinfoB, '<Mod></Mod>');
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModA', 'data', 'a.sql'), "UPDATE ProvCheck SET Value = 1 WHERE Id = 'hero';\n");
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModA', 'data', 'gated.sql'), "INSERT INTO ProvCheck VALUES('gated', 7);\n");
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModA', 'data', 'setup.sql'), 'CREATE TABLE SetupGated(Id TEXT);\nINSERT INTO SetupGated VALUES(\'s1\');\n');
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModB', 'data', 'b.sql'), "UPDATE ProvCheck SET Value = 2 WHERE Id = 'hero';\n");
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModB', 'data', 'bad1.sql'), 'INSERT INTO NoSuchB1 VALUES(1);\n');
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModB', 'data', 'bad2.sql'), 'INSERT INTO NoSuchB2 VALUES(1);\n');
  // missing.sql is referenced by the database but absent on disk (unreadable).

  const modsDb = pathSc.join(dir, 'Mods.sqlite');
  const w = new DbSc(modsDb);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  const sfA = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(modinfoA).lastInsertRowid;
  const sfB = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(modinfoB).lastInsertRowid;
  const mA = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sfA, MOD_A).lastInsertRowid;
  const mB = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sfB, MOD_B).lastInsertRowid;
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)').run(mA);
  w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)').run(mB);
  const addAction = (modRowId, type, id, files, props) => {
    const cr = w.prepare('INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, ?)')
      .run(modRowId, id, type).lastInsertRowid;
    for (const [k, v] of Object.entries(props || {})) {
      w.prepare('INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, ?, ?)').run(cr, k, v);
    }
    for (const f of files) {
      const fr = w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(modRowId, f).lastInsertRowid;
      w.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId) VALUES (?, ?)').run(cr, fr);
    }
    return cr;
  };
  // UI contests: file-vs-LuaReplace with no declared order, file-vs-file with
  // a single max, a genuine tie, and one solo path that must be omitted.
  addAction(mA, 'AddUIScript', 'ShipPanel', ['UI/Panel.lua']);
  addAction(mA, 'AddUIScript', 'BothA', ['UI/Both.lua'], { LoadOrder: '100' });
  addAction(mA, 'AddUIScript', 'TieA', ['UI/Tie.lua'], { LoadOrder: '300' });
  addAction(mA, 'AddUIScript', 'SoloA', ['UI/Solo.lua']);
  addAction(mB, 'ReplaceUIScript', 'PanelReplace', [], { LuaContext: 'Screen', LuaReplace: 'UI/Panel.lua' });
  addAction(mB, 'AddUIScript', 'BothB', ['UI/Both.lua'], { LoadOrder: '200' });
  addAction(mB, 'AddUIScript', 'TieB', ['UI/Tie.lua'], { LoadOrder: '300' });
  // DB files: A(100) writes hero=1, B(200) writes hero=2, so B wins in order.
  addAction(mA, 'UpdateDatabase', 'GoodA', ['data/a.sql'], { LoadOrder: '100' });
  const gatedCr = addAction(mA, 'UpdateDatabase', 'GatedA', ['data/gated.sql']);
  const setupCr = addAction(mA, 'UpdateDatabase', 'SetupA', ['data/setup.sql']);
  addAction(mA, 'UpdateDatabase', 'MissA', ['data/missing.sql']);
  addAction(mB, 'UpdateDatabase', 'GoodB', ['data/b.sql'], { LoadOrder: '200' });
  addAction(mB, 'UpdateDatabase', 'BadB1', ['data/bad1.sql']);
  addAction(mB, 'UpdateDatabase', 'BadB2', ['data/bad2.sql']);
  // GatedA runs only with a mod that is not installed: skipped with reason.
  w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (1, ?, ?, 0)').run(mA, 'GateOff');
  w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (1, 1, ?, 0)').run('ModInUse');
  w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (1, 'Value', ?)").run(GONE);
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, 1)').run(gatedCr);
  // SetupA runs only with RULESET_STANDARD asserted: undecidable with nothing
  // asserted (replays, flagged unknown), assumed-satisfied once asserted.
  w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (2, ?, ?, 0)').run(mA, 'SetupGate');
  w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (2, 2, ?, 0)').run('RuleSetInUse');
  w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (2, 'Value', ?)").run('RULESET_STANDARD');
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, 2)').run(setupCr);
  w.close();

  const debugDb = pathSc.join(dir, 'DebugGameplay.sqlite');
  const seed = new DbSc(debugDb);
  try {
    seed.exec("CREATE TABLE ProvCheck(Id TEXT PRIMARY KEY, Value INTEGER); INSERT INTO ProvCheck VALUES('hero', 0);");
  } finally {
    seed.close();
  }
  return { modsDb, debugDb, logPath: pathSc.join(dir, 'Database.log'), moddingPath: pathSc.join(dir, 'Modding.log'), MOD_A, MOD_B, GONE };
}

async function runConflictSelfcheck(deps) {
  // Injected by the --selfcheck entry call in src/server.js (see above).
  const {
    server, HOST, OWN_HOSTS,
    conflictReplayReport, conflictCollisionDisplay, conflictFileClaimants,
    gameSetupCatalog, gameSetupKnown,
    debugGameplayCandidates, findDebugGameplay,
    databaseLogCandidates, findDatabaseLog,
  } = deps;
  const fsSc = require('fs');
  const osSc = require('os');
  const pathSc = require('path');
  const cryptoSc = require('crypto');
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };
  console.log('conflict-diagnosis --selfcheck (task 4.1)');
  const scratch = fsSc.realpathSync.native(fsSc.mkdtempSync(pathSc.join(osSc.tmpdir(), 'civ6-conflict-selfcheck-')));
  console.log(`scratch dir: ${scratch}`);
  const fx = conflictSelfcheckSeed(scratch);
  const sha = (p) => cryptoSc.createHash('sha256').update(fsSc.readFileSync(p)).digest('hex');
  const modsBefore = sha(fx.modsDb);
  const debugBefore = sha(fx.debugDb);
  const debugMtime = fsSc.statSync(fx.debugDb).mtimeMs;
  // Config files present before the run, so the run can prove it wrote none.
  const cfgBefore = fsSc.readdirSync(pathSc.join(__dirname, '..'))
    .filter((f) => /\.Civ6Cfg$/i.test(f))
    .map((f) => [f, fsSc.statSync(pathSc.join(__dirname, '..', f)).mtimeMs]);

  // Isolate: a paths file that does not exist, so env vars below win and no
  // real Steam/library path is ever consulted.
  process.env.CIV6_PATHS_FILE = pathSc.join(scratch, 'no-such-civ6-paths.json');
  process.env.CIV6_MODS_DB = fx.modsDb;
  process.env.CIV6_DEBUG_GAMEPLAY = fx.debugDb;
  process.env.CIV6_DATABASE_LOG = fx.logPath;
  process.env.CIV6_MODDING_LOG = fx.moddingPath;
  // Hermetic game setup: the replay report reads game-setup.json on every run,
  // so point it at a scratch file (absent = nothing asserted) rather than any
  // repo file a developer may have left behind.
  process.env.CIV6_GAMESETUP_FILE = pathSc.join(scratch, 'game-setup.json');

  // Learn the exact replay error text first (in-process, same code the route
  // calls), so the fixture Database.log carries one matching error plus one
  // ghost error no replay statement raised.
  const prelim = await conflictReplayReport(fx.modsDb, { foreignKeys: false });
  const bad1 = (prelim.perFile.find((f) => f.fileLabel === 'data/bad1.sql') || {}).error || 'no such table: NoSuchB1';
  fsSc.writeFileSync(fx.logPath, [
    `[100.001] [Gameplay] ERROR: ${bad1} -- file: bad1.sql statement 0`,
    '[100.002] [Gameplay] Validating Foreign Key Constraints...',
    '[100.003] [Gameplay] ERROR: UNIQUE constraint failed: ProvCheck.Id -- file: ghost.sql statement 3',
  ].join('\n'));
  // Modding.log Loading timeline with one inverted pair: the replay assumes
  // data/a.sql before data/b.sql, the game loaded b.sql before a.sql. Later
  // timestamps than the Database.log errors so bracketing is untouched.
  fsSc.writeFileSync(fx.moddingPath, [
    '[100.010] [Modding] UpdateDatabase - Loading D:/Synthetic/ModB/data/b.sql',
    '[100.011] [Modding] UpdateDatabase - Loading D:/Synthetic/ModA/data/a.sql',
  ].join('\n'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const port = server.address().port;
  OWN_HOSTS.add(`127.0.0.1:${port}`);
  console.log(`scratch server: http://127.0.0.1:${port}`);
  // agent:false, like server-harness: fetch pools sockets and a pooled socket
  // can hold (or break, at teardown) the event loop after the suite finishes.
  const httpSc = require('http');
  const get = (p) => new Promise((resolve, reject) => {
    const req = httpSc.request({ host: '127.0.0.1', port, path: p, method: 'GET', agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });

  console.log('\nShadowing route (read-only enumeration)');
  const sh = await get('/api/conflicts/shadowing');
  check('shadowing answers 200 with ok', sh.status === 200 && sh.body && sh.body.ok === true,
    `status=${sh.status} ok=${sh.body && sh.body.ok}`);
  const paths = (sh.body.contested || []).map((c) => c.path);
  check('exactly the three contested paths', JSON.stringify(paths) === JSON.stringify(['UI/Both.lua', 'UI/Panel.lua', 'UI/Tie.lua']),
    JSON.stringify(paths));
  const byPath = new Map((sh.body.contested || []).map((c) => [c.path, c]));
  const both = byPath.get('UI/Both.lua');
  check('single max wins with its declared value',
    !!both && both.status === 'decided' && both.winner && both.winner.value === 200
    && String(both.winner.modId).toLowerCase() === fx.MOD_B.toLowerCase(),
    JSON.stringify(both && both.winner));
  const panel = byPath.get('UI/Panel.lua');
  const panelSources = panel ? panel.claimants.map((c) => c.sources.join('+')).sort() : [];
  check('LuaReplace-only contest is undefined with both sources named',
    !!panel && panel.status === 'undefined' && panel.reason === 'no-declared-order' && panel.winner === null
    && JSON.stringify(panelSources) === JSON.stringify(['LuaReplace', 'file']),
    JSON.stringify(panelSources));
  const tie = byPath.get('UI/Tie.lua');
  check('genuine tie is undefined, unranked, value named',
    !!tie && tie.status === 'undefined' && tie.reason === 'tie' && tie.value === 300 && tie.winner === null
    && tie.tied && tie.tied.length === 2,
    JSON.stringify(tie && { reason: tie.reason, value: tie.value, tied: tie.tied }));
  check('uncontested path omitted', !paths.includes('UI/Solo.lua'));
  const env = sh.body.envelope || {};
  check('envelope counts reported', env.mods === 2 && env.contested === 3 && env.decidable === 1
    && env.noDeclaredOrder === 1 && env.ties === 1, JSON.stringify(env));
  check('envelope line present', typeof sh.body.envelopeLine === 'string' && /contested/.test(sh.body.envelopeLine),
    sh.body.envelopeLine);

  console.log('\nReplay route (temp copy only, user-triggered)');
  const rp = await get('/api/conflicts/replay?fk=off');
  check('replay answers 200 with ok', rp.status === 200 && rp.body && rp.body.ok === true,
    `status=${rp.status} ok=${rp.body && rp.body.ok} err=${rp.body && rp.body.error}`);
  const tmp = require('os').tmpdir();
  const realTmp = fsSc.realpathSync.native(tmp);
  check('report names a temp copy under the OS temp dir',
    typeof rp.body.tempCopy === 'string' && rp.body.tempCopy.startsWith(realTmp)
    && /DebugGameplay\.sqlite$/.test(rp.body.tempCopy), rp.body.tempCopy);
  check('fk mode recorded', rp.body.fkMode === 'OFF', rp.body.fkMode);
  check('exactly one collision', (rp.body.collisions || []).length === 1,
    JSON.stringify((rp.body.collisions || []).map((c) => `${c.table}/${c.pk}/${c.column}`)));
  const col = (rp.body.collisions || [])[0];
  check('collision names winner plus loser in replay order',
    !!col && col.table === 'ProvCheck' && col.pk === 'hero' && col.column === 'Value'
    && col.winner.modId.toLowerCase() === fx.MOD_B.toLowerCase() && col.winner.fileLabel === 'data/b.sql'
    && col.losers.length === 1 && col.losers[0].modId.toLowerCase() === fx.MOD_A.toLowerCase()
    && col.losers[0].fileLabel === 'data/a.sql', col ? JSON.stringify(col) : 'none');
  // Collision display names (readability): winner/loser mods resolve through
  // the installed display-name index with mod-id fallback, same-mod pairs
  // tag and sort after cross-mod pairs, counts and envelope untouched.
  // In-process over the mapping itself: no fixture change, no new DB rows.
  {
    const byId = new Map([[fx.MOD_A, 'Alpha Mod'], [fx.MOD_B, 'Beta Mod']]);
    const cross = {
      table: 'T', pk: 'k', column: 'V', writes: 2, fidelityLimited: [],
      winner: { modId: fx.MOD_B, fileLabel: 'b.sql', stmtIndex: 0, globalIndex: 1 },
      losers: [{ modId: fx.MOD_A, fileLabel: 'a.sql', stmtIndex: 0, globalIndex: 0 }],
    };
    const inner = {
      table: 'T', pk: 'k2', column: 'V', writes: 2, fidelityLimited: [],
      winner: { modId: fx.MOD_A, fileLabel: 'a2.sql', stmtIndex: 1, globalIndex: 3 },
      losers: [{ modId: fx.MOD_A, fileLabel: 'a1.sql', stmtIndex: 0, globalIndex: 2 }],
    };
    const ghost = {
      table: 'T', pk: 'k3', column: 'V', writes: 2, fidelityLimited: [],
      winner: { modId: 'missing-mod-id', fileLabel: 'g.sql', stmtIndex: 0, globalIndex: 5 },
      losers: [{ modId: fx.MOD_A, fileLabel: 'a.sql', stmtIndex: 0, globalIndex: 4 }],
    };
    const shown = conflictCollisionDisplay([inner, cross, ghost], byId);
    check('collision winner/loser carry display names, never bare ids',
      shown.every((c) => typeof c.winner.modName === 'string' && typeof c.losers[0].modName === 'string')
      && shown.some((c) => c.winner.modName === 'Beta Mod')
      && shown.some((c) => c.losers[0].modName === 'Alpha Mod'),
      JSON.stringify(shown.map((c) => [c.winner.modName, c.losers[0].modName])));
    check('unresolvable mods fall back to the mod id',
      shown.some((c) => c.winner.modName === 'missing-mod-id'),
      JSON.stringify(shown.map((c) => c.winner.modName)));
    check('same-mod pairs tag and sort after cross-mod pairs',
      shown[shown.length - 1].sameMod === true && shown[shown.length - 1].table === 'T'
      && shown[0].sameMod === false && shown[1].sameMod === false
      && shown.filter((c) => !c.sameMod).length === 2,
      JSON.stringify(shown.map((c) => c.sameMod)));
    check('the live route response already carries names and the tag',
      col && typeof col.winner.modName === 'string' && typeof col.losers[0].modName === 'string'
      && col.sameMod === false, col ? JSON.stringify({ winner: col.winner, sameMod: col.sameMod }) : 'none');
  }
  const pf = new Map((rp.body.perFile || []).map((f) => [f.fileLabel, f]));
  check('bad files aborted with their errors',
    pf.get('data/bad1.sql').status === 'aborted' && pf.get('data/bad2.sql').status === 'aborted'
    && !!pf.get('data/bad1.sql').error, JSON.stringify([...pf].map(([k, v]) => `${k}:${v.status}`)));
  check('gated file skipped with reason naming the missing mod',
    pf.get('data/gated.sql').status === 'skipped-gated'
    && new RegExp(fx.GONE, 'i').test((pf.get('data/gated.sql').gate || {}).reason || ''),
    JSON.stringify(pf.get('data/gated.sql')));
  check('missing file listed as unreadable, never executed',
    (rp.body.unreadable || []).some((u) => u.file === 'data/missing.sql'),
    JSON.stringify(rp.body.unreadable));
  check('envelope covers every statement',
    rp.body.envelope && rp.body.envelope.executed + rp.body.envelope.skipped === rp.body.envelope.statements
    && typeof rp.body.envelopeLine === 'string', rp.body.envelopeLine);
  const diff = rp.body.differential || {};
  check('differential names agreement plus both divergences',
    diff.available === true && diff.agreements.length === 1 && diff.replayOnly.length === 1 && diff.logOnly.length === 1
    && diff.agreements[0].fileLabel === 'data/bad1.sql' && diff.replayOnly[0].fileLabel === 'data/bad2.sql'
    && diff.replayOnly[0].side === 'replay-only' && diff.logOnly[0].fileLabel === 'ghost.sql'
    && diff.logOnly[0].side === 'log-only' && diff.logPath === fx.logPath,
    JSON.stringify({ a: diff.agreements, r: diff.replayOnly, l: diff.logOnly }));
  // Log-pairing calibration: one inverted pair in the payload, and the
  // display mapping renders it. The fixture Modding.log loads b.sql before
  // a.sql against the assumed a-before-b replay order.
  const cal = rp.body.calibration || {};
  const inv = (cal.divergences || [])[0] || {};
  check('calibration carries the one inverted pair with both sides named',
    cal.available === true && (cal.divergences || []).length === 1 && cal.logPath === fx.moddingPath
    && /data\/a\.sql/.test(inv.assumedFirst || '') && /data\/b\.sql/.test(inv.assumedSecond || '')
    && /assumed replay order/.test(inv.assumedOrder || '') && /game-observed order/.test(inv.observedOrder || ''),
    JSON.stringify(cal.divergences));
  // Divergence owning mods (polish): each divergence file resolves
  // server-side to its claiming mod(s) with display names - data/a.sql is
  // Mod A's file, data/b.sql Mod B's.
  const firstMods = inv.assumedFirstMods || [];
  const secondMods = inv.assumedSecondMods || [];
  check('divergence files resolve to their owning mods with display names',
    firstMods.length === 1 && String(firstMods[0].modId).toLowerCase() === fx.MOD_A.toLowerCase()
    && typeof firstMods[0].modName === 'string' && firstMods[0].modName.length > 0
    && secondMods.length === 1 && String(secondMods[0].modId).toLowerCase() === fx.MOD_B.toLowerCase()
    && typeof secondMods[0].modName === 'string' && secondMods[0].modName.length > 0,
    JSON.stringify({ first: firstMods, second: secondMods }));
  {
    // The lookup itself, in-process with no fixture change: a path two mods
    // ship lists both with display names, deduped; basename fallback mirrors
    // the calibration's own basename pairing; unknown paths resolve empty.
    const byId = new Map([[fx.MOD_A, 'Alpha Mod'], [fx.MOD_B, 'Beta Mod']]);
    const fake = [
      { file: 'data/shared.sql', modIds: [fx.MOD_A, fx.MOD_B, fx.MOD_A] },
      { file: 'other/shared.sql', modIds: [fx.MOD_B] },
    ];
    const both = conflictFileClaimants(fake, 'data/shared.sql', byId);
    check('a path two mods ship lists both with display names',
      both.length === 2 && both[0].modName === 'Alpha Mod' && both[1].modName === 'Beta Mod',
      JSON.stringify(both));
    const byBase = conflictFileClaimants([{ file: 'data/only.sql', modIds: [fx.MOD_A] }], 'elsewhere/only.sql', byId);
    check('basename fallback mirrors the calibration pairing',
      byBase.length === 1 && byBase[0].modName === 'Alpha Mod', JSON.stringify(byBase));
    check('unknown paths resolve to an empty list, never a bare id',
      conflictFileClaimants(fake, 'data/nowhere.sql', byId).length === 0
      && conflictFileClaimants([], 'data/shared.sql', byId).length === 0, 'empty');
  }
  {
    // Display mapping runs in a stubbed-DOM vm (phase7 precedent): the page
    // script only needs $, esc/n/renderCivText, api/toast, and pages to load.
    const vmSc = require('vm');
    const cfSrc = fsSc.readFileSync(pathSc.join(__dirname, '..', 'public', 'conflicts.js'), 'utf8');
    const stubEl = () => ({ addEventListener() {}, disabled: false, textContent: '', innerHTML: '', value: 'off' });
    const cfCx = {
      console,
      esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      renderCivText: (s) => String(s == null ? '' : s),
      $: () => stubEl(),
      api: async () => ({}),
      toast: () => {},
      pages: {},
    };
    vmSc.createContext(cfCx);
    vmSc.runInContext(cfSrc, cfCx, { filename: 'conflicts.js' });
    const calHtml = vmSc.runInContext(`cfCalibrationHtml(${JSON.stringify(cal)})`, cfCx);
    check('display mapping names both files and which side each order came from',
      typeof calHtml === 'string' && /data\/a\.sql/.test(calHtml) && /data\/b\.sql/.test(calHtml)
      && /assumed replay order/.test(calHtml) && /game-observed order/.test(calHtml),
      String(calHtml).slice(0, 200));
    const calOwnHtml = vmSc.runInContext(`cfCalibrationHtml(${JSON.stringify({ available: true, divergences: [{
      assumedFirst: 'data/a.sql', assumedSecond: 'data/b.sql',
      assumedOrder: 'data/a.sql before data/b.sql (assumed replay order)',
      observedOrder: 'data/b.sql before data/a.sql (game-observed order)',
      assumedFirstMods: [{ modId: 'mid-a', modName: 'Green A' }],
      assumedSecondMods: [{ modId: 'mid-b', modName: 'Plain B' }, { modId: 'mid-c', modName: 'Plain C' }],
    }] })})`, cfCx);
    check('display mapping shows owning mods under each divergence file, all claimants',
      typeof calOwnHtml === 'string' && /Green A/.test(calOwnHtml) && /Plain B/.test(calOwnHtml)
      && /Plain C/.test(calOwnHtml) && !/mid-a|mid-b|mid-c/.test(calOwnHtml),
      String(calOwnHtml).slice(0, 200));
    const calNoOwnHtml = vmSc.runInContext(
      'cfCalibrationHtml({ available: true, divergences: [{ assumedFirst: "x.sql", assumedSecond: "y.sql", assumedOrder: "x before y", observedOrder: "y before x", assumedFirstMods: [], assumedSecondMods: [] }] })', cfCx);
    check('display mapping states unowned files in plain words',
      typeof calNoOwnHtml === 'string' && /owning mod unknown/.test(calNoOwnHtml),
      String(calNoOwnHtml).slice(0, 160));
    const calZeroHtml = vmSc.runInContext(
      'cfCalibrationHtml({ available: true, divergences: [], assumedOnly: [], observedOnly: [] })', cfCx);
    check('display mapping states the zero-divergence case',
      typeof calZeroHtml === 'string' && /match/i.test(calZeroHtml), String(calZeroHtml).slice(0, 160));
  }
  const rpOn = await get('/api/conflicts/replay?fk=on');
  check('fk=on replays with FK mode recorded', rpOn.status === 200 && rpOn.body.fkMode === 'ON',
    `status=${rpOn.status} fkMode=${rpOn.body && rpOn.body.fkMode}`);
  const rpBad = await get('/api/conflicts/replay?fk=sideways');
  check('bad fk is a 400 about the request', rpBad.status === 400 && !!rpBad.body.error, `status=${rpBad.status}`);

  console.log('\nAssumed game setup feeds replay gates (game-setup micro-fix)');
  {
    // End to end through the route: the fixture gates data/setup.sql on
    // RULESET_STANDARD, which nothing can measure here. Asserting it must move
    // the live replay verdict to assumed; withdrawing it must move it back.
    const setupKey = 'RULESET:RULESET_STANDARD';
    const setupFile = process.env.CIV6_GAMESETUP_FILE;
    const setupOf = (body) => ((body && body.perFile) || []).find((f) => f.fileLabel === 'data/setup.sql');
    const rpPlain = await get('/api/conflicts/replay?fk=off');
    const plainRec = setupOf(rpPlain.body);
    check('with nothing asserted the setup-gated file replays undecided, never assumed',
      rpPlain.status === 200 && plainRec && plainRec.status === 'committed'
      && plainRec.gate && plainRec.gate.willRun === null && !plainRec.gate.assumed
      && ((rpPlain.body.gatedAssumed || []).length === 0),
      JSON.stringify(plainRec && plainRec.gate));
    // Same prune pattern as the setup routes: assert against the mined catalog.
    setupStore.setOption(setupFile, setupKey, true, gameSetupKnown(gameSetupCatalog()));
    const rpAssumed = await get('/api/conflicts/replay?fk=off');
    const assumedRec = setupOf(rpAssumed.body);
    check('with the ruleset asserted the gated file replays as assumed, not measured',
      rpAssumed.status === 200 && assumedRec && assumedRec.status === 'committed'
      && assumedRec.gate && assumedRec.gate.willRun === true && assumedRec.gate.assumed === true,
      JSON.stringify(assumedRec && assumedRec.gate));
    const namedAssumed = (rpAssumed.body.gatedAssumed || []).find((g) => g.fileLabel === 'data/setup.sql');
    check('the payload names it in gatedAssumed with a display name',
      !!namedAssumed && typeof namedAssumed.modName === 'string' && namedAssumed.modName.length > 0,
      JSON.stringify(namedAssumed));
    {
      // The gated list marks it: render the live payload headless through the
      // real page script with a capturing $ (phase7 precedent).
      const vmA = require('vm');
      const cfSrcA = fsSc.readFileSync(pathSc.join(__dirname, '..', 'public', 'conflicts.js'), 'utf8');
      const capA = {};
      const capElA = () => ({ addEventListener() {}, disabled: false, textContent: '', innerHTML: '', value: 'off' });
      const cfCxA = {
        console,
        esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
          { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        n: (v) => (v == null ? '' : Number(v).toLocaleString()),
        renderCivText: (s) => String(s == null ? '' : s),
        $: (id) => (capA[id] || (capA[id] = capElA())),
        api: async () => ({}),
        toast: () => {},
        pages: {},
      };
      vmA.createContext(cfCxA);
      vmA.runInContext(cfSrcA, cfCxA, { filename: 'conflicts.js' });
      vmA.runInContext(`cfState.replay = ${JSON.stringify(rpAssumed.body)}`, cfCxA);
      vmA.runInContext('cfRenderReplay()', cfCxA);
      const gatedHtml = capA.cfReplayGated && capA.cfReplayGated.innerHTML;
      check('the gated list marks the assumed file with the view tag language, never as measured',
        typeof gatedHtml === 'string' && /data\/setup\.sql/.test(gatedHtml) && /lo-assumed/.test(gatedHtml)
        && /assumed setup/.test(gatedHtml),
        String(gatedHtml).slice(0, 300));
      vmA.runInContext(`cfState.replay = ${JSON.stringify(rpPlain.body)}`, cfCxA);
      vmA.runInContext('cfRenderReplay()', cfCxA);
      const plainHtml = capA.cfReplayGated && capA.cfReplayGated.innerHTML;
      check('with nothing asserted the gated list carries no assumed marker',
        typeof plainHtml === 'string' && !/assum/i.test(plainHtml),
        String(plainHtml).slice(0, 200));
    }
    setupStore.setOption(setupFile, setupKey, false, gameSetupKnown(gameSetupCatalog()));
    const rpBack = await get('/api/conflicts/replay?fk=off');
    const backRec = setupOf(rpBack.body);
    check('withdrawing the assertion returns the file to undecided',
      rpBack.status === 200 && backRec && backRec.gate && backRec.gate.willRun === null && !backRec.gate.assumed
      && ((rpBack.body.gatedAssumed || []).length === 0),
      JSON.stringify(backRec && backRec.gate));
  }

  console.log('\nDebugGameplay candidates (Local Cache fallback)');
  {
    const docsRoot = pathSc.join(scratch, 'docs-root');
    const localRoot = pathSc.join(scratch, 'local-root');
    const localCacheDb = pathSc.join(localRoot, 'Cache', 'DebugGameplay.sqlite');
    const envDb = pathSc.join(scratch, 'env-override.sqlite');
    fsSc.mkdirSync(docsRoot, { recursive: true });
    fsSc.mkdirSync(pathSc.dirname(localCacheDb), { recursive: true });
    fsSc.copyFileSync(fx.debugDb, localCacheDb);
    fsSc.copyFileSync(fx.debugDb, envDb);
    const savedEnv = process.env.CIV6_DEBUG_GAMEPLAY;
    const pathsMod = require('./paths');
    const savedMy = pathsMod.myGamesRoot;
    const savedLocal = pathsMod.localGamesRoot;
    pathsMod.myGamesRoot = () => docsRoot;
    pathsMod.localGamesRoot = () => localRoot;
    try {
      delete process.env.CIV6_DEBUG_GAMEPLAY;
      const cands = debugGameplayCandidates();
      check('candidates list env, Documents then Local Cache and bare',
        JSON.stringify(cands) === JSON.stringify([
          pathSc.join(docsRoot, 'Cache', 'DebugGameplay.sqlite'),
          pathSc.join(docsRoot, 'DebugGameplay.sqlite'),
          pathSc.join(localRoot, 'Cache', 'DebugGameplay.sqlite'),
          pathSc.join(localRoot, 'DebugGameplay.sqlite'),
        ]), JSON.stringify(cands));
      check('Local-side Cache found when Documents-side has none',
        findDebugGameplay() === localCacheDb, String(findDebugGameplay()));
      process.env.CIV6_DEBUG_GAMEPLAY = envDb;
      check('env override still wins over Local-side Cache',
        findDebugGameplay() === envDb, String(findDebugGameplay()));
    } finally {
      if (savedEnv === undefined) delete process.env.CIV6_DEBUG_GAMEPLAY;
      else process.env.CIV6_DEBUG_GAMEPLAY = savedEnv;
      pathsMod.myGamesRoot = savedMy;
      pathsMod.localGamesRoot = savedLocal;
    }
  }

  console.log('\nDatabase.log candidates (Local Logs fallback)');
  {
    const docsRoot = pathSc.join(scratch, 'docs-log-root');
    const localRoot = pathSc.join(scratch, 'local-log-root');
    const localLogsDb = pathSc.join(localRoot, 'Logs', 'Database.log');
    const envLog = pathSc.join(scratch, 'env-override.log');
    fsSc.mkdirSync(docsRoot, { recursive: true });
    fsSc.mkdirSync(pathSc.dirname(localLogsDb), { recursive: true });
    fsSc.writeFileSync(localLogsDb, '[100.001] [Gameplay] ERROR: stub\n');
    fsSc.writeFileSync(envLog, '[100.001] [Gameplay] ERROR: stub\n');
    const savedEnv = process.env.CIV6_DATABASE_LOG;
    const pathsMod = require('./paths');
    const savedMy = pathsMod.myGamesRoot;
    const savedLocal = pathsMod.localGamesRoot;
    pathsMod.myGamesRoot = () => docsRoot;
    pathsMod.localGamesRoot = () => localRoot;
    try {
      delete process.env.CIV6_DATABASE_LOG;
      const cands = databaseLogCandidates();
      check('candidates list Documents then Local Logs and bare',
        JSON.stringify(cands) === JSON.stringify([
          pathSc.join(docsRoot, 'Logs', 'Database.log'),
          pathSc.join(localRoot, 'Logs', 'Database.log'),
          pathSc.join(localRoot, 'Database.log'),
        ]), JSON.stringify(cands));
      check('Local-side Logs found when Documents-side has none',
        findDatabaseLog() === localLogsDb, String(findDatabaseLog()));
      process.env.CIV6_DATABASE_LOG = envLog;
      check('env override still wins over Local-side Logs',
        findDatabaseLog() === envLog, String(findDatabaseLog()));
    } finally {
      if (savedEnv === undefined) delete process.env.CIV6_DATABASE_LOG;
      else process.env.CIV6_DATABASE_LOG = savedEnv;
      pathsMod.myGamesRoot = savedMy;
      pathsMod.localGamesRoot = savedLocal;
    }
  }

  console.log('\nRead-only guards (live DBs and configs untouched, no writes)');
  check('fixture Mods.sqlite unchanged', sha(fx.modsDb) === modsBefore);
  check('live game DB content unchanged', sha(fx.debugDb) === debugBefore);
  check('live game DB mtime unchanged', fsSc.statSync(fx.debugDb).mtimeMs === debugMtime);
  const cfgAfter = fsSc.readdirSync(pathSc.join(__dirname, '..'))
    .filter((f) => /\.Civ6Cfg$/i.test(f))
    .map((f) => [f, fsSc.statSync(pathSc.join(__dirname, '..', f)).mtimeMs]);
  check('no .Civ6Cfg file written', JSON.stringify(cfgAfter) === JSON.stringify(cfgBefore),
    `${cfgBefore.length} config(s) before, ${cfgAfter.length} after`);
  const srvSrc = fsSc.readFileSync(pathSc.join(__dirname, 'server.js'), 'utf8');
  check('no POST route under /api/conflicts',
    !/req\.method === 'POST' && url\.pathname === '\/api\/conflicts/.test(srvSrc));
  const viewSrc = fsSc.readFileSync(pathSc.join(__dirname, '..', 'public', 'conflicts.js'), 'utf8');
  const htmlSrc = fsSc.readFileSync(pathSc.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('report page issues no writes (no POST, no form)',
    !/postJson/.test(viewSrc) && !/method:\s*['"]POST['"]/i.test(viewSrc) && !/<form/i.test(viewSrc));
  check("the conflicts page is registered", /pages\s*\[\s*['"]conflicts['"]\s*\]/.test(viewSrc));
  check('navigation links to it', /data-nav="conflicts"/.test(htmlSrc));
  check('its script is loaded', /<script src="conflicts\.js"><\/script>/.test(htmlSrc));
  // The page loads nothing on show: every api("/api/conflicts...") call lives
  // in a click-triggered runner, never in show(). Extract show() by brace
  // matching rather than trusting a regex to find its end.
  const showAt = viewSrc.indexOf('cfShowConflicts');
  let depth = 0; let showBody = ''; let started = false;
  for (let i = showAt; i < viewSrc.length && showAt >= 0; i += 1) {
    const c = viewSrc[i];
    if (c === '{') { depth += 1; started = true; }
    if (started) showBody += c;
    if (c === '}') { depth -= 1; if (started && depth === 0) break; }
  }
  check('page show binds buttons but fetches nothing', showBody && !/api\s*\(\s*['"]\/api\/conflicts/.test(showBody));
  const calls = (srvSrc.match(/conflict(Shadowing|ReplayReport)\(/g) || []).length;
  const defs = (srvSrc.match(/function conflict(Shadowing|ReplayReport|SelfcheckSeed|GateOf|EffectiveOf|ActiveProfile|StageTotals)\b/g) || []).length;
  check('reports run only from their routes and the selfcheck', calls > 0 && calls <= defs + 4, `${calls} call site(s)`);
  // Drop idle keep-alive connections before closing: otherwise process.exit
  // below can race libuv handle teardown on Windows (UV_HANDLE_CLOSING).
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (pass) fsSc.rmSync(scratch, { recursive: true, force: true });
  else console.log(`  note: scratch kept at ${scratch}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-DIAGNOSIS 4.1: ALL SELFCHECK CHECKS PASSED' : 'CONFLICT-DIAGNOSIS 4.1: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}
module.exports = { conflictSelfcheckSeed, runConflictSelfcheck };
