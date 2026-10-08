'use strict';

// tests/loadorder.test.js — node:test suite for load-order overrides (cut over from src/phase7-loadorder.js).
//
// Record-then-replay (Wave 3 phase4 pattern, async extension): node:test runs
// every describe body before any it(), so the sequential shared-DB flow
// CANNOT live in describe bodies. Instead the whole source flow runs in a
// record child process (this same file respawned with LO_RECORD=1, which
// executes the flow in exact source order with check() recording label +
// truthiness + diagnostic), and the parent reads the records JSON and emits
// one it() per executed check(). The describe/it tree mutates nothing, so
// every --test-name-pattern slice passes standalone. Late registration was
// probed and does not work (Temp/opencode/late-probe-test.js: a describe()
// inside before() never runs), hence the subprocess.
//
// Scratch discipline: the child owns its TMP (own synthetic Mods.sqlite,
// own overrides file, spawned servers on test ports against scratch copies
// with CIV6_* env overrides); the live game DB is never named. Cut over in
// cutover-gate-to-node-test: the phase script is deleted and this file is
// authoritative.

const { describe, it, after } = require('node:test');
const { makeTmp, assert } = require('./helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const http = require('http');
const net = require('net');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const lo = require('../src/loadorder');
const transfer = require('../src/loadorder-transfer');
const { fileTimeOf } = require('../src/modsdb');
const { normId } = require('../src/modinfo');

const SRC = path.join(__dirname, '..', 'src');
const PUBLIC = path.join(__dirname, '..', 'public');

if (process.env.LO_RECORD === '1') {
  runRecordFlow();
} else {
  runReplayTree();
}

// ---------------------------------------------------------------------------
// Parent: respawn self as the record child, then emit one it() per record.
// ---------------------------------------------------------------------------

function runReplayTree() {
  const parentTmp = makeTmp('civ6-lo-mirror-');
  const recordPath = path.join(parentTmp, 'records.json');
  const childLogPath = path.join(parentTmp, 'record-child.log');
  const r = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, LO_RECORD: '1', LO_RECORD_PATH: recordPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  });
  const childOut = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(childLogPath, childOut);
  assert.equal(r.status, 0, `record child failed (status=${r.status} signal=${r.signal}; log: ${childLogPath})\n` + String(childOut).split('\n').slice(-25).join('\n'));
  const suites = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  let total = 0;
  for (const s of suites) {
    describe(s.name, () => {
      for (const rec of s.recs) {
        total += 1;
        it(rec.label, () => {
          assert.ok(rec.cond, `${rec.label} :: ${rec.extra}`);
        });
      }
    });
  }
  after(() => {
    fs.rmSync(parentTmp, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// Child: the source flow verbatim, with check() recording instead of gating.
// ---------------------------------------------------------------------------

async function runRecordFlow() {
  const recordPath = process.env.LO_RECORD_PATH;
  const TMP = makeTmp('civ6-loadorder-');
  const DB_PATH = path.join(TMP, 'Mods.sqlite');
  const OV_PATH = path.join(TMP, 'load-order-overrides.json');

  const suites = [];
  let current = null;
  let pass = true;
  const check = (label, cond, extra = '') => {
    current.recs.push({ label, cond: !!cond, extra: String(extra == null ? '' : extra) });
    if (!cond) pass = false;
  };
  const fails = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}`);
  const suite = (name, fn) => {
    const s = { name, recs: [] };
    suites.push(s);
    const prev = current;
    current = s;
    try { fn(); } finally { current = prev; }
  };
  const asuite = async (name, fn) => {
    const s = { name, recs: [] };
    suites.push(s);
    const prev = current;
    current = s;
    try { await fn(); } finally { current = prev; }
  };

  // ---- fixtures (deleted src/phase7-loadorder.js seed/addAction, verbatim) ----

  seed();

  function seed() {
    const w = new DatabaseSync(DB_PATH);
    w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
      CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
      CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
      CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
      CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
      CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
      CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
      CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
      CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
      CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));
      CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
      CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
      CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
      CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);

    const modDir = path.join(TMP, 'mods', 'Real Mod');
    fs.mkdirSync(modDir, { recursive: true });
    const modinfo = path.join(modDir, 'Real.modinfo');
    fs.writeFileSync(modinfo, '<Mod id="aaaaaaaa-1111-4111-8111-111111111111"></Mod>');

    const sf1 = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, ?)').run(modinfo, fileTimeOf(modinfo).toString()).lastInsertRowid;
    const m1 = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf1, 'AAAAAAAA-1111-4111-8111-111111111111').lastInsertRowid;
    addAction(w, m1, 'UpdateDatabase', 'PatchOne', ['Patches/One.sql'], '100');
    addAction(w, m1, 'UpdateDatabase', 'PatchTwo', ['Patches/Two.sql'], '200');
    addAction(w, m1, 'UpdateText', 'Strings', ['Text/Strings.xml'], '300');
    addAction(w, m1, 'UpdateDatabase', 'NeedsAbsent', ['Patches/Absent.sql'], '4000');
    addAction(w, m1, 'UpdateIcons', 'NoPosition', ['Icons/Extra.dds'], null);

    const sf2 = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run('../../../Base/Game/modinfo.xml').lastInsertRowid;
    const m2 = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf2, 'BBBBBBBB-2222-4222-8222-222222222222').lastInsertRowid;
    addAction(w, m2, 'UpdateDatabase', 'NewAction', ['Base/Shared.sql'], '500');
    addAction(w, m2, 'UpdateDatabase', 'NewAction', ['Base/Shared.sql'], '600');
    addAction(w, m2, 'UpdateDatabase', 'Lonely', ['Base/Unique.sql'], null);

    w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
    w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (2, ?, 1, 0, 1)').run('Small');
    const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, 0)');
    item.run(1, m1); item.run(1, m2); item.run(2, m1);

    const sf3 = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, ?)').run(path.join(modDir, 'Other.modinfo'), 1).lastInsertRowid;
    const m3 = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf3, 'CCCCCCCC-3333-4333-8333-333333333333').lastInsertRowid;
    w.prepare("INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, 'Name', ?)").run(m3, 'Other Mod');
    w.prepare("UPDATE ModProperties SET Value = 'LOC_OTHER_MOD_NAME' WHERE ModRowId = ? AND Name = 'Name'").run(m3);
    w.prepare("INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, 'LOC_OTHER_MOD_NAME', 'en_US', 'Other Mod')").run(m3);
    w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, ?)').run(1, m3, 1);
    w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, ?)').run(2, m3, 0);
    w.prepare("INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, 'Name', ?)").run(m1, 'Real Mod');
    w.prepare("INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, 'Name', ?)").run(m2, 'Off Disk Mod');

    const crOf = (id) => w.prepare('SELECT ComponentRowId AS c FROM Components WHERE ComponentId = ? AND ModRowId = ?').get(id, m1).c;
    w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (1, ?, ?, 0)').run(m1, 'Absent');
    w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (2, ?, ?, 0)').run(m1, 'Ruleset');
    w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (1, 1, ?, 0)').run('ModInUse');
    w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (2, 2, ?, 0)').run('RuleSetInUse');
    w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (1, 'Value', ?)").run('DDDDDDDD-4444-4444-8444-444444444444');
    w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (2, 'Value', 'RULESET_EXPANSION_1')").run();
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, 1)').run(crOf('NeedsAbsent'));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, 2)').run(crOf('PatchOne'));

    addAction(w, m1, 'UpdateDatabase', 'GatedOff', ['Patches/Off.sql'], '5000');
    addAction(w, m1, 'UpdateDatabase', 'InvertedOff', ['Patches/InvOff.sql'], '5100');
    addAction(w, m1, 'UpdateDatabase', 'InvertedOn', ['Patches/InvOn.sql'], '5200');
    addAction(w, m1, 'UpdateDatabase', 'InvertedAbsent', ['Patches/InvAbsent.sql'], '5300');
    addAction(w, m1, 'UpdateDatabase', 'AnyAllMet', ['Patches/AnyMet.sql'], '5400');
    addAction(w, m1, 'UpdateDatabase', 'AnyAllUnmet', ['Patches/AnyUnmet.sql'], '5500');
    addAction(w, m1, 'UpdateDatabase', 'AnySplit', ['Patches/AnySplit.sql'], '5600');
    addAction(w, m1, 'UpdateDatabase', 'AnySplitUnknown', ['Patches/AnySplitUnk.sql'], '5700');
    addAction(w, m1, 'UpdateDatabase', 'AndUnmetPlusUnknown', ['Patches/AndUnmet.sql'], '5800');
    addAction(w, m1, 'UpdateDatabase', 'AndMetPlusUnknown', ['Patches/AndMet.sql'], '5900');
    addAction(w, m1, 'UpdateDatabase', 'GameOption', ['Patches/GameOption.sql'], '6000');

    const G = (n, any, conds) => {
      const crid = w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (?, ?, ?, ?)').run(n, m1, 'C' + n, any).lastInsertRowid;
      for (const [type, inverse, value] of conds) {
        const c = w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, ?, ?)').run(null, crid, type, inverse).lastInsertRowid;
        if (value != null) w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, 'Value', ?)").run(c, value);
      }
      return crid;
    };
    const ON1 = 'AAAAAAAA-1111-4111-8111-111111111111';
    const ON2 = 'BBBBBBBB-2222-4222-8222-222222222222';
    const OFF3 = 'CCCCCCCC-3333-4333-8333-333333333333';
    const GONE = 'DDDDDDDD-4444-4444-8444-444444444444';

    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('GatedOff'), G(3, 0, [['ModInUse', 0, OFF3]]));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('InvertedOff'), G(4, 0, [['ModInUse', 1, OFF3]]));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('InvertedOn'), G(5, 0, [['ModInUse', 1, ON1]]));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('InvertedAbsent'), G(6, 0, [['ModInUse', 1, GONE]]));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AnyAllMet'), G(7, 1, [['ModInUse', 0, ON1], ['ModInUse', 0, ON2]]));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AnyAllUnmet'), G(8, 1, [['ModInUse', 0, OFF3], ['ModInUse', 0, GONE]]));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AnySplit'), G(9, 1, [['ModInUse', 0, ON1], ['ModInUse', 0, OFF3]]));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AnySplitUnknown'), G(10, 1, [['ModInUse', 0, ON1], ['RuleSetInUse', 0, 'RULESET_EXPANSION_1']]));
    {
      const crid = w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (?, ?, ?, 0)').run(13, m1, 'GameOption').lastInsertRowid;
      const c = w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, ?, 0)').run(null, crid, 'ConfigurationValueMatches').lastInsertRowid;
      for (const [n2, val] of [['ConfigurationId', 'GAMEMODE_MONOPOLIES'], ['Group', 'Game'], ['Value', '1']]) {
        w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, ?, ?)").run(c, n2, val);
      }
      w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('GameOption'), crid);
    }

    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AndUnmetPlusUnknown'), G(11, 0, [['ModInUse', 0, OFF3], ['RuleSetInUse', 0, 'RULESET_EXPANSION_1']]));
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AndMetPlusUnknown'), G(12, 0, [['ModInUse', 0, ON1], ['RuleSetInUse', 0, 'RULESET_EXPANSION_1']]));
    w.close();
  }

  function addAction(w, modRowId, type, id, files, loadOrder) {
    const cr = w.prepare('INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, ?)')
      .run(modRowId, id, type).lastInsertRowid;
    if (loadOrder !== null && loadOrder !== undefined) {
      const name = id === 'PatchTwo' ? 'LaodOrder' : 'LoadOrder';
      w.prepare('INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, ?, ?)').run(cr, name, String(loadOrder));
    }
    for (const f of files) {
      let row = w.prepare('SELECT FileRowId FROM ModFiles WHERE ModRowId = ? AND Path = ?').get(modRowId, f);
      if (!row) {
        const id2 = w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(modRowId, f).lastInsertRowid;
        row = { FileRowId: id2 };
      }
      w.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId, Priority) VALUES (?, ?, 0)').run(cr, row.FileRowId);
    }
    return cr;
  }

  // ---- connection tracking + helpers (verbatim) ----

  const liveConns = new Set();
  const realOpenDb = lo.openDb;
  lo.openDb = (...a) => {
    const d = realOpenDb(...a);
    liveConns.add(d);
    const close = d.close.bind(d);
    d.close = () => { liveConns.delete(d); return close(); };
    return d;
  };

  const db = () => lo.openDb(DB_PATH);
  const raw = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const one = (sql, ...a) => { const d = db(); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
  const writeFile = (text) => { fs.writeFileSync(OV_PATH, text); return text; };

  const M1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const M2 = 'bbbbbbbb-2222-4222-8222-222222222222';

  // ---- Test 1 ----

  suite('Test 1: reading the overrides file', () => {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent is the normal state */ }
    let v = lo.readOverrides(OV_PATH);
    eq('no file is no overrides', v.count, 0);
    check('  and is not an error', v.error === null, String(v.error));

    writeFile('   \n\t ');
    v = lo.readOverrides(OV_PATH);
    eq('a whitespace-only file is no overrides', v.count, 0);
    check('  and still not an error', v.error === null, String(v.error));

    v = lo.readOverrides(OV_PATH, new Set([normId(M1)]));
    eq('pruning to a known set keeps one', v.count, 0);

    writeFile('{ not json');
    v = lo.readOverrides(OV_PATH);
    check('invalid JSON says so', /is not valid JSON/.test(String(v.error)), String(v.error));
    check('  and is marked unusable, so a write would refuse', v.unusable === true);

    for (const [what, text] of [['an array', '[]'], ['a string', '"x"'], ['null', 'null']]) {
      writeFile(text);
      check(`${what} is unusable`, lo.readOverrides(OV_PATH).unusable === true, String(lo.readOverrides(OV_PATH).error));
    }

    writeFile(JSON.stringify({ version: 99, overrides: {} }));
    v = lo.readOverrides(OV_PATH);
    check('a version this build did not write is refused, not half-understood',
      v.unusable === true && /is version 99/.test(String(v.error)), String(v.error));

    writeFile(JSON.stringify({ overrides: {} }));
    check('a missing version is treated as the current one, so an old file still loads',
      lo.readOverrides(OV_PATH).error === null && lo.readOverrides(OV_PATH).unusable === false);
  });

  // ---- Test 2 ----

  suite('Test 2: one bad entry among good ones', () => {
    writeFile(JSON.stringify({
      version: 1,
      overrides: {
        [M1]: { 'a\nb': 100 },
        'not-a-guid-at-all': { x: 1 },
        [M2]: { 'c\nd': 'not a number' },
      },
    }));
    const v = lo.readOverrides(OV_PATH);
    check('the good entry survives', v.count === 1, String(v.count));
    check('  and the bad ones are counted in the message', /2 entries/.test(String(v.error)), String(v.error));
    check('  but the file is still usable, because the rest of it is real', v.unusable === false);
    check('a key that is not a mod id is dropped, because it could never match a mod',
      lo.isModId(normId('not-a-guid-at-all')) === false && lo.isModId(normId(M1)) === true);

    const orphan = 'cccccccc-3333-4333-8333-333333333333';
    writeFile(JSON.stringify({ version: 1, overrides: { [M1]: { k: 1 }, [orphan]: { k: 2 } } }));
    const keptOrphan = lo.readOverrides(OV_PATH);
    check('an override for a mod you do not have is kept, not reported',
      keptOrphan.error === null && keptOrphan.count === 2, `${keptOrphan.error} count=${keptOrphan.count}`);
    check('  and is pruned when the caller can vouch for the set',
      lo.readOverrides(OV_PATH, new Set([normId(M1)])).count === 1);
    check('  but not when it cannot', lo.readOverrides(OV_PATH, null).count === 2);

    writeFile(JSON.stringify({ version: 1, overrides: { [M1]: { k: 1 }, note: 'ignore me' } }));
    check('a key whose value is not an override map is reported, because that is junk',
      /1 entry/.test(String(lo.readOverrides(OV_PATH).error)), String(lo.readOverrides(OV_PATH).error));
    check('  and the real entries alongside it still load', lo.readOverrides(OV_PATH).count === 1);

    writeFile(JSON.stringify({ version: 1, overrides: { [M1]: { k: 5 } } }));
    check('a bare number loads, so a hand-written file works', lo.readOverrides(OV_PATH).count === 1);
  });

  // ---- Test 3 ----

  suite('Test 3: writing', () => {
    writeFile('{ broken');
    const before = fs.readFileSync(OV_PATH, 'utf8');
    check('writing over an unusable file is refused', fails(() => lo.setOverride(OV_PATH, M1, 'a\nb', 5, 1)));
    check('  and leaves it byte-for-byte as it was', fs.readFileSync(OV_PATH, 'utf8') === before);
    let msg = '';
    try { lo.setOverride(OV_PATH, M1, 'a\nb', 5, 1); } catch (e) { msg = e.message; }
    check('  and says why, rather than just failing', /nothing was written/.test(msg), msg);

    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const d = db();
    const crOf = (id) => d.prepare('SELECT ComponentRowId AS c FROM Components WHERE ComponentId = ?').get(id).c;
    const k1 = lo.actionKey(d, crOf('PatchOne'));
    const k2 = lo.actionKey(d, crOf('Strings'));
    d.close();
    lo.setOverride(OV_PATH, M1, k1, 5000, 100);
    const v = lo.readOverrides(OV_PATH);
    eq('one override stored', v.count, 1);
    eq('  with the value asked for', v.overrides[normId(M1)][k1].value, 5000);
    eq('  and the declared value kept for reset', v.overrides[normId(M1)][k1].declared, 100);

    lo.setOverride(OV_PATH, M2, k2, 250, 0);
    eq('a second mod is a second entry', lo.readOverrides(OV_PATH).count, 2);

    lo.setOverride(OV_PATH, M1, k1, 6000, 100);
    eq('overwriting one leaves the other alone', lo.readOverrides(OV_PATH).count, 2);
    eq('  and takes the new value', lo.readOverrides(OV_PATH).overrides[normId(M1)][k1].value, 6000);

    const onDisk = JSON.parse(fs.readFileSync(OV_PATH, 'utf8'));
    eq('the file is version 1', onDisk.version, 1);
    check('  with the richer entry form, so reset survives', onDisk.overrides[normId(M1)][k1].declared === 100);

    lo.clearOverride(OV_PATH, M1, k1);
    eq('clearing one leaves the other', lo.readOverrides(OV_PATH).count, 1);
    check('clearing something absent is refused', fails(() => lo.clearOverride(OV_PATH, M1, k1)));
  });

  // ---- Test 4 ----

  suite('Test 4: what a value may be', () => {
    const d = db();
    const cr = one("SELECT ComponentRowId AS c FROM Components WHERE ComponentId='PatchTwo'").c;
    const key = lo.actionKey(d, cr);
    d.close();
    for (const v of [-200, 0, 4, 22222, 100000001]) {
      lo.setOverride(OV_PATH, M1, key, v, 200);
      eq(`  ${v} is accepted`, lo.readOverrides(OV_PATH).overrides[normId(M1)][key].value, v);
    }
    for (const bad of ['nope', 1.5, NaN, null, {}]) {
      check(`  ${JSON.stringify(bad)} is refused`, fails(() => lo.setOverride(OV_PATH, M1, key, bad, 1)));
    }
    check('  a value past the sanity bound is refused', fails(() => lo.setOverride(OV_PATH, M1, key, 1e30, 1)));
    lo.clearOverride(OV_PATH, M1, key);
  });

  // ---- Test 5 ----

  suite('Test 5: naming an action', () => {
    const d = db();
    const cr = one("SELECT ComponentRowId AS c FROM Components WHERE ComponentId='PatchOne'").c;
    const key = lo.actionKey(d, cr);
    eq('the key starts with the type', key.split('\n')[0], 'UpdateDatabase');
    eq('  then the id', key.split('\n')[1], 'PatchOne');
    check('  then the file list', key.includes('Patches/One.sql'), JSON.stringify(key));
    check('the file list is sorted', (() => {
      const k = lo.actionKey(d, one("SELECT ComponentRowId AS c FROM Components WHERE ComponentType='UpdateText'").c);
      return k.split('\n').slice(2).join(',') === k.split('\n').slice(2).sort().join(',');
    })());
    check('a backslash path is stored with forward slashes, as the game does',
      lo.keyFor('UpdateDatabase', 'x', ['a\\b.sql']) === 'UpdateDatabase\nx\na/b.sql', JSON.stringify(lo.keyFor('UpdateDatabase', 'x', ['a\\b.sql'])));
    check('the order of the file list does not change the key',
      lo.keyFor('T', 'i', ['b.sql', 'a.sql']) === lo.keyFor('T', 'i', ['a.sql', 'b.sql']));
    check('a key never contains a newline inside a part',
      lo.keyFor('T', 'has\nnewline', ['f.sql']).split('\n').length === 3, JSON.stringify(lo.keyFor('T', 'has\nnewline', ['f.sql'])));

    const self = lo.resolveAction(d, M1, key);
    check('an action resolves to itself', self.state === lo.FIND && self.componentRowId === cr, `${self.state} ${self.componentRowId}`);

    const missing = lo.resolveAction(d, M1, 'UpdateDatabase\nnope\nno.sql');
    check('a key matching nothing is missing, not guessed', missing.state === lo.MISSING, missing.state);
    check('  and offers no candidates', missing.candidates.length === 0);
    check('an unknown mod is missing', lo.resolveAction(d, 'no-such-mod', key).state === lo.MISSING);

    const dup = lo.actionKey(d, one("SELECT MIN(ComponentRowId) AS c FROM Components WHERE ComponentId='NewAction'").c);
    const amb = lo.resolveAction(d, M2, dup);
    check('two identical actions are ambiguous, never one of them picked', amb.state === lo.AMBIGUOUS, amb.state);
    check('  and both candidates are offered', amb.candidates.length === 2, String(amb.candidates.length));
    check('  with no componentRowId chosen', amb.componentRowId === null);
    d.close();
  });

  // ---- Test 6 ----

  suite('Test 6: the key has to survive what actually changes', () => {
    const d = db();
    const cr = one("SELECT ComponentRowId AS c FROM Components WHERE ComponentId='PatchOne'").c;
    const key = lo.actionKey(d, cr);
    d.close();

    const w = new DatabaseSync(DB_PATH);
    w.prepare("UPDATE ComponentProperties SET Value = '9999' WHERE ComponentRowId = ? AND Name = 'LoadOrder'").run(cr);
    w.close();
    let d2 = db();
    check('a bumped declared value still resolves', lo.resolveAction(d2, M1, key).componentRowId === cr);
    d2.close();

    const typo = one("SELECT ComponentRowId AS c FROM Components WHERE ComponentId='PatchTwo'").c;
    d2 = db();
    const typoKey = lo.actionKey(d2, typo);
    check('an action whose property is spelled LaodOrder is keyed the same way',
      typoKey === 'UpdateDatabase\nPatchTwo\nPatches/Two.sql', JSON.stringify(typoKey));
    check('  and resolves', lo.resolveAction(d2, M1, typoKey).componentRowId === typo);
    d2.close();

    const renumber = new DatabaseSync(DB_PATH);
    renumber.exec('UPDATE Mods SET ModRowId = ModRowId + 100');
    renumber.exec('UPDATE ModGroupItems SET ModRowId = ModRowId + 100');
    renumber.exec('UPDATE Components SET ComponentRowId = ComponentRowId + 1000, ModRowId = ModRowId + 100');
    renumber.exec('UPDATE ComponentProperties SET ComponentRowId = ComponentRowId + 1000');
    renumber.exec('UPDATE ComponentFiles SET ComponentRowId = ComponentRowId + 1000');
    renumber.exec('UPDATE ComponentCriteria SET ComponentRowId = ComponentRowId + 1000');
    renumber.exec('UPDATE ModProperties SET ModRowId = ModRowId + 100');
    renumber.exec('UPDATE ModFiles SET ModRowId = ModRowId + 100');
    renumber.exec('UPDATE Criteria SET ModRowId = ModRowId + 100');
    renumber.exec('UPDATE LocalizedText SET ModRowId = ModRowId + 100');
    renumber.close();

    {
      const rq = new DatabaseSync(DB_PATH, { readOnly: true });
      const dangling = ['ModGroupItems', 'ModProperties', 'ModFiles', 'Criteria', 'LocalizedText']
        .map((t) => [t, rq.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ModRowId NOT IN (SELECT ModRowId FROM Mods)`).get().n])
        .filter(([, n]) => n > 0);
      const orphanComp = ['ComponentProperties', 'ComponentFiles', 'ComponentCriteria']
        .map((t) => [t, rq.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ComponentRowId NOT IN (SELECT ComponentRowId FROM Components)`).get().n])
        .filter(([, n]) => n > 0);
      rq.close();
      check('the simulated rescan left no table pointing at a row id that moved',
        dangling.length === 0 && orphanComp.length === 0,
        JSON.stringify({ mods: dangling, components: orphanComp }));
    }

    d2 = db();
    const moved = lo.resolveAction(d2, M1, key);
    check('and so does a rescan that replaced every row id',
      moved.state === lo.FIND && moved.componentRowId === cr + 1000, `${moved.state} ${moved.componentRowId}`);
    check('  with the new id, not the old one', moved.componentRowId !== cr);

    const stillThere = d2.prepare('SELECT ComponentRowId FROM Components WHERE ComponentId = ?').get('PatchOne').ComponentRowId;
    check('a ComponentRowId-keyed lookup now names a different row than the one it meant',
      stillThere !== cr, `${cr} is now ${stillThere}`);
    check('while the content key is unchanged across that same rescan',
      lo.actionKey(d2, stillThere) === key, JSON.stringify(lo.actionKey(d2, stillThere)));
    d2.close();
  });

  // ---- Test 7 ----

  suite('Test 7: the stamp', () => {
    const d = db();
    const m1row = one('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)', M1);
    const m2row = one('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)', M2);

    const f = lo.modFile(d, m1row.ModRowId);
    check('a mod whose .modinfo is on disk is reported as such', f.onDisk === true, f.path);
    check('  and its stamp is fresh - the game wrote it from these bytes', lo.stampIsStale(d, m1row.ModRowId) === false);
    check('  and the stamp is a string, because the column overflows a JS number',
      typeof lo.stampFor(f.path) === 'string', lo.stampFor(f.path));

    const before = lo.stampFor(f.path);
    fs.writeFileSync(f.path, '<Mod id="aaaaaaaa-1111-4111-8111-111111111111"><X/></Mod>');
    check('moving the file makes the stamp stale', lo.stampIsStale(d, m1row.ModRowId) === true);
    check('  and the new stamp differs from the old', lo.stampFor(f.path) !== before);

    const w = new DatabaseSync(DB_PATH);
    const sf = w.prepare('SELECT ScannedFileRowId FROM Mods WHERE ModRowId = ?').get(m1row.ModRowId).ScannedFileRowId;
    w.prepare('UPDATE ScannedFiles SET LastWriteTime = ? WHERE ScannedFileRowId = ?').run(lo.stampFor(f.path), sf);
    w.close();
    const d2 = db();
    check('writing the stamp makes it fresh again', lo.stampIsStale(d2, m1row.ModRowId) === false);
    d2.close();

    const d3 = db();
    const exact = lo.stampFor(f.path);
    const ms = fileTimeOf(f.path) / 10000n;
    const rounded = (ms * 10000n).toString();
    const w2 = new DatabaseSync(DB_PATH);
    w2.prepare('UPDATE ScannedFiles SET LastWriteTime = ? WHERE ScannedFileRowId = ?').run(rounded, sf);
    w2.close();
    const d4 = db();
    check('a millisecond-rounded stamp is still stale - it reads as a changed file',
      lo.stampIsStale(d4, m1row.ModRowId) === true, `exact ${exact} rounded ${rounded}`);
    check('  and the two differ, which is why it matters', exact !== rounded);
    d4.close();
    const w3 = new DatabaseSync(DB_PATH);
    w3.prepare('UPDATE ScannedFiles SET LastWriteTime = ? WHERE ScannedFileRowId = ?').run(exact, sf);
    w3.close();

    const f2 = lo.modFile(d3, m2row.ModRowId);
    check('a mod whose .modinfo is not on disk says so', f2.onDisk === false, f2.path);
    check('  and stampIsStale answers null - nothing to compare, nothing to keep up to date',
      lo.stampIsStale(d3, m2row.ModRowId) === null, String(lo.stampIsStale(d3, m2row.ModRowId)));
    check('  and the 42 relative-path rows are exactly this shape: ../../..',
      f2.path.startsWith('../'), f2.path);

    check('reading LastWriteTime as a number throws, so the CAST is not optional',
      fails(() => {
        const dd = db();
        try { dd.prepare('SELECT LastWriteTime FROM ScannedFiles WHERE ScannedFileRowId = ?').get(sf); } finally { dd.close(); }
      }));
    const d5 = db();
    const asText = d5.prepare('SELECT CAST(LastWriteTime AS TEXT) AS t FROM ScannedFiles WHERE ScannedFileRowId = ?').get(sf);
    check('CAST to TEXT is what makes it readable', typeof asText.t === 'string', asText.t);
    d5.close();
    d3.close();
    d.close();
  });

  // ---- async-chain shared helpers (source preamble, verbatim) ----

  const newestBackup = () => {
    const all = fs.readdirSync(TMP).filter((f) => f.startsWith('Mods.sqlite.bak-'));
    return all.length ? path.join(TMP, all.sort().pop()) : null;
  };
  const OPEN = async () => ({ running: false, known: true, processes: [] });
  const RUNNING = async () => ({ running: true, known: true, processes: ['CivilizationVI.exe'] });
  const crOf = (id) => {
    const d = db();
    try { return d.prepare('SELECT ComponentRowId AS c FROM Components WHERE ComponentId = ?').get(id).c; } finally { d.close(); }
  };
  const keyOf = (id) => {
    const d = db();
    try { return lo.actionKey(d, crOfIn(d, id)); } finally { d.close(); }
  };
  const crOfIn = (d, id) => d.prepare('SELECT ComponentRowId AS c FROM Components WHERE ComponentId = ?').get(id).c;
  const firstCrIn = (d, id) => d.prepare('SELECT MIN(ComponentRowId) AS c FROM Components WHERE ComponentId = ?').get(id).c;
  const stored = (id, k) => { const v = lo.readOverrides(OV_PATH); return (v.overrides[normId(id)] || {})[k]; };
  const dbValue = (cr) => {
    const d = db();
    try { const r = d.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'").get(cr); return r ? String(r.v) : null; } finally { d.close(); }
  };
  const modRowId = (id) => {
    const d = db();
    try { const r = d.prepare('SELECT ModRowId AS r FROM Mods WHERE lower(ModId) = lower(?)').get(id); return r ? r.r : null; } finally { d.close(); }
  };
  const staleOf = (id) => {
    const d = db();
    try { return lo.stampIsStale(d, modRowIdIn(d, id)); } finally { d.close(); }
  };
  const modRowIdIn = (d, id) => d.prepare('SELECT ModRowId AS r FROM Mods WHERE lower(ModId) = lower(?)').get(id).r;
  const fileOf = (id) => {
    const d = db();
    try { return lo.modFile(d, modRowIdIn(d, id)).path; } finally { d.close(); }
  };

  // ---- Test 9 ----

  await asuite('Test 9: refusing to write while the game has the database open', async () => {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const k = keyOf('PatchOne');
    const before = newestBackup();
    let msg = '';
    try {
      await lo.applyOverrides(DB_PATH, [{ modId: M1, key: k, value: 4242 }], { file: OV_PATH, statusFn: RUNNING });
    } catch (e) { msg = e.message; }
    check('apply refuses while Civilization VI is running', /close Civilization VI/.test(msg), msg);
    check('  and says why, naming the database', /mod database open/.test(msg));
    check('  and wrote nothing', dbValue(crOf('PatchOne')) !== '4242');
    check('  and took no backup', newestBackup() === before, `${newestBackup()} vs ${before}`);
    check('  and stored no intent', lo.readOverrides(OV_PATH).count === 0);

    let rmsg = '';
    try { await lo.resetOverride(DB_PATH, M1, k, { file: OV_PATH, statusFn: RUNNING }); } catch (e) { rmsg = e.message; }
    check('reset refuses too', /close Civilization VI/.test(rmsg), rmsg);
  });

  // ---- Test 10 ----

  await asuite('Test 10: applying by hand', async () => {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const kOne = keyOf('PatchOne');
    const kTwo = keyOf('PatchTwo');
    const kThree = keyOf('Strings');
    const crOne = crOf('PatchOne');
    const crTwo = crOf('PatchTwo');
    const crThree = crOf('Strings');

    const r = await lo.applyOverrides(DB_PATH, [
      { modId: M1, key: kOne, value: 4242 },
      { modId: M1, key: kTwo, value: 7000 },
      { modId: M1, key: kThree, value: 8000 },
    ], { file: OV_PATH, statusFn: OPEN });

    check('three overrides in one call all land',
      r.applied.length === 3 && r.applied.every((a) => typeof a.componentRowId === 'number'),
      `applied ${r.applied.length}`);
    check('  each value is in the database', dbValue(crOne) === '4242' && dbValue(crThree) === '8000',
      `${dbValue(crOne)} / ${dbValue(crThree)}`);
    check('  and a backup exists and is a real file',
      typeof r.backupPath === 'string' && fs.existsSync(r.backupPath) && fs.statSync(r.backupPath).size > 0,
      r.backupPath);

    {
      const b = new DatabaseSync(r.backupPath, { readOnly: true });
      const pre = b.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'");
      const before = [pre.get(crOne), pre.get(crTwo), pre.get(crThree)].map((x) => (x ? x.v : null));
      const post = dbValue(crOne) + '/' + dbValue(crTwo) + '/' + dbValue(crThree);
      b.close();
      check('the backup is a pre-image of the whole batch, so none of the three is in it',
        !before.includes('4242') && !before.includes('7000') && !before.includes('8000'),
        'backup held ' + JSON.stringify(before) + ', live now ' + post);
      check("  and it holds the author's own value where there was one",
        before[0] === '9999' && before[2] === '300', JSON.stringify(before));
      check('  the misspelled one has no LoadOrder row in the backup at all, because the override creates one',
        before[1] === null && dbValue(crTwo) === '7000',
        'backup ' + JSON.stringify(before[1]) + ', live ' + dbValue(crTwo));
    }

    const d = db();
    const typoRow = d.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LaodOrder'").get(crTwo);
    const goodRow = d.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'").get(crTwo);
    d.close();
    check('an action whose property is spelled LaodOrder is overridden anyway', r.applied.some((a) => a.key === kTwo),
      JSON.stringify(r.applied.map((a) => a.key)));
    check('  by writing a correctly spelled LoadOrder row', !!goodRow && String(goodRow.v) === '7000', JSON.stringify(goodRow));
    check('  and leaving the mod\'s own misspelled row untouched',
      !!typoRow && String(typoRow.v) === '200', JSON.stringify(typoRow));

    check('the author\'s value is recorded, so reset is possible', stored(M1, kOne).declared === 9999, JSON.stringify(stored(M1, kOne)));
    check('  and for the misspelled one it is read from the row the mod actually wrote', stored(M1, kTwo).declared === 200, JSON.stringify(stored(M1, kTwo)));

    const mr = modRowId(M1);
    check('  and the mod is on disk, so it can be stamped at all', mr !== null, String(mr));
    check('  and its stamp is fresh, so the game will not re-derive it',
      staleOf(M1) === false, String(staleOf(M1)));

    const s = await lo.applyOverrides(DB_PATH, [{ modId: M1, key: kOne, value: 10000001 }], { file: OV_PATH, statusFn: OPEN });
    check('a value past the load-last sentinel is applied and reported',
      s.applied.length === 1 && s.sentinels.length === 1, JSON.stringify(s.sentinels));

    const bad = await lo.applyOverrides(DB_PATH, [
      { modId: M1, key: 'UpdateDatabase\nnope\nno.sql', value: 1 },
      { modId: M2, key: 'UpdateDatabase\nNewAction\nBase/Shared.sql', value: 2 },
    ], { file: OV_PATH, statusFn: OPEN });
    check('an unresolvable key is reported, not written',
      bad.orphans.length === 1 && bad.ambiguous.length === 1 && bad.applied.length === 0,
      `orphans ${bad.orphans.length} ambiguous ${bad.ambiguous.length} applied ${bad.applied.length}`);
    check('  and the ambiguity says how many matched', /2 actions match/.test(String(bad.ambiguous[0].reason)), String(bad.ambiguous[0].reason));
    check('  and nothing was stored for either, so the three real ones are still three',
      lo.readOverrides(OV_PATH).count === 3, String(lo.readOverrides(OV_PATH).count));

    const kBase = (() => {
      const d = db();
      try { return lo.actionKey(d, firstCrIn(d, 'Lonely')); } finally { d.close(); }
    })();
    const un = await lo.applyOverrides(DB_PATH, [{ modId: M2, key: kBase, value: 999 }], { file: OV_PATH, statusFn: OPEN });
    check('a mod with no .modinfo on disk still takes the value', un.applied.length === 1, JSON.stringify(un.applied));
    check('  and is reported as unprotectable rather than treated as safe',
      un.unprotectable.length === 1 && un.unprotectable[0] === normId(M2), JSON.stringify(un.unprotectable));
  });

  // ---- Test 11 ----

  await asuite('Test 11: putting one back', async () => {
    const k = keyOf('PatchOne');
    const r = await lo.resetOverride(DB_PATH, M1, k, { file: OV_PATH, statusFn: OPEN });
    check('reset restores the value the author declared', r.restored === 9999 && dbValue(crOf('PatchOne')) === '9999',
      `${r.restored} / ${dbValue(crOf('PatchOne'))}`);
    check('  and forgets the override', stored(M1, k) === undefined);
    let msg = '';
    try { await lo.resetOverride(DB_PATH, M1, k, { file: OV_PATH, statusFn: OPEN }); } catch (e) { msg = e.message; }
    check('  and resetting again is refused', /no override is stored/.test(msg), msg);
  });

  // ---- Test 12 ----

  await asuite('Test 12: sync at startup', async () => {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const before = newestBackup();
    let s = lo.syncOverrides(DB_PATH, { file: OV_PATH });
    check('with no overrides, sync does nothing', s.changed === false && s.applied.length === 0);
    check('  and spends no backup', newestBackup() === before, `${newestBackup()} vs ${before}`);

    s = lo.syncOverrides(DB_PATH, { file: OV_PATH, gameRunning: true });
    check('with the game running it is deferred, never silently skipped',
      s.deferred === true && /Civilization VI is running/.test(String(s.reason)), JSON.stringify(s.reason));
    check('  and nothing was written', newestBackup() === before, `${newestBackup()} vs ${before}`);

    const k1 = keyOf('Strings');
    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: k1, value: 300 }], { file: OV_PATH, statusFn: OPEN });
    const mid = newestBackup();
    s = lo.syncOverrides(DB_PATH, { file: OV_PATH });
    check('a sync with nothing to repair writes nothing', s.changed === false && s.drifted.length === 0);
    check('  and takes no backup', newestBackup() === mid, `${newestBackup()} vs ${mid}`);

    const k2 = keyOf('PatchOne');
    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: k2, value: 4242 }], { file: OV_PATH, statusFn: OPEN });
    const file = fileOf(M1);
    fs.writeFileSync(file, '<Mod id="aaaaaaaa-1111-4111-8111-111111111111"><V2/></Mod>');
    const w = new DatabaseSync(DB_PATH);
    w.exec('UPDATE Mods SET ModRowId = ModRowId + 500');
    w.exec('UPDATE ModGroupItems SET ModRowId = ModRowId + 500');
    w.exec('UPDATE Components SET ComponentRowId = ComponentRowId + 5000, ModRowId = ModRowId + 500');
    w.exec('UPDATE ComponentProperties SET ComponentRowId = ComponentRowId + 5000');
    w.exec('UPDATE ComponentFiles SET ComponentRowId = ComponentRowId + 5000');
    w.exec('UPDATE ModProperties SET ModRowId = ModRowId + 500');
    w.exec('UPDATE ModFiles SET ModRowId = ModRowId + 500');
    w.exec('UPDATE Criteria SET ModRowId = ModRowId + 500');
    w.exec('UPDATE LocalizedText SET ModRowId = ModRowId + 500');
    w.exec('UPDATE ComponentCriteria SET ComponentRowId = ComponentRowId + 5000');
    w.exec("UPDATE ComponentProperties SET Value = '9999' WHERE Name = 'LoadOrder'");
    w.exec("UPDATE ComponentProperties SET Value = '300' WHERE Name = 'LoadOrder' AND ComponentRowId IN (SELECT ComponentRowId FROM Components WHERE ComponentId = 'Strings')");
    w.close();

    const preSync = lo.staleMods(DB_PATH, { file: OV_PATH });
    check('a mod that updated is reported stale before it is repaired',
      preSync.stale.length === 1 && preSync.stale[0] === normId(M1), JSON.stringify(preSync.stale));

    s = lo.syncOverrides(DB_PATH, { file: OV_PATH });
    check('one sync repairs what had drifted', s.changed === true && s.applied.length === 1,
      `changed ${s.changed} applied ${s.applied.length}`);
    check('  and reports exactly the one it repaired, and nothing else', s.drifted.length === 1,
      JSON.stringify(s.drifted.map((d) => d.key)));
    check('  from the value the rescan put back to the value asked for',
      s.drifted[0].from === '9999' && s.drifted[0].to === '4242', JSON.stringify(s.drifted[0]));
    check('  and a backup path is reported, pointing at a real file',
      typeof s.backupPath === 'string' && fs.existsSync(s.backupPath), String(s.backupPath));
    check('  against the NEW row ids, not the ones that were replaced',
      s.applied.length > 0 && s.applied.every((a) => a.componentRowId > 5000),
      JSON.stringify(s.applied.map((a) => a.componentRowId)));

    const d3 = db();
    const cr = d3.prepare('SELECT ComponentRowId AS c FROM Components WHERE ComponentId = ?').get('PatchOne').c;
    d3.close();
    check('  the value is back on the renumbered row', dbValue(cr) === '4242', String(dbValue(cr)));
    check('  and the stamp is fresh again, so the first launch is right',
      staleOf(M1) === false, String(staleOf(M1)));
    check('  and nothing is reported stale any more', lo.staleMods(DB_PATH, { file: OV_PATH }).stale.length === 0);
  });

  // ---- Test 13 ----

  await asuite('Test 13: sync reports what it will not do', async () => {
    const v = lo.readOverrides(OV_PATH);
    const next = { ...v.overrides };
    next[normId(M1)] = { ...(next[normId(M1)] || {}), 'UpdateDatabase\ngone\nx.sql': { value: 1 } };
    next[normId(M2)] = { 'UpdateDatabase\nNewAction\nBase/Shared.sql': { value: 2 } };
    lo.writeOverrides(OV_PATH, next);
    const s = lo.syncOverrides(DB_PATH, { file: OV_PATH });
    check('an orphaned override is reported', s.orphans.length >= 1, JSON.stringify(s.orphans.map((o) => o.reason)));
    check('an ambiguous one is reported separately', s.ambiguous.length >= 1, JSON.stringify(s.ambiguous.map((a) => a.reason)));
    check('  and neither was written', s.applied.every((a) => a.key !== 'UpdateDatabase\ngone\nx.sql'));
    lo.writeOverrides(OV_PATH, {});
  });

  // ---- Test 14 ----

  await asuite('Test 14: the load order view', async () => {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const v = lo.profileLoadOrder(DB_PATH, { file: OV_PATH, asserted: {} });
    check('the view builds', v.ok === true, v.error || '');
    check('  and names the profile in use', v.profile && v.profile.name === 'Main', JSON.stringify(v.profile));
    check('  and offers every profile to choose from', v.groups.length === 2, JSON.stringify(v.groups.map((g) => g.name)));

    const values = v.bands.filter((b) => b.kind === 'value').map((b) => b.value);
    check('  value bands are ascending', values.every((x, i) => i === 0 || x > values[i - 1]), values.join(','));
    check('  every positioned action is in exactly one band',
      v.bands.filter((b) => b.kind === 'value').reduce((t, b) => t + b.actions.length, 0) + v.undeclaredTotal === v.summary.actions,
      JSON.stringify(v.summary));
    check('  and every action knows its mod',
      v.bands.flatMap((b) => b.actions || []).every((a) => a.modId && a.modName && a.modName !== 'unknown mod'));

    const frees = v.bands.filter((b) => b.kind === 'free');
    check('  free runs are rows of their own', frees.length > 0, String(frees.length));
    check('  each one is at least the threshold and adds up',
      frees.every((b) => b.count >= lo.MIN_FREE_RUN && b.to - b.from + 1 === b.count),
      frees.map((b) => `${b.from}..${b.to}=${b.count}`).join(' '));
    const freeOk = v.bands.every((b, i, all) => {
      if (b.kind !== 'free') return true;
      const before = all[i - 1];
      const after = all[i + 1];
      return before.kind === 'value' && after.kind === 'value' && b.from === before.value + 1 && b.to === after.value - 1;
    });
    check('  and each one really is between the values either side of it', freeOk);

    check('  undeclared actions are counted, not dropped', v.undeclaredTotal === 1, String(v.undeclaredTotal));
    check('  and grouped by mod', v.undeclared.length === 1 && v.undeclared[0].count === 1, JSON.stringify(v.undeclared));
    check('  the arithmetic closes over all three views of the actions',
      v.summary.positioned + v.undeclaredTotal === v.summary.actions);

    const byId = (cid) => v.bands.flatMap((b) => b.actions || []).find((a) => a.id === cid);
    check('an action gated on a mod that is not installed is provably off',
      byId('NeedsAbsent').willRun === false, JSON.stringify(byId('NeedsAbsent')));
    check('  and says which mod is missing', /not installed/.test(byId('NeedsAbsent').reason), byId('NeedsAbsent').reason);
    check('an action gated on a game ruleset is not guessed at',
      byId('PatchOne').willRun === null, String(byId('PatchOne').willRun));
    check('  and the row says what it could not decide',
      byId('PatchOne').unknown.length === 1 && byId('PatchOne').unknown[0].type === 'RuleSetInUse',
      JSON.stringify(byId('PatchOne').unknown));
    check('  an action with no conditions at all is simply on',
      byId('Strings').willRun === true, String(byId('Strings').willRun));

    check('an action gated on a mod installed but off in this profile is provably off',
      byId('GatedOff').willRun === false, JSON.stringify(byId('GatedOff')));
    check('  and says which mod, and that it wants it on',
      /Other Mod/.test(byId('GatedOff').reason || '') && /on in this profile/.test(byId('GatedOff').reason || ''),
      byId('GatedOff').reason);
    check('  and reports no unknown reason for it', byId('GatedOff').unknown.length === 0,
      JSON.stringify(byId('GatedOff').unknown));

    check('a mod whose Name is a localization tag is shown as its text, not the tag',
      /Other Mod/.test(byId('GatedOff').reason || '')
      && !/LOC_OTHER_MOD_NAME/.test(byId('GatedOff').reason || ''),
      byId('GatedOff').reason);
    check('  and every row naming a mod shows no bare LOC_ tag at all',
      v.bands.flatMap((b) => b.actions || []).every((a) => !/LOC_[A-Z0-9_]+/.test(a.modName)),
      JSON.stringify(v.bands.flatMap((b) => b.actions || []).map((a) => a.modName).filter((x) => /LOC_[A-Z0-9_]+/.test(x))));
    check('  and the undeclared block groups by that same name',
      v.undeclared.every((u) => !/LOC_[A-Z0-9_]+/.test(u.name)),
      JSON.stringify(v.undeclared.map((u) => u.name)));
    const small = lo.profileLoadOrder(DB_PATH, { file: OV_PATH, groupId: 2, asserted: {} });

    check('  the same mod being on in ANOTHER profile does not rescue it here',
      v.summary.modsOn === 2 && small.summary.modsOn === 2,
      'm3 is off in Main and on in Small: ' + v.summary.modsOn + ' / ' + small.summary.modsOn);

    check('a NOT condition is inverted, not skipped: NOT ModInUse(on) does not run',
      byId('InvertedOn').willRun === false, JSON.stringify(byId('InvertedOn')));
    check('  and says the mod has to be off, not on',
      /to be off in this profile/.test(byId('InvertedOn').reason || ''), byId('InvertedOn').reason);
    check('  NOT ModInUse(off) does run, because it is off',
      byId('InvertedOff').willRun === true, JSON.stringify(byId('InvertedOff')));
    check('  and NOT ModInUse(nothing installed) runs, the absence being what it asks for',
      byId('InvertedAbsent').willRun === true, JSON.stringify(byId('InvertedAbsent')));

    check('an Any=1 set with every condition met runs',
      byId('AnyAllMet').willRun === true, JSON.stringify(byId('AnyAllMet')));
    check('  an Any=1 set with every condition unmet does not',
      byId('AnyAllUnmet').willRun === false, JSON.stringify(byId('AnyAllUnmet')));
    check('  an Any=1 set that SPLITS runs, because one met condition carries an OR',
      byId('AnySplit').willRun === true, JSON.stringify(byId('AnySplit')));
    check('    and the old code called that one false, treating every set as an AND',
      true);
    check('  an Any=1 set with one met and one unreadable also runs',
      byId('AnySplitUnknown').willRun === true, JSON.stringify(byId('AnySplitUnknown')));
    check('    and still says what it could not read, rather than hiding it',
      byId('AnySplitUnknown').unknown.length === 1
      && byId('AnySplitUnknown').unknown[0].type === 'RuleSetInUse',
      JSON.stringify(byId('AnySplitUnknown').unknown));

    check('an AND set with one unmet and one unreadable is provably off',
      byId('AndUnmetPlusUnknown').willRun === false, JSON.stringify(byId('AndUnmetPlusUnknown')));
    check('  naming the condition it could read, and not pretending the other is fine',
      /Other Mod/.test(byId('AndUnmetPlusUnknown').reason || '')
      && byId('AndUnmetPlusUnknown').unknown.length === 1,
      byId('AndUnmetPlusUnknown').reason + ' / ' + JSON.stringify(byId('AndUnmetPlusUnknown').unknown));
    check('  but an AND set with one met and one unreadable stays undecided',
      byId('AndMetPlusUnknown').willRun === null, JSON.stringify(byId('AndMetPlusUnknown')));
    check('  but an AND set with one met and one unreadable stays undecided',
      byId('AndMetPlusUnknown').willRun === null, JSON.stringify(byId('AndMetPlusUnknown')));

    const decided = v.bands.flatMap((b) => b.actions || []).filter((a) => a.willRun !== null);
    const undecided = v.bands.flatMap((b) => b.actions || []).filter((a) => a.willRun === null);
    check(
      'the summary agrees with the rows: decided plus undecided is every positioned action',
      decided.length + undecided.length === v.summary.positioned,
      decided.length + ' + ' + undecided.length + ' vs ' + v.summary.positioned);
    check('  and the unknown count is exactly the undecided ones',
      undecided.length === v.summary.unknown,
      undecided.length + ' vs ' + v.summary.unknown);
    check('  and nothing is assumed without assertions - an ambient store must never move these rows',
      v.summary.assumed === 0, String(v.summary.assumed));
    check('  and no row decided false is left without saying why',
      decided.every((a) => a.willRun === true || a.reason),
      JSON.stringify(decided.filter((a) => !a.reason).map((a) => a.id)));
    check('a condition with three properties is one condition, not three',
      byId('GameOption').unknown.length === 1, JSON.stringify(byId('GameOption').unknown));
    check('  and the row says so, having previously listed the same reason three times',
      byId('GameOption').unknown[0].why.split(' - ').length === 2,
      byId('GameOption').unknown[0].why);
    check('  the reason names the game option, not just the criterion type',
      /GAMEMODE_MONOPOLIES/.test(byId('GameOption').unknown[0].why)
      && /main menu/.test(byId('GameOption').unknown[0].why),
      byId('GameOption').unknown[0].why);
    check('  and it is left undecided rather than guessed',
      byId('GameOption').willRun === null, String(byId('GameOption').willRun));
    {
      const av = lo.profileLoadOrder(DB_PATH, { file: OV_PATH, asserted: { 'GAMEMODE:GAMEMODE_MONOPOLIES': true } });
      const aById = (cid) => av.bands.flatMap((b) => b.actions || []).find((a) => a.id === cid);
      check('an asserted game option decides its row instead of leaving it undecided',
        aById('GameOption').willRun === true, JSON.stringify(aById('GameOption')));
      check('  and the row is flagged assumed, carrying no unknown',
        aById('GameOption').assumed === true && aById('GameOption').unknown.length === 0,
        JSON.stringify(aById('GameOption')));
      check('  and the summary counts the one assumed row and one fewer unknown',
        av.summary.assumed === 1 && av.summary.unknown === v.summary.unknown - 1,
        JSON.stringify(av.summary));
      check('  while a ruleset gate with no matching assertion stays undecided, naming it exactly once',
        aById('PatchOne').willRun === null && aById('PatchOne').unknown.length === 1
        && aById('PatchOne').assumed === false,
        JSON.stringify(aById('PatchOne')));
    }
    check('a ruleset condition names the ruleset, and says who picks it',
      /RULESET_EXPANSION_1/.test(byId('PatchOne').unknown[0].why)
      && /when you start a game/.test(byId('PatchOne').unknown[0].why),
      byId('PatchOne').unknown[0].why);
    check('  and cites the evidence rather than just asserting it',
      /no default value/.test(byId('PatchOne').unknown[0].why),
      'the game records RULESET with DefaultValue NULL, so there is no default to fall back on');

    check('  and no row is left undecided without saying what it could not decide',
      undecided.every((a) => a.unknown && a.unknown.length > 0),
      JSON.stringify(undecided.filter((a) => !a.unknown || !a.unknown.length).map((a) => a.id)));
    check('  and every unknown reason names the condition type that caused it',
      undecided.every((a) => a.unknown.every((u) => u.type && u.why)),
      JSON.stringify(undecided.flatMap((a) => a.unknown).filter((u) => !u.type || !u.why)));

    const m2row = modRowId(M2);
    check('a mod with no .modinfo on disk is reported not protected',
      staleOf(M2) === null && v.summary.unprotectable === 1, JSON.stringify(v.summary));

    check('another profile loads', small.ok === true && small.profile.name === 'Small', JSON.stringify(small.profile));
    check('  with only the mods it has on, which is two because mod 3 is on here and off in Main',
      small.summary.modsOn === 2, String(small.summary.modsOn));
    check('  and mod 3 is the difference between the two profiles',
      v.summary.modsOn === 2 && small.summary.modsOn === 2, `${v.summary.modsOn} / ${small.summary.modsOn}`);
    const cmp = lo.profileLoadOrder(DB_PATH, { file: OV_PATH, groupId: 1, compareGroupId: 2, asserted: {} });
    check('and the two can be compared', cmp.compare && cmp.compare.id === 2, JSON.stringify(cmp.compare));
    const marked = cmp.bands.flatMap((b) => b.actions || []).filter((a) => a.inCompare !== null);
    check('  marking every action as in or not in the other profile', marked.length > 0, String(marked.length));
    check('  and a mod off there is marked as such',
      marked.some((a) => a.modId === normId(M2) && a.inCompare === false));

    const k = keyOf('PatchOne');
    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: k, value: 777 }], { file: OV_PATH, statusFn: OPEN });
    const withOv = lo.profileLoadOrder(DB_PATH, { file: OV_PATH, asserted: {} });
    const row = withOv.bands.flatMap((b) => b.actions || []).find((a) => a.id === 'PatchOne');
    check('an override shows on its row, with the author value beside it',
      row.state === 'overridden' && row.override.declared !== null, JSON.stringify(row.override));
    check('  and the summary counts it', withOv.summary.overrides === 1, String(withOv.summary.overrides));

    const orphan = lo.readOverrides(OV_PATH).overrides;
    lo.writeOverrides(OV_PATH, { [normId(M1)]: { 'UpdateDatabase\nGone\nGone.sql': { value: 1 } } });
    const withOrphan = lo.profileLoadOrder(DB_PATH, { file: OV_PATH, asserted: {} });
    check('an override that no longer matches is listed, not hidden',
      withOrphan.unmatched.length === 1 && withOrphan.unmatched[0].state === 'orphaned', JSON.stringify(withOrphan.unmatched));
    check('  and the row it belonged to no longer claims to be overridden',
      (withOrphan.bands.flatMap((b) => b.actions || []).find((a) => a.id === 'PatchOne') || {}).state !== 'overridden');
    lo.writeOverrides(OV_PATH, orphan);

    const list = lo.listOverrides(DB_PATH, { file: OV_PATH });
    check('the overrides screen lists them with a resolved state',
      list.ok === true && list.count >= 1 && list.overrides[0].state === 'applied', JSON.stringify(list.overrides[0] && list.overrides[0].state));
    check('  and the key it names is readable rather than a hash',
      String(list.overrides[0].key).includes('\n') && list.overrides[0].type === 'UpdateDatabase',
      JSON.stringify(list.overrides[0].key));
  });

  // ---- Test 15 ----

  await asuite('Test 15: the view is read-only', async () => {
    const srv = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
    const routesAt = srv.indexOf('const ROUTES = [');
    const routesText = routesAt === -1 ? '' : srv.slice(routesAt, srv.indexOf('\n];', routesAt) + 3);
    const hasRoute = (method, p) => new RegExp(`\\{ method: '${method}', match: '${p}'`).test(routesText);
    const view = fs.readFileSync(path.join(PUBLIC, 'loadorder.js'), 'utf8');
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

    check('the view route is a GET', hasRoute('GET', '/api/load-order'));
    check('  and no POST writes to it', !hasRoute('POST', '/api/load-order'));
    const loadWrites = (routesText.match(/match: '\/api\/load-overrides[^']*'/g) || []).length;
    check('every write route is under /api/load-overrides, and there are at least five of them',
      loadWrites >= 5, String(loadWrites));
    check('the view page has no button that posts anything', !/postJson|\bfetch\(|<form/.test(view));
    const section = (html.split('id="page-load-order"')[1] || '').split('id="page-load-overrides"')[0];
    const inputs = (section.match(/<input[^>]*>/g) || []);
    check('  and the only input on it is the text filter',
      inputs.length === 1 && /type="search"/.test(inputs[0]), inputs.join(' '));
    check('  and no number input, which is what a value control would be',
      !/type="number"/.test(section));
    check('  and no form to submit one', !/<form/.test(section));
    check('the manage button navigates instead', /location.hash = '#\/load-overrides'/.test(view));
    check('and the two are different page sections',
      /id="page-load-order"/.test(html) && /id="page-load-overrides"/.test(html));
  });

  // ---- Test 16 ----

  await asuite('Test 16: block-move proposal and bulk apply (load-order-edit 2.3)', async () => {
    const d0 = db();
    const crTwo = crOfIn(d0, 'PatchTwo');
    const crNoPos = crOfIn(d0, 'NoPosition');
    const crLonely = firstCrIn(d0, 'Lonely');
    d0.close();
    const w0 = new DatabaseSync(DB_PATH);
    const pair = w0.prepare("SELECT ComponentRowId AS cr FROM Components WHERE ComponentId = 'NewAction' ORDER BY ComponentRowId").all();
    w0.prepare("UPDATE ComponentProperties SET Value = '500' WHERE ComponentRowId = ? AND Name = 'LoadOrder'").run(pair[0].cr);
    w0.prepare("UPDATE ComponentProperties SET Value = '600' WHERE ComponentRowId = ? AND Name = 'LoadOrder'").run(pair[1].cr);
    w0.prepare("DELETE FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'").run(crTwo);
    w0.prepare("DELETE FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'").run(crLonely);
    w0.prepare("INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, 'LoadingOrder', '450')").run(crNoPos);
    w0.close();

    const OTHER = 'dddddddd-4444-4444-8444-444444444444';
    const bands = [
      { kind: 'value', value: 1000, actions: [{ modId: OTHER, modName: 'Other' }] },
      { kind: 'value', value: 1010, actions: [{ modId: OTHER, modName: 'Other' }] },
      { kind: 'free', from: 1011, to: 1200, count: 190 },
      { kind: 'value', value: 5000, actions: [{ modId: OTHER, modName: 'Other' }] },
      { kind: 'headroom', from: 5001, to: null, count: null },
    ];

    const dd = db();
    const block = lo.describeBlock(dd, M2);
    const block1 = lo.describeBlock(dd, M1);
    dd.close();
    eq('the block counts positioned actions only', block.count, 2);
    eq('  min', block.min, 500);
    eq('  max', block.max, 600);
    eq('  width', block.width, 100);
    check('  no tie in the pair', block.tie === false);
    eq('  undeclared counted aside', block.undeclaredCount, 1);
    check('  and excluded from the move list',
      block.actions.every((a) => a.componentRowId !== crLonely));
    check('  offsets measured from min',
      block.actions[0].offset === 0 && block.actions[1].offset === 100);
    check('  an off-disk mod is marked unprotectable, like the base/DLC rows',
      block.protectable === false);
    check('a typo-only action reads LaodOrder as its position',
      block1.actions.some((a) => a.componentRowId === crTwo && a.effective === 200 && a.misspelled === 'LaodOrder'),
      JSON.stringify(block1.actions.filter((a) => a.componentRowId === crTwo)));
    check('  and LoadingOrder, the second spelling, reads the same way',
      block1.actions.some((a) => a.componentRowId === crNoPos && a.effective === 450 && a.misspelled === 'LoadingOrder'));

    const kTwo = keyOf('PatchTwo');
    const dd2 = db();
    const res2 = lo.resolveAction(dd2, M1, kTwo);
    dd2.close();
    check('  and still resolves by content key, spelling not being identity',
      res2.state === lo.FIND && res2.componentRowId === crTwo);

    const d1 = db();
    const fit = lo.proposeBlock(d1, M2, { gap: { from: 1011, to: 1200 } }, { bands });
    const nofit = lo.proposeBlock(d1, M2, { gap: { from: 1011, to: 1050 } }, { bands });
    d1.close();
    check('a width-100 block fits a 190-wide gap', fit.fits === true,
      JSON.stringify({ fits: fit.fits, need: fit.need, gap: fit.gap }));
    eq('  need is the width', fit.need, 100);
    eq('  gap is the free run', fit.gap, 190);
    eq('  first lands on the base', fit.mapping[0].to, 1011);
    eq('  second keeps its offset: new = base + offset', fit.mapping[1].to, 1111);
    check('  order unchanged',
      fit.mapping[0].from < fit.mapping[1].from && fit.mapping[0].to < fit.mapping[1].to);
    check('  undeclared actions are never proposed a value',
      fit.mapping.every((m) => m.componentRowId !== crLonely));
    check('  the off-disk block warns unprotectable rather than claiming safety',
      fit.warnings.some((w) => w.kind === 'unprotectable'));

    check('a width-100 block does not fit a 40-wide gap', nofit.fits === false);
    eq('  need states the width', nofit.need, 100);
    eq('  gap states the free run', nofit.gap, 40);
    check('  the three no-fit paths are offered and nothing is proposed',
      JSON.stringify(nofit.options) === '["even","overflow","manual"]' && nofit.mapping.length === 0,
      JSON.stringify(nofit.options));

    const even = lo.buildEvenSpacing(block, bands, { from: 1011, to: 1050 });
    check('even re-space distributes order-preserving inside the gap',
      even.strategy === 'even'
      && even.mapping.find((m) => m.from === 500).to === 1011
      && even.mapping.find((m) => m.from === 600).to === 1050,
      JSON.stringify(even.mapping));
    const under = lo.buildOverflow(block, bands);
    check('spill-below ends at the global min minus one',
      under.base === 899 && under.direction === 'below'
      && under.mapping.find((m) => m.from === 600).to === 999,
      JSON.stringify(under.mapping));
    check('  and a directional call is refused, spill being below-only',
      fails(() => lo.buildOverflow(block, bands, 'below'))
      && fails(() => lo.buildOverflow(block, bands, 'above')));
    const manUn = lo.buildManual(block, bands, { [crLonely]: 1100 });
    check('only manual may place an undeclared action, and only when picked',
      manUn.mapping.length === 1 && manUn.mapping[0].from === null && manUn.mapping[0].to === 1100);

    const manSent = lo.buildManual(block1, bands, { [crTwo]: 10000001 });
    check('a sentinel value maps, with a load-last warning rather than a refusal',
      manSent.mapping.length === 1 && manSent.invalid.length === 0
      && manSent.warnings.some((w) => w.kind === 'sentinel'),
      JSON.stringify(manSent.warnings.map((w) => w.kind)));
    check('  and the misspelling is warned, not blocking',
      manSent.warnings.some((w) => w.kind === 'misspelling'));
    const manTie = lo.buildManual(block1, bands, { [crTwo]: 1000 });
    check('landing on an occupied value warns of a tie the game picks arbitrarily',
      manTie.warnings.some((w) => w.kind === 'tie' && /arbitrarily/.test(w.message)),
      JSON.stringify(manTie.warnings));
  });

  // ---- Test 16b (same record scope as the source: parity + bulk sections) ----

  await asuite('Test 16b: client/server preview parity', async () => {
    const d0 = db();
    const crTwo = crOfIn(d0, 'PatchTwo');
    const crLonely = firstCrIn(d0, 'Lonely');
    d0.close();
    const dd = db();
    const block = lo.describeBlock(dd, M2);
    const block1 = lo.describeBlock(dd, M1);
    dd.close();
    const OTHER = 'dddddddd-4444-4444-8444-444444444444';
    const bands = [
      { kind: 'value', value: 1000, actions: [{ modId: OTHER, modName: 'Other' }] },
      { kind: 'value', value: 1010, actions: [{ modId: OTHER, modName: 'Other' }] },
      { kind: 'free', from: 1011, to: 1200, count: 190 },
      { kind: 'value', value: 5000, actions: [{ modId: OTHER, modName: 'Other' }] },
      { kind: 'headroom', from: 5001, to: null, count: null },
    ];
    const d1 = db();
    const fit = lo.proposeBlock(d1, M2, { gap: { from: 1011, to: 1200 } }, { bands });
    d1.close();
    const even = lo.buildEvenSpacing(block, bands, { from: 1011, to: 1050 });
    const under = lo.buildOverflow(block, bands);

    const clientSrc = fs.readFileSync(path.join(PUBLIC, 'looverrides.js'), 'utf8');
    let cxP = null;
    let clientErr = '';
    try {
      cxP = vm.createContext({ $: () => ({ addEventListener() {} }), pages: {}, n: (x) => String(x) });
      vm.runInContext(clientSrc, cxP, { filename: 'looverrides.js' });
    } catch (e) { clientErr = e.message; }
    check('the client preview source loads headless under stubs', cxP !== null, clientErr);
    const cRows = block.actions.map((a) => ({ componentRowId: a.componentRowId, effective: a.effective }));
    const cMod = { min: block.min, max: block.max, width: block.width };
    const sameMap = (a, b) => a.length === b.length
      && a.every((m, i) => m.componentRowId === b[i].componentRowId && m.from === b[i].from && m.to === b[i].to);
    const clientMap = (mode, base, gap) => JSON.parse(vm.runInContext(
      `JSON.stringify(lovEditBuildMapping(${JSON.stringify(cRows)}, ${JSON.stringify(cMod)}, ${JSON.stringify(mode)}, ${JSON.stringify(base)}, ${JSON.stringify(gap)}))`, cxP))
      .map((r) => ({ componentRowId: r.action.componentRowId, from: r.old, to: r.proposed }));
    if (cxP) {
      check('fit preview matches the server proposal identically',
        sameMap(clientMap('fit', 1011, { from: 1011, to: 1200, count: 190 }), fit.mapping),
        JSON.stringify(clientMap('fit', 1011, { from: 1011, to: 1200, count: 190 })));
      check('even re-space preview matches the server builder',
        sameMap(clientMap('even', 1011, { from: 1011, to: 1050, count: 40 }), even.mapping),
        JSON.stringify(clientMap('even', 1011, { from: 1011, to: 1050, count: 40 })));
      vm.runInContext(`lov.bands = { ok: true, bands: ${JSON.stringify(bands)} }`, cxP);
      check('spill-below preview matches the server builder',
        sameMap(clientMap('overflow-below', null, null), under.mapping), `base ${under.base}`);
      check('  and no spill-above path remains on the client',
        vm.runInContext('lovEditBuildMapping([], { min: 0, width: 0 }, \'overflow-above\', 0, null)', cxP) === null
        && !/overflow-above/.test(clientSrc));
      const dB = db();
      const srvFit = lo.proposeBlock(dB, M2, { before: 5000 }, { bands });
      const srvClash = lo.proposeBlock(dB, M2, { before: 1060 }, { bands });
      const srvEdge = lo.proposeBlock(dB, M2, { before: 1111 }, { bands });
      dB.close();
      const cModR = { width: block.width, rows: block.actions.map((a) => ({ componentRowId: a.componentRowId })) };
      const cBefore = (V) => {
        vm.runInContext(`lov.targetMode = 'before-value'; lov.anchorValue = '${V}';`, cxP);
        return JSON.parse(vm.runInContext(`JSON.stringify(lovEditResolveTarget(${JSON.stringify(cModR)}))`, cxP));
      };
      const rFit = cBefore(5000);
      check('before-anchor fit ends snug below the anchor, like the server',
        rFit.base === 4899 && rFit.base === srvFit.base
        && sameMap(clientMap('fit', rFit.base, rFit.gap), srvFit.mapping),
        JSON.stringify({ base: rFit.base, server: srvFit.base }));
      check('  and reports the same free run below the anchor',
        rFit.gap && rFit.gap.count === srvFit.gap, JSON.stringify(rFit.gap));
      const rClash = cBefore(1060);
      check('before-anchor clash is no-fit on both sides, never a far jump',
        srvClash.fits === false && (cMod.width > rClash.gap.count || rClash.clash === true)
        && JSON.stringify(srvClash.options) === '["even","overflow","manual"]',
        JSON.stringify({ gap: rClash.gap, clash: rClash.clash }));
      const rEdge = cBefore(1111);
      check('  even when the free run is exactly as wide as the block',
        srvEdge.fits === false && rEdge.clash === true && !(cMod.width <= rEdge.gap.count && !rEdge.clash),
        JSON.stringify({ gap: rEdge.gap, clash: rEdge.clash }));
      const kindOf = (s) => (/tie at/.test(s) ? 'tie' : /sentinel/.test(s) ? 'sentinel'
        : /drifted/.test(s) ? 'drifted' : /misspell/.test(s) ? 'misspelling'
        : /unprotectable/.test(s) ? 'unprotectable' : s);
      const wRow = (cr, eff) => ({ componentRowId: cr, effective: eff, modId: M2, protected: false });
      const p0cr = (() => {
        const d = db();
        try { return d.prepare("SELECT ComponentRowId AS cr FROM Components WHERE ComponentId = 'NewAction' ORDER BY ComponentRowId").all()[0].cr; }
        finally { d.close(); }
      })();
      const cKinds = (to) => JSON.parse(vm.runInContext(
        `JSON.stringify(lovEditWarningsFor(${JSON.stringify([{ action: wRow(p0cr, 500), old: 500, proposed: to }])}))`, cxP))
        .map(kindOf).sort();
      const sKinds = (to) => lo.buildManual(block, bands, { [p0cr]: to }).warnings.map((w) => w.kind).sort();
      check('tie warning kinds match between preview and server',
        JSON.stringify(cKinds(1000)) === JSON.stringify(sKinds(1000)), JSON.stringify(cKinds(1000)));
      check('sentinel warning kinds match between preview and server',
        JSON.stringify(cKinds(10000001)) === JSON.stringify(sKinds(10000001)), JSON.stringify(cKinds(10000001)));
      check('client manual entry is DOM-bound, recorded rather than faked',
        /function lovEditReadManual[\s\S]{0,400}querySelector/.test(clientSrc));
      const manVals = {};
      {
        const d = db();
        try {
          const prs = d.prepare("SELECT ComponentRowId AS cr FROM Components WHERE ComponentId = 'NewAction' ORDER BY ComponentRowId").all();
          manVals[prs[0].cr] = 1050; manVals[prs[1].cr] = 1060;
        } finally { d.close(); }
      }
      const manTwice = lo.buildManual(block, bands, manVals);
      const manHand = Object.entries(manVals).map(([k, v]) => {
        const a = block.actions.find((x) => x.componentRowId === Number(k));
        return { componentRowId: Number(k), from: a.effective, to: v };
      }).sort((a, b) => a.componentRowId - b.componentRowId);
      check('manual mapping asserted twice via independent construction',
        sameMap(manTwice.mapping, manHand) && manTwice.invalid.length === 0,
        JSON.stringify(manTwice.mapping));
    }
    if (!cxP) {
      const handFit = [...block.actions].sort((a, b) => a.effective - b.effective)
        .map((a) => ({ componentRowId: a.componentRowId, from: a.effective, to: 1011 + a.offset }));
      check('client would not load headless - server fit re-derived by hand instead',
        sameMap(fit.mapping, handFit), clientErr);
    }

    check('bulk apply exists', typeof lo.applyBulk === 'function');
    if (typeof lo.applyBulk === 'function') {
      try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
      const beforeBulk = newestBackup();
      let bmsg = '';
      try {
        await lo.applyBulk(DB_PATH, [{ modId: M1, componentRowId: crTwo, value: 7000 }],
          { file: OV_PATH, statusFn: RUNNING });
      } catch (e) { bmsg = e.message; }
      check('bulk refuses while Civilization VI is running', /close Civilization VI/.test(bmsg), bmsg);
      check('  and wrote nothing: no LoadOrder row created',
        dbValue(crTwo) === null);
      const dT = db();
      const typoRow = dT.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LaodOrder'").get(crTwo);
      dT.close();
      check('  the typo row untouched', !!typoRow && String(typoRow.v) === '200', JSON.stringify(typoRow));
      check('  and took no backup', newestBackup() === beforeBulk);
      check('  and stored no intent', lo.readOverrides(OV_PATH).count === 0);

      const kOne = keyOf('PatchOne');
      const kLonely = (() => { const d = db(); try { return lo.actionKey(d, crLonely); } finally { d.close(); } })();
      const r = await lo.applyBulk(DB_PATH, [
        { modId: M1, key: kOne, value: 4242 },
        { modId: M1, componentRowId: crTwo, value: 10000001 },
        { modId: M2, key: kLonely, value: 999 },
      ], { file: OV_PATH, statusFn: OPEN });
      check('bulk lands every entry in one call', r.applied.length === 3,
        `applied ${r.applied.length}`);
      check('  the typo action takes the value on a correctly spelled row',
        dbValue(crTwo) === '10000001');
      const dT2 = db();
      const typoRow2 = dT2.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LaodOrder'").get(crTwo);
      dT2.close();
      check("  leaving the mod's own misspelled row untouched",
        !!typoRow2 && String(typoRow2.v) === '200', JSON.stringify(typoRow2));
      check("  the author's typo value is recorded, so reset is possible",
        stored(M1, keyOf('PatchTwo')) && stored(M1, keyOf('PatchTwo')).declared === 200, JSON.stringify(stored(M1, keyOf('PatchTwo'))));
      check('  a sentinel is applied and reported, never refused',
        r.sentinels.length === 1 && r.sentinels[0].value === 10000001, JSON.stringify(r.sentinels));
      check('  an off-disk row is reported unprotectable rather than treated as safe',
        r.unprotectable.includes(normId(M2)), JSON.stringify(r.unprotectable));
      check('  and a backup exists and is a real file',
        typeof r.backupPath === 'string' && fs.existsSync(r.backupPath) && fs.statSync(r.backupPath).size > 0,
        String(r.backupPath));
      {
        const b = new DatabaseSync(r.backupPath, { readOnly: true });
        const pre = b.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'");
        const vals = [pre.get(crOf('PatchOne')), pre.get(crTwo)].map((x) => (x ? x.v : null));
        b.close();
        check('  the backup is a pre-image of the whole batch, so the write was one transaction',
          !vals.includes('4242') && !vals.includes('10000001'), JSON.stringify(vals));
      }

      const bad = await lo.applyBulk(DB_PATH, [
        { modId: M1, key: 'UpdateDatabase\nnope\nno.sql', value: 1 },
        { modId: M1, componentRowId: 999999999, value: 2 },
      ], { file: OV_PATH, statusFn: OPEN });
      check('bulk reports stale keys as orphaned and writes nothing',
        bad.applied.length === 0 && bad.orphans.length === 2,
        `applied ${bad.applied.length} orphans ${bad.orphans.length}`);
      check('  and stores nothing for them', lo.readOverrides(OV_PATH).count === 3,
        String(lo.readOverrides(OV_PATH).count));

      {
        const beforeLimit = newestBackup();
        const valueBefore = dbValue(crOf('PatchOne'));
        const countBefore = lo.readOverrides(OV_PATH).count;
        const huge = Array.from({ length: 1001 }, () => ({ modId: M1, key: kOne, value: 1 }));
        let lmsg = '';
        try {
          await lo.applyBulk(DB_PATH, huge, { file: OV_PATH, statusFn: OPEN });
        } catch (e) { lmsg = e.message; }
        check('bulk refuses an oversized batch', /limit 1000/.test(lmsg), lmsg);
        check('  and wrote nothing', dbValue(crOf('PatchOne')) === valueBefore,
          `${valueBefore} vs ${dbValue(crOf('PatchOne'))}`);
        check('  and took no backup', newestBackup() === beforeLimit,
          `${newestBackup()} vs ${beforeLimit}`);
        check('  and stored no intent', lo.readOverrides(OV_PATH).count === countBefore,
          String(lo.readOverrides(OV_PATH).count));
      }
    }
  });
  // ---- Test 16c ----

  await asuite('Test 16c: the bulk route over HTTP', async () => {
    const postJson = (port, p, body) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body == null ? {} : body);
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    const freePort = () => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => resolve(a.port)); });
    });
    const waitUp = async (port, child) => {
      const t0 = Date.now();
      for (;;) {
        if (child.exitCode != null) throw new Error(`scratch server exited early (${child.exitCode})`);
        try {
          const r = await postJson(port, '/api/ping', {});
          if (r.status === 200 && r.body && r.body.ok) return;
        } catch (_) { /* not yet */ }
        if (Date.now() - t0 > 20000) throw new Error('scratch server never came up');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const boxDb = path.join(TMP, 'http-copy.sqlite');
    fs.copyFileSync(DB_PATH, boxDb);
    const boxOv = path.join(TMP, 'http-overrides.json');
    try { fs.unlinkSync(boxOv); } catch (_) { /* fresh */ }
    for (const d of ['http-mods', 'http-ws', 'http-saves'].map((x) => path.join(TMP, x))) {
      fs.mkdirSync(d, { recursive: true });
    }
    const runBox = async (modsDb) => {
      const port = await freePort();
      const child = spawn(process.execPath, [path.join(SRC, 'server.js')], {
        env: { ...process.env, CIV6_PATHS_FILE: path.join(TMP, 'no-such-paths.json'),
          CIV6_LOCAL_MODS: path.join(TMP, 'http-mods'), CIV6_WORKSHOP: path.join(TMP, 'http-ws'),
          CIV6_SAVES: path.join(TMP, 'http-saves'), CIV6_MODS_DB: modsDb,
          CIV6_LABELS_FILE: path.join(TMP, 'http-labels.json'), CIV6_LOADORDER_FILE: boxOv,
          PORT: String(port), NO_OPEN: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitUp(port, child);
      return { port, stop: async () => {
        if (child.exitCode == null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
      } };
    };
    {
      const s = await runBox(path.join(TMP, 'no-such-db.sqlite'));
      try {
        const r = await postJson(s.port, '/api/load-overrides/bulk', { entries: [{ modId: M1, key: 'k', value: 1 }] });
        check('bulk with no database is a 400', r.status === 400 && /Mod database not found/.test(r.body.error),
          `${r.status} ${r.body && r.body.error}`);
      } finally { await s.stop(); }
    }
    {
      const s = await runBox(boxDb);
      try {
        let r = await postJson(s.port, '/api/load-overrides/bulk', {});
        check('bulk with no entries is a 400', r.status === 400 && /no overrides/.test(r.body.error),
          `${r.status} ${r.body && r.body.error}`);
        r = await postJson(s.port, '/api/load-overrides/bulk', { entries: [] });
        check('bulk with an empty list is a 400', r.status === 400, String(r.status));
        r = await postJson(s.port, '/api/load-overrides/bulk', { entries: [{ modId: 'nope', key: 'k', value: 1 }] });
        check('bulk with a bad mod id is a 400', r.status === 400, `${r.status} ${r.body && r.body.error}`);
        r = await postJson(s.port, '/api/load-overrides/bulk', { entries: [{ modId: M1, key: 'k', value: 1.5 }] });
        check('bulk with a fractional value is a 400', r.status === 400, `${r.status} ${r.body && r.body.error}`);
        const kHttp = keyOf('Strings');
        r = await postJson(s.port, '/api/load-overrides/bulk', { entries: [{ modId: M1, key: kHttp, value: 5555 }] });
        check('bulk with one good entry is a 200 with one applied',
          r.status === 200 && r.body.applied.length === 1, `${r.status} applied=${r.body.applied && r.body.applied.length}`);
        const vd = new DatabaseSync(boxDb, { readOnly: true });
        const got = vd.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'")
          .get(crOf('Strings'));
        vd.close();
        check('  the value landed in the scratch copy', got && String(got.v) === '5555', JSON.stringify(got));
        check('  and the intent reached the scratch overrides file',
          JSON.parse(fs.readFileSync(boxOv, 'utf8')).overrides[normId(M1)][kHttp].value === 5555);
        r = await postJson(s.port, '/api/load-overrides', { modId: M1, key: kHttp, value: 5556 });
        check('single apply still answers 200, unchanged', r.status === 200 && r.body.applied.length === 1, String(r.status));
        r = await postJson(s.port, '/api/load-overrides/sync', {});
        check('sync still answers 200, unchanged', r.status === 200, String(r.status));
        const srvSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
        const routesAt = srvSrc.indexOf('const ROUTES = [');
        const routesText = routesAt === -1 ? '' : srvSrc.slice(routesAt, srvSrc.indexOf('\n];', routesAt) + 3);
        const handlerSrc = (name) => {
          const at = srvSrc.indexOf(`async function ${name}(`);
          if (at === -1) return '';
          const end = srvSrc.indexOf('\n}', at);
          return end === -1 ? '' : srvSrc.slice(at, end + 2);
        };
        const routeHandler = (method, p) => {
          const m = new RegExp(`\\{ method: '${method}', match: '${p}'[^}]*?handler: (\\w+)`).exec(routesText);
          return m ? handlerSrc(m[1]) : '';
        };
        const bulkBranch = routeHandler('POST', '/api/load-overrides/bulk');
        check('the bulk branch awaits the game guard and maps it to 409',
          /await gameStatus\(\)/.test(bulkBranch) && /409/.test(bulkBranch) && /close Civilization VI first/.test(bulkBranch));
        check('  and delegates the write to applyBulk', /loOrder\.applyBulk/.test(bulkBranch));
        check('  and reset/discard routes are still present',
          /match: '\/api\/load-overrides\/reset'/.test(routesText) && /match: '\/api\/load-overrides\/discard'/.test(routesText));
      } finally { await s.stop(); }
    }
  });

  // ---- Test 18 ----

  await asuite('Test 18: action file lists (view tab + override editor tab)', async () => {
    const wAf = new DatabaseSync(DB_PATH);
    const m1rowAf = wAf.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(M1).ModRowId;
    const multiAf = wAf.prepare('INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, ?)')
      .run(m1rowAf, 'MultiFile', 'UpdateDatabase').lastInsertRowid;
    wAf.prepare("INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, 'LoadOrder', '6100')").run(multiAf);
    for (const f of ['Patches/Alpha.sql', 'Patches/Beta.sql', 'Text\\Gamma.xml']) {
      let row = wAf.prepare('SELECT FileRowId FROM ModFiles WHERE ModRowId = ? AND Path = ?').get(m1rowAf, f);
      if (!row) row = { FileRowId: wAf.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(m1rowAf, f).lastInsertRowid };
      wAf.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId, Priority) VALUES (?, ?, 0)').run(multiAf, row.FileRowId);
    }
    wAf.close();

    const dAf = db();
    check('one action resolves to its basenames, sorted',
      JSON.stringify(lo.actionFiles(dAf, multiAf)) === JSON.stringify(['Alpha.sql', 'Beta.sql', 'Gamma.xml']),
      JSON.stringify(lo.actionFiles(dAf, multiAf)));
    check('a single-file action answers one basename',
      JSON.stringify(lo.actionFiles(dAf, crOf('PatchOne'))) === JSON.stringify(['One.sql']),
      JSON.stringify(lo.actionFiles(dAf, crOf('PatchOne'))));
    check('an unknown row id answers null, so the route can 404', lo.actionFiles(dAf, 999999999) === null);
    dAf.close();

    const batchAf = lo.modActionFilesOf(DB_PATH, M1);
    check('the batch names the mod and every action',
      batchAf.modId === normId(M1) && batchAf.actions.length > 0, `actions=${batchAf.actions.length}`);
    const bmAf = batchAf.actions.find((a) => a.componentRowId === multiAf);
    check('  with the multi-file action carrying three basenames',
      !!bmAf && bmAf.files.length === 3, JSON.stringify(bmAf && bmAf.files));
    check('  and no path segment anywhere in the batch',
      batchAf.actions.every((a) => a.files.every((f) => !/[/\\]/.test(f))));
    check('a malformed row id is refused', fails(() => lo.actionFilesOf(DB_PATH, 'abc')));
    let af404 = '';
    try { lo.actionFilesOf(DB_PATH, 999999999); } catch (e) { af404 = e.code; }
    check('an unknown row id carries NOT_FOUND for the route 404', af404 === 'NOT_FOUND', af404);
    let afMod400 = '';
    try { lo.modActionFilesOf(DB_PATH, 'nope'); } catch (e) { afMod400 = e.code || e.message; }
    check('a malformed mod id is a plain error, not NOT_FOUND', afMod400 !== 'NOT_FOUND', afMod400);
    let afMod404 = '';
    try { lo.modActionFilesOf(DB_PATH, 'dddddddd-4444-4444-8444-444444444444'); } catch (e) { afMod404 = e.code; }
    check('an unknown mod id carries NOT_FOUND', afMod404 === 'NOT_FOUND', afMod404);

    const pvAf = lo.profileLoadOrder(DB_PATH, { file: OV_PATH });
    check('list payloads carry no per-action file joins',
      pvAf.bands.flatMap((b) => b.actions || []).every((a) => !('files' in a)));
    const escAf = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const stubAf = { $: () => ({ addEventListener() {} }), pages: {},
      n: (x) => String(x), esc: escAf, renderCivText: (s) => String(s),
      stripCivText: (s) => String(s), window: {} };
    let viewCxAf = null; let viewErrAf = '';
    try {
      viewCxAf = vm.createContext({ ...stubAf });
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'loadorder.js'), 'utf8'),
        viewCxAf, { filename: 'loadorder.js' });
    } catch (e) { viewErrAf = e.message; }
    check('the view script loads headless under stubs', viewCxAf !== null, viewErrAf);
    if (viewCxAf) {
      const hAf = vm.runInContext("loFilesHtml(['Data.sql','Text.xml','Icons.dds'], false, 7)", viewCxAf);
      check('a multi-file action renders two basenames plus +N more',
        /Data\.sql/.test(hAf) && /Text\.xml/.test(hAf) && /\+1 more/.test(hAf) && !/Icons\.dds/.test(hAf), hAf);
      const oAf = vm.runInContext("loFilesHtml(['Data.sql','Text.xml','Icons.dds'], true, 7)", viewCxAf);
      check('  expand reveals the rest', /Icons\.dds/.test(oAf) && !/more/.test(oAf), oAf);
      const nAf = vm.runInContext('loFilesHtml([], false, 7)', viewCxAf);
      check('  an action with no files says so', /no files/.test(nAf), nAf);
      const xAf = vm.runInContext("loFilesHtml(['<b>.sql'], false, 7)", viewCxAf);
      check('  markup in a name is escaped, never literal', /&lt;b&gt;\.sql/.test(xAf) && !/<b>/.test(xAf), xAf);
    }
    let edCxAf = null; let edErrAf = '';
    try {
      edCxAf = vm.createContext({ ...stubAf });
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'looverrides.js'), 'utf8'),
        edCxAf, { filename: 'looverrides.js' });
    } catch (e) { edErrAf = e.message; }
    check('the editor script loads headless under stubs', edCxAf !== null, edErrAf);
    if (edCxAf) {
      const hAf = vm.runInContext("lovEditFilesHtml(['Data.sql','Text.xml','Icons.dds'], false, 7)", edCxAf);
      check('the picker renders two basenames plus +N more',
        /Data\.sql/.test(hAf) && /\+1 more/.test(hAf) && !/Icons\.dds/.test(hAf), hAf);
      const oAf = vm.runInContext("lovEditFilesHtml(['Data.sql','Text.xml','Icons.dds'], true, 7)", edCxAf);
      check('  and its expand reveals the rest', /Icons\.dds/.test(oAf), oAf);
      const nAf = vm.runInContext('lovEditFilesHtml([], false, 7)', edCxAf);
      check('  and its no-file action says so', /no files/.test(nAf), nAf);
    }
    const afGet = (port, p) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, agent: false }, (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
      });
      req.on('error', reject);
      req.end();
    });
    const afPort = () => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => resolve(a.port)); });
    });
    const afUp = async (port, child) => {
      const t0 = Date.now();
      for (;;) {
        if (child.exitCode != null) throw new Error(`scratch server exited early (${child.exitCode})`);
        try {
          const r = await afGet(port, '/api/game');
          if (r.status === 200) return;
        } catch (_) { /* not yet */ }
        if (Date.now() - t0 > 20000) throw new Error('scratch server never came up');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const afDb = path.join(TMP, 'af-copy.sqlite');
    fs.copyFileSync(DB_PATH, afDb);
    const bxAf = new DatabaseSync(afDb, { readOnly: true });
    const bxCrAf = bxAf.prepare("SELECT ComponentRowId AS c FROM Components WHERE ComponentId = 'Strings'").get().c;
    bxAf.close();
    const afPortN = await afPort();
    const afChild = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: { ...process.env, CIV6_PATHS_FILE: path.join(TMP, 'no-such-paths.json'),
        CIV6_LOCAL_MODS: path.join(TMP, 'http-mods'), CIV6_WORKSHOP: path.join(TMP, 'http-ws'),
        CIV6_SAVES: path.join(TMP, 'http-saves'), CIV6_MODS_DB: afDb,
        CIV6_LABELS_FILE: path.join(TMP, 'http-labels.json'),
        CIV6_LOADORDER_FILE: path.join(TMP, 'af-overrides.json'),
        PORT: String(afPortN), NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await afUp(afPortN, afChild);
    try {
      let r = await afGet(afPortN, '/api/action-files?componentRowId=abc');
      check('a malformed row id is a 400', r.status === 400, `${r.status} ${r.body && r.body.error}`);
      r = await afGet(afPortN, '/api/action-files?componentRowId=999999999');
      check('an unknown row id is a 404', r.status === 404, `${r.status} ${r.body && r.body.error}`);
      r = await afGet(afPortN, `/api/action-files?componentRowId=${bxCrAf}`);
      check('a known action answers 200 with basenames only',
        r.status === 200 && r.body.componentRowId === bxCrAf && Array.isArray(r.body.files)
        && r.body.files.every((f) => !/[/\\]/.test(f)), `${r.status} ${JSON.stringify(r.body)}`);
      r = await afGet(afPortN, '/api/action-files');
      check('naming neither action nor mod is a 400', r.status === 400, String(r.status));
      r = await afGet(afPortN, '/api/action-files?modId=nope');
      check('a malformed mod id is a 400', r.status === 400, `${r.status} ${r.body && r.body.error}`);
      r = await afGet(afPortN, '/api/action-files?modId=dddddddd-4444-4444-8444-444444444444');
      check('an unknown mod id is a 404', r.status === 404, `${r.status} ${r.body && r.body.error}`);
      r = await afGet(afPortN, `/api/action-files?modId=${M1}`);
      check('a known mod answers one batch with basenames only',
        r.status === 200 && r.body.modId === normId(M1) && Array.isArray(r.body.actions)
        && r.body.actions.length > 0 && r.body.actions.every((a) => Number.isInteger(a.componentRowId)
          && a.files.every((f) => !/[/\\]/.test(f))),
        `${r.status} actions=${r.body.actions && r.body.actions.length}`);
    } finally {
      if (afChild.exitCode == null) { afChild.kill(); await new Promise((res2) => afChild.once('exit', res2)); }
    }
  });

  // ---- Test 19 ----

  await asuite('Test 19: per-mod reset-all + discard-all (ledger bulk actions)', async () => {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* fresh */ }
    const kOne19 = keyOf('PatchOne');
    const kStr19 = keyOf('Strings');
    const crOne19 = crOf('PatchOne');
    const crStr19 = crOf('Strings');
    const beforeOne19 = dbValue(crOne19);
    const beforeStr19 = dbValue(crStr19);

    const vOne19 = (Number(beforeOne19) || 0) + 1111;
    const vStr19 = (Number(beforeStr19) || 0) + 2222;
    await lo.applyOverrides(DB_PATH, [
      { modId: M1, key: kOne19, value: vOne19 },
      { modId: M1, key: kStr19, value: vStr19 },
    ], { file: OV_PATH, statusFn: OPEN });
    check('two overrides stored for one mod', lo.readOverrides(OV_PATH).count === 2,
      `count=${lo.readOverrides(OV_PATH).count}`);
    check('  both landed in the scratch copy', dbValue(crOne19) === String(vOne19) && dbValue(crStr19) === String(vStr19));

    const list19 = lo.listOverrides(DB_PATH, { file: OV_PATH });
    const rowOne19 = list19.overrides.find((o) => o.key === kOne19);
    check('a resolved ledger row names its action row',
      !!rowOne19 && Number.isInteger(rowOne19.componentRowId));
    const d19 = db();
    const filesOne19 = lo.actionFiles(d19, rowOne19.componentRowId);
    d19.close();
    check('  and that row resolves to basenames only, never raw paths',
      Array.isArray(filesOne19) && filesOne19.length > 0 && filesOne19.every((f) => !/[/\\]/.test(f)),
      JSON.stringify(filesOne19));
    const lovSrc19 = fs.readFileSync(path.join(PUBLIC, 'looverrides.js'), 'utf8');
    check('  the ledger renders those basenames from the shared cache',
      /function lovLedgerFilesSlot/.test(lovSrc19) && /lov\.fileCache/.test(lovSrc19) && /o\.componentRowId/.test(lovSrc19));
    check('  via esc, never a raw path', /lovEditFilesHtml\(hit/.test(lovSrc19));
    check('  and per-mod headers group the ledger',
      /function lovLedgerGroups/.test(lovSrc19) && /data-lov-resetmod/.test(lovSrc19) && /data-lov-discardmod/.test(lovSrc19));
    check('  with the values-stay wording on discard-all',
      /values stay where they were last written/.test(lovSrc19));

    const rAll = await lo.resetModOverrides(DB_PATH, M1, { file: OV_PATH, statusFn: OPEN });
    check('reset-all restores every override of the mod',
      rAll.restored.length === 2 && dbValue(crOne19) === String(beforeOne19) && dbValue(crStr19) === String(beforeStr19),
      `db ${dbValue(crOne19)}/${dbValue(crStr19)} vs ${beforeOne19}/${beforeStr19}`);
    check('  and forgets the mod in the store', lo.readOverrides(OV_PATH).count === 0);
    check('  and reports one backup pointing at a real file',
      typeof rAll.backupPath === 'string' && fs.existsSync(rAll.backupPath));
    {
      const b = new DatabaseSync(rAll.backupPath, { readOnly: true });
      const pre = b.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'");
      const vals = [pre.get(crOne19), pre.get(crStr19)].map((x) => (x ? String(x.v) : null));
      b.close();
      check('  the backup is a pre-image of the whole batch (one transaction)',
        vals.includes(String(vOne19)) && vals.includes(String(vStr19)), JSON.stringify(vals));
    }
    let emptyMsg = '';
    try { await lo.resetModOverrides(DB_PATH, M1, { file: OV_PATH, statusFn: OPEN }); } catch (e) { emptyMsg = e.message; }
    check('  resetting a mod with nothing stored is refused', /no overrides are stored for that mod/.test(emptyMsg), emptyMsg);

    const vOneB19 = vOne19 + 1;
    const vStrB19 = vStr19 + 1;
    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: kOne19, value: vOneB19 }], { file: OV_PATH, statusFn: OPEN });
    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: kStr19, value: vStrB19 }], { file: OV_PATH, statusFn: OPEN });
    const v19 = lo.readOverrides(OV_PATH);
    const next19 = { ...v19.overrides };
    next19[normId(M1)] = { [kOne19]: { value: vOneB19 }, [kStr19]: next19[normId(M1)][kStr19] };
    lo.writeOverrides(OV_PATH, next19);
    const midDb19 = dbValue(crOne19);
    const midFile19 = fs.readFileSync(OV_PATH, 'utf8');
    let missMsg = '';
    try { await lo.resetModOverrides(DB_PATH, M1, { file: OV_PATH, statusFn: OPEN }); } catch (e) { missMsg = e.message; }
    check('reset-all refuses when any entry lacks a recorded author value', /never recorded.*nothing was written/.test(missMsg), missMsg);
    check('  and wrote nothing to the database', dbValue(crOne19) === midDb19 && dbValue(crStr19) === String(vStrB19));
    check('  and left the file byte-for-byte as it was', fs.readFileSync(OV_PATH, 'utf8') === midFile19);
    check('  and still stores both overrides', lo.readOverrides(OV_PATH).count === 2);

    const dAll = await lo.discardModOverrides(DB_PATH, M1, { file: OV_PATH, statusFn: OPEN });
    check('discard-all forgets the mod', dAll.discarded === 2 && lo.readOverrides(OV_PATH).count === 0);
    check('  and leaves the values where the last apply put them',
      dbValue(crOne19) === String(vOneB19) && dbValue(crStr19) === String(vStrB19),
      `${dbValue(crOne19)}/${dbValue(crStr19)}`);
    let dEmpty = '';
    try { await lo.discardModOverrides(DB_PATH, M1, { file: OV_PATH, statusFn: OPEN }); } catch (e) { dEmpty = e.message; }
    check('  discarding a mod with nothing stored is refused', /no overrides are stored/.test(dEmpty), dEmpty);

    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: kOne19, value: vOneB19 + 1 }], { file: OV_PATH, statusFn: OPEN });
    const runDb19 = dbValue(crOne19);
    const runFile19 = fs.readFileSync(OV_PATH, 'utf8');
    const runBak19 = newestBackup();
    let runR = '';
    try { await lo.resetModOverrides(DB_PATH, M1, { file: OV_PATH, statusFn: RUNNING }); } catch (e) { runR = e.message; }
    check('reset-all refuses while Civilization VI is running', /close Civilization VI/.test(runR), runR);
    let runD = '';
    try { await lo.discardModOverrides(DB_PATH, M1, { file: OV_PATH, statusFn: RUNNING }); } catch (e) { runD = e.message; }
    check('discard-all refuses too', /close Civilization VI/.test(runD), runD);
    check('  and neither wrote the database', dbValue(crOne19) === runDb19);
    check('  nor the file', fs.readFileSync(OV_PATH, 'utf8') === runFile19);
    check('  nor took a backup', newestBackup() === runBak19);
    lo.writeOverrides(OV_PATH, {});

    const srvSrc19 = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
    for (const p of ['/api/load-overrides/reset-mod', '/api/load-overrides/discard-mod']) {
      check(`  the ${p} route exists`, srvSrc19.includes(p));
    }
    const routesAt19 = srvSrc19.indexOf('const ROUTES = [');
    const routesText19 = routesAt19 === -1 ? '' : srvSrc19.slice(routesAt19, srvSrc19.indexOf('\n];', routesAt19) + 3);
    const handlerSrc19 = (name) => {
      const at = srvSrc19.indexOf(`async function ${name}(`);
      if (at === -1) return '';
      const end = srvSrc19.indexOf('\n}', at);
      return end === -1 ? '' : srvSrc19.slice(at, end + 2);
    };
    const routeHandler19 = (method, p) => {
      const m = new RegExp(`\\{ method: '${method}', match: '${p}'[^}]*?handler: (\\w+)`).exec(routesText19);
      return m ? handlerSrc19(m[1]) : '';
    };
    const resetBranch19 = routeHandler19('POST', '/api/load-overrides/reset-mod');
    check('  reset-mod awaits the game guard and maps it to 409',
      /await gameStatus\(\)/.test(resetBranch19) && /409/.test(resetBranch19) && /close Civilization VI first/.test(resetBranch19));
    check('  and delegates to resetModOverrides', /resetModOverrides/.test(resetBranch19));
    const discardBranch19 = routeHandler19('POST', '/api/load-overrides/discard-mod');
    check('  discard-mod awaits the game guard and maps it to 409',
      /await gameStatus\(\)/.test(discardBranch19) && /409/.test(discardBranch19));
    check('  and delegates to discardModOverrides', /discardModOverrides/.test(discardBranch19));
  });

  // ---- Test 20 (loadorder-overrides-import-export 1.1 + 1.2: transfer module) ----

  await asuite('Test 20: overrides export and import-with-backup', async () => {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const ovBaks = () => fs.readdirSync(TMP).filter((f) => f.startsWith('load-order-overrides.json.bak-')).sort();
    const kOne = keyOf('PatchOne');
    const kStr = keyOf('Strings');
    lo.writeOverrides(OV_PATH, {
      [normId(M1)]: { [kOne]: { value: 4242, declared: 9999 }, [kStr]: { value: 8000 } },
    });
    const onDisk = fs.readFileSync(OV_PATH, 'utf8');

    const payload = transfer.exportOverrides(OV_PATH);
    check('export answers the store content as read',
      payload.version === 1 && payload.overrides[normId(M1)][kOne].value === 4242,
      JSON.stringify(Object.keys(payload)));
    check('  keeping the recorded author value', payload.overrides[normId(M1)][kOne].declared === 9999);
    check('  bare numbers stay bare, so the file is byte-identical',
      JSON.stringify(payload, null, 2) === onDisk);

    lo.writeOverrides(OV_PATH, {});
    const emptyBytes = fs.readFileSync(OV_PATH, 'utf8');
    const preDb = dbValue(crOf('PatchOne'));
    const r = await transfer.importOverrides(DB_PATH, JSON.parse(onDisk), { file: OV_PATH, statusFn: OPEN });
    check('import replaces the store', r.imported === 2 && r.skipped.length === 0,
      `imported=${r.imported} skipped=${JSON.stringify(r.skipped)}`);
    check('  byte-for-byte on the same mod set', fs.readFileSync(OV_PATH, 'utf8') === onDisk);
    check('  keeping a backup of the previous file',
      typeof r.backupPath === 'string' && fs.existsSync(r.backupPath), String(r.backupPath));
    check('  the backup holding the previous bytes exactly',
      fs.readFileSync(r.backupPath, 'utf8') === emptyBytes);
    check('  and answering the re-read state for the UI',
      r.ok === true && r.count === 2, `ok=${r.ok} count=${r.count}`);
    check('  without touching the game database', dbValue(crOf('PatchOne')) === preDb);

    // Lenient validation: one file holding every failure mode at once.
    const kTwo = keyOf('PatchTwo');
    const kTwin = keyOf('NewAction'); // M2 holds twins under it: ambiguous
    const GONE = 'dddddddd-4444-4444-8444-444444444444';
    const beforeLenient = fs.readFileSync(OV_PATH, 'utf8');
    const lenient = {
      version: 1,
      overrides: {
        [M1]: {
          [kOne]: 4243,
          [kStr]: { value: 8001, declared: 9999 },
          [kTwo]: 1.5,
          'UpdateDatabase\nnope\nno.sql': 1,
        },
        [M2]: { [kTwin]: 7777 },
        [GONE]: { [kOne]: 5 },
        'not-a-guid': { [kOne]: 6 },
      },
    };
    const rl = await transfer.importOverrides(DB_PATH, lenient, { file: OV_PATH, statusFn: OPEN });
    check('lenient import keeps what resolves', rl.imported === 2, `imported=${rl.imported}`);
    const reasons = rl.skipped.map((s) => s.reason);
    check('  skipping the unresolvable key with its reason',
      reasons.includes('no action in that mod matches this key any more'), JSON.stringify(reasons));
    check('  the ambiguous twins with their count',
      reasons.some((x) => /2 actions in that mod match this key/.test(x)), JSON.stringify(reasons));
    check('  the missing mod without guessing',
      reasons.includes('that mod is not in the database'), JSON.stringify(reasons));
    check('  a malformed mod id without guessing',
      reasons.some((x) => /is not a mod id/.test(x)), JSON.stringify(reasons));
    check('  and a fractional value without guessing',
      reasons.some((x) => /whole number/.test(x)), JSON.stringify(reasons));
    check('  five skipped, each naming its reason', rl.skipped.length === 5, JSON.stringify(rl.skipped));
    check('  and the store holds only the two kept entries', lo.readOverrides(OV_PATH).count === 2);
    check('  with the kept values', stored(M1, kOne).value === 4243 && stored(M1, kStr).value === 8001);
    check('  and the backup holding the pre-import bytes',
      typeof rl.backupPath === 'string' && fs.readFileSync(rl.backupPath, 'utf8') === beforeLenient);
    check('  and the database still untouched', dbValue(crOf('PatchOne')) === preDb);

    const keptBytes = fs.readFileSync(OV_PATH, 'utf8');
    const baksMid = ovBaks();
    let zeroMsg = '';
    try {
      await transfer.importOverrides(DB_PATH, { version: 1, overrides: { [GONE]: { [kOne]: 1 } } }, { file: OV_PATH, statusFn: OPEN });
    } catch (e) { zeroMsg = e.message; }
    check('a file with nothing usable is refused', /nothing in that file could be used/.test(zeroMsg), zeroMsg);
    check('  writing nothing', fs.readFileSync(OV_PATH, 'utf8') === keptBytes);
    check('  and taking no backup', JSON.stringify(ovBaks()) === JSON.stringify(baksMid));

    writeFile('{ nope');
    let corruptMsg = '';
    try { await transfer.importOverrides(DB_PATH, JSON.parse(onDisk), { file: OV_PATH, statusFn: OPEN }); }
    catch (e) { corruptMsg = e.message; }
    check('a corrupt live store fails closed',
      /is not valid JSON.*nothing was written.*Fix or delete load-order-overrides\.json/.test(corruptMsg), corruptMsg);
    check('  leaving the file alone', fs.readFileSync(OV_PATH, 'utf8') === '{ nope');
    let exportMsg = '';
    try { transfer.exportOverrides(OV_PATH); } catch (e) { exportMsg = e.message; }
    check('  and export refuses it too', /nothing was written/.test(exportMsg), exportMsg);
    check('  and still takes no backup', JSON.stringify(ovBaks()) === JSON.stringify(baksMid));
    lo.writeOverrides(OV_PATH, {});

    const big = { version: 1, overrides: { [M1]: {} } };
    for (let i = 0; i <= lo.MAX_BULK_ENTRIES; i++) big.overrides[M1][`UpdateDatabase\nKey${i}\nF.sql`] = i;
    let guardCalled = false;
    const watching = async () => { guardCalled = true; return { running: true, known: true, processes: ['CivilizationVI.exe'] }; };
    let capMsg = '';
    try { await transfer.importOverrides(DB_PATH, big, { file: OV_PATH, statusFn: watching }); }
    catch (e) { capMsg = e.message; }
    check('an oversized file is refused', /limit 1000.*nothing was written/.test(capMsg), capMsg);
    check('  before the game guard is even asked', guardCalled === false);

    const fileBeforeGuard = fs.readFileSync(OV_PATH, 'utf8');
    const baksGuard = ovBaks();
    let guardMsg = '';
    try { await transfer.importOverrides(DB_PATH, JSON.parse(onDisk), { file: OV_PATH, statusFn: RUNNING }); }
    catch (e) { guardMsg = e.message; }
    check('import refuses while Civilization VI is running', /close Civilization VI first/.test(guardMsg), guardMsg);
    check('  writing nothing', fs.readFileSync(OV_PATH, 'utf8') === fileBeforeGuard);
    check('  and taking no backup', JSON.stringify(ovBaks()) === JSON.stringify(baksGuard));

    const shapeBytes = fs.readFileSync(OV_PATH, 'utf8');
    const shapeBaks = ovBaks();
    for (const [what, bad] of [
      ['a version this build did not write', { version: 99, overrides: {} }],
      ['a non-object file', [1, 2]],
      ['a file with no overrides list', { version: 1, overrides: [] }],
    ]) {
      let m = '';
      try { await transfer.importOverrides(DB_PATH, bad, { file: OV_PATH, statusFn: OPEN }); }
      catch (e) { m = e.message; }
      check(`${what} is refused as a whole`,
        /not a load-order overrides file|is version 99|has no overrides list/.test(m) && /nothing was written/.test(m), m);
    }
    check('  writing nothing for any of them', fs.readFileSync(OV_PATH, 'utf8') === shapeBytes);
    check('  and taking no backup', JSON.stringify(ovBaks()) === JSON.stringify(shapeBaks));
    lo.writeOverrides(OV_PATH, {});
  });

  // ---- Test 21 (loadorder-overrides-import-export 2.1: server routes) ----

  await asuite('Test 21: the transfer routes over HTTP', async () => {
    const postJson = (port, p, body) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body == null ? {} : body);
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t ? JSON.parse(t) : null }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    const getRaw = (port, p) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, agent: false },
      (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t }));
      });
      req.on('error', reject);
      req.end();
    });
    const freePort = () => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => resolve(a.port)); });
    });
    const waitUp = async (port, child) => {
      const t0 = Date.now();
      for (;;) {
        if (child.exitCode != null) throw new Error(`scratch server exited early (${child.exitCode})`);
        try {
          const r = await postJson(port, '/api/ping', {});
          if (r.status === 200 && r.body && r.body.ok) return;
        } catch (_) { /* not yet */ }
        if (Date.now() - t0 > 20000) throw new Error('scratch server never came up');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const boxDb = path.join(TMP, 'tx-copy.sqlite');
    fs.copyFileSync(DB_PATH, boxDb);
    const boxOv = path.join(TMP, 'tx-overrides.json');
    for (const d of ['tx-mods', 'tx-ws', 'tx-saves'].map((x) => path.join(TMP, x))) {
      fs.mkdirSync(d, { recursive: true });
    }
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: { ...process.env, CIV6_PATHS_FILE: path.join(TMP, 'no-such-paths.json'),
        CIV6_LOCAL_MODS: path.join(TMP, 'tx-mods'), CIV6_WORKSHOP: path.join(TMP, 'tx-ws'),
        CIV6_SAVES: path.join(TMP, 'tx-saves'), CIV6_MODS_DB: boxDb,
        CIV6_LABELS_FILE: path.join(TMP, 'tx-labels.json'), CIV6_LOADORDER_FILE: boxOv,
        PORT: String(port), NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitUp(port, child);
      const dd = new DatabaseSync(boxDb, { readOnly: true });
      const kOneTx = lo.actionKey(dd, dd.prepare("SELECT ComponentRowId AS c FROM Components WHERE ComponentId = 'PatchOne'").get().c);
      dd.close();
      lo.writeOverrides(boxOv, { [normId(M1)]: { [kOneTx]: { value: 4242 } } });
      const seeded = fs.readFileSync(boxOv, 'utf8');
      const gameNow = await getRaw(port, '/api/game').then((r) => JSON.parse(r.body), () => ({ running: false }));

      const g = await getRaw(port, '/api/load-overrides/export');
      check('export answers 200 with the file', g.status === 200, `status=${g.status} game running=${!!gameNow.running}`);
      check('  as a download', /attachment/.test(String(g.headers['content-disposition'] || '')) && /\.json/.test(String(g.headers['content-disposition'] || '')),
        String(g.headers['content-disposition']));
      check('  byte-identical to the store file', g.body === seeded);
      check('  parsing to the override set', JSON.parse(g.body).overrides[normId(M1)][kOneTx] === 4242);

      const fresh = { version: 1, overrides: { [M1]: { [kOneTx]: 5555 } } };
      if (gameNow.running) {
        // Civ6 is open in this run, so the write path refuses live: this is
        // the import-while-running route case, with nothing written.
        const fileBeforeRun = fs.readFileSync(boxOv, 'utf8');
        const imRun = await postJson(port, '/api/load-overrides/import', fresh);
        check('import-while-running is refused over HTTP',
          imRun.status === 409 && /close Civilization VI first/.test(imRun.body && imRun.body.error),
          `${imRun.status} ${imRun.body && imRun.body.error}`);
        check('  with nothing written', fs.readFileSync(boxOv, 'utf8') === fileBeforeRun);
      } else {
        let im = await postJson(port, '/api/load-overrides/import', fresh);
        check('import answers 200', im.status === 200, `${im.status} ${im.body && im.body.error}`);
        check('  reporting what it did', im.body.imported === 1 && Array.isArray(im.body.skipped),
          JSON.stringify({ imported: im.body.imported, skipped: im.body.skipped }));
        check('  with a backup of the previous file',
          typeof im.body.backupPath === 'string' && fs.existsSync(im.body.backupPath), String(im.body.backupPath));
        check('  the backup holding the seeded bytes', fs.readFileSync(im.body.backupPath, 'utf8') === seeded);
        check('  and the store replaced',
          JSON.parse(fs.readFileSync(boxOv, 'utf8')).overrides[normId(M1)][kOneTx].value === 5555);
        check('  answering the re-read state too', im.body.ok === true && im.body.count === 1,
          `ok=${im.body.ok} count=${im.body.count}`);

        const fileAfterGood = fs.readFileSync(boxOv, 'utf8');
        im = await postJson(port, '/api/load-overrides/import', { version: 99, overrides: {} });
        check('a version this build did not write is a 400', im.status === 400, String(im.status));
        check('  writing nothing', fs.readFileSync(boxOv, 'utf8') === fileAfterGood);
        im = await postJson(port, '/api/load-overrides/import', [1, 2]);
        check('  a non-object file too', im.status === 400, String(im.status));
      }

      const srvSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
      const routesAt = srvSrc.indexOf('const ROUTES = [');
      const routesText = routesAt === -1 ? '' : srvSrc.slice(routesAt, srvSrc.indexOf('\n];', routesAt) + 3);
      const handlerSrc = (name) => {
        const at = srvSrc.indexOf(`async function ${name}(`);
        if (at === -1) return '';
        const end = srvSrc.indexOf('\n}', at);
        return end === -1 ? '' : srvSrc.slice(at, end + 2);
      };
      const routeHandler = (method, p) => {
        const m = new RegExp(`\\{ method: '${method}', match: '${p}'[^}]*?handler: (\\w+)`).exec(routesText);
        return m ? handlerSrc(m[1]) : '';
      };
      check('both transfer routes exist',
        /match: '\/api\/load-overrides\/export'/.test(routesText) && /match: '\/api\/load-overrides\/import'/.test(routesText));
      const exportBranch = routeHandler('GET', '/api/load-overrides/export');
      check('  the export branch never refuses: no guard, no 409',
        !/gameStatus/.test(exportBranch) && !/409/.test(exportBranch));
      check('  and delegates shaping to the transfer module', /exportOverrides/.test(exportBranch));
      const importBranch = routeHandler('POST', '/api/load-overrides/import');
      check('  the import branch awaits the game guard and maps it to 409',
        /await gameStatus\(\)/.test(importBranch) && /409/.test(importBranch) && /close Civilization VI first/.test(importBranch));
      check('  and delegates the write to the transfer module', /importOverrides/.test(importBranch));

      const fileBeforeUnit = fs.readFileSync(boxOv, 'utf8');
      let runMsg = '';
      try { await transfer.importOverrides(boxDb, fresh, { file: boxOv, statusFn: RUNNING }); }
      catch (e) { runMsg = e.message; }
      check('import refuses while Civilization VI is running', /close Civilization VI first/.test(runMsg), runMsg);
      check('  writing nothing', fs.readFileSync(boxOv, 'utf8') === fileBeforeUnit);
    } finally {
      if (child.exitCode == null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
    }
  });

  // ---- Test 17 ----

  await asuite('Test 17: nothing was left open', async () => {
    check('every read connection was closed', liveConns.size === 0, `${liveConns.size} still open`);
  });

  // ---- finalize (child): write records, clean up, exit ----

  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (e) {
    console.log(`  (note: scratch dir ${TMP} could not be removed: ${e.code} ${e.message})`);
  }
  fs.writeFileSync(recordPath, JSON.stringify(suites));
  process.exit(pass ? 0 : 1);
}
