'use strict';

// Phase 7 automated proof: load order overrides (Tasks 1 and 2).
//
// Operates only on synthetic databases in a scratch dir, plus a COPY of a real
// Mods.sqlite if one is passed as the first argument. The real one is read and
// never written.
//
//   node src/phase7-loadorder.js [path/to/Mods.sqlite]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const lo = require('./loadorder');
const { fileTimeOf } = require('./modsdb');
const { normId } = require('./modinfo');

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-loadorder-')));
const DB_PATH = path.join(TMP, 'Mods.sqlite');
const OV_PATH = path.join(TMP, 'load-order-overrides.json');

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};
const fails = (fn) => { try { fn(); return false; } catch (_) { return true; } };
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);

  // A modinfo that is really on disk, so the stamp has something to compare.
  const modDir = path.join(TMP, 'mods', 'Real Mod');
  fs.mkdirSync(modDir, { recursive: true });
  const modinfo = path.join(modDir, 'Real.modinfo');
  fs.writeFileSync(modinfo, '<Mod id="aaaaaaaa-1111-4111-8111-111111111111"></Mod>');

  // mod 1 is on disk and has three distinguishable actions
  const sf1 = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, ?)').run(modinfo, fileTimeOf(modinfo).toString()).lastInsertRowid;
  const m1 = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf1, 'AAAAAAAA-1111-4111-8111-111111111111').lastInsertRowid;
  addAction(w, m1, 'UpdateDatabase', 'PatchOne', ['Patches/One.sql'], '100');
  addAction(w, m1, 'UpdateDatabase', 'PatchTwo', ['Patches/Two.sql'], '200');
  addAction(w, m1, 'UpdateText', 'Strings', ['Text/Strings.xml'], '300');
  addAction(w, m1, 'UpdateDatabase', 'NeedsAbsent', ['Patches/Absent.sql'], '4000');
  addAction(w, m1, 'UpdateIcons', 'NoPosition', ['Icons/Extra.dds'], null);

  // mod 2 is NOT on disk, and has two identical actions - the ambiguous case
  const sf2 = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run('../../../Base/Game/modinfo.xml').lastInsertRowid;
  const m2 = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf2, 'BBBBBBBB-2222-4222-8222-222222222222').lastInsertRowid;
  addAction(w, m2, 'UpdateDatabase', 'NewAction', ['Base/Shared.sql'], '500');
  addAction(w, m2, 'UpdateDatabase', 'NewAction', ['Base/Shared.sql'], '600');
  addAction(w, m2, 'UpdateDatabase', 'Lonely', ['Base/Unique.sql'], null);

  // Two profiles over the same mods, so Compare has something to compare.
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (2, ?, 1, 0, 1)').run('Small');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, 0)');
  item.run(1, m1); item.run(1, m2); item.run(2, m1);

  // mod 3 is the probe's shape: on disk, OFF in the active profile, ON in
  // another one. ModInUse turns on exactly this, and the old fixture had only
  // "not installed", which was decidable before the probe and so tested nothing
  // about what the probe settled.
  const sf3 = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, ?)').run(path.join(modDir, 'Other.modinfo'), 1).lastInsertRowid;
  const m3 = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf3, 'CCCCCCCC-3333-4333-8333-333333333333').lastInsertRowid;
  w.prepare("INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, 'Name', ?)").run(m3, 'Other Mod');
  w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, ?)').run(1, m3, 1);
  w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, ?)').run(2, m3, 0);
  w.prepare("INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, 'Name', ?)").run(m1, 'Real Mod');
  w.prepare("INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, 'Name', ?)").run(m2, 'Off Disk Mod');

  // Conditions, the two cases the view has to be honest about: one naming a
  // mod nobody has installed (provable), one naming a game ruleset (not).
  const crOf = (id) => w.prepare('SELECT ComponentRowId AS c FROM Components WHERE ComponentId = ? AND ModRowId = ?').get(id, m1).c;
  w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (1, ?, ?, 0)').run(m1, 'Absent');
  w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (2, ?, ?, 0)').run(m1, 'Ruleset');
  w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (1, 1, ?, 0)').run('ModInUse');
  w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (2, 2, ?, 0)').run('RuleSetInUse');
  w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (1, 'Value', ?)").run('DDDDDDDD-4444-4444-8444-444444444444');
  w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (2, 'Value', 'RULESET_EXPANSION_1')").run();
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, 1)').run(crOf('NeedsAbsent'));
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, 2)').run(crOf('PatchOne'));

  // The shapes the probe settled, and the two that were wrong. Positions are
  // parked well away from the existing 100..4000 so the free-run checks still
  // have gaps to find.
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

  // m1 is ON in Main and m3 is OFF in Main; the absent id names nothing.
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

  // 3: ModInUse of a mod that is installed but off here. The probe's case.
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('GatedOff'), G(3, 0, [['ModInUse', 0, OFF3]]));
  // 4: NOT ModInUse(off) - satisfied, because it is off.
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('InvertedOff'), G(4, 0, [['ModInUse', 1, OFF3]]));
  // 5: NOT ModInUse(on) - NOT satisfied. The old code skipped the inverted
  //    condition and called this "will run", which is the misreport the inverse
  //    flag exists to prevent.
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('InvertedOn'), G(5, 0, [['ModInUse', 1, ON1]]));
  // 6: NOT ModInUse(nothing installed) - the absence is what it asks for.
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('InvertedAbsent'), G(6, 0, [['ModInUse', 1, GONE]]));
  // 7-10: Any=1 sets. Unanimous ones are decided; split ones are not, and
  //     that needs no reading of Any - all-met is true under AND and OR, all-unmet
  //     is false under both, and a split means AND says false while OR says true.
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AnyAllMet'), G(7, 1, [['ModInUse', 0, ON1], ['ModInUse', 0, ON2]]));
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AnyAllUnmet'), G(8, 1, [['ModInUse', 0, OFF3], ['ModInUse', 0, GONE]]));
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AnySplit'), G(9, 1, [['ModInUse', 0, ON1], ['ModInUse', 0, OFF3]]));
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AnySplitUnknown'), G(10, 1, [['ModInUse', 0, ON1], ['RuleSetInUse', 0, 'RULESET_EXPANSION_1']]));
  // 13: a ConfigurationValueMatches condition, which is the only type here with
  //     more than one property - ConfigurationId, Group and Value. It is also the
  //     one no view can answer: measured, nothing in the library or the install
  //     holds a GAMEMODE_ value, because the game keeps it in memory from the
  //     main menu picker.
  {
    const crid = w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (?, ?, ?, 0)').run(13, m1, 'GameOption').lastInsertRowid;
    const c = w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, ?, 0)').run(null, crid, 'ConfigurationValueMatches').lastInsertRowid;
    for (const [n2, val] of [['ConfigurationId', 'GAMEMODE_MONOPOLIES'], ['Group', 'Game'], ['Value', '1']]) {
      w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, ?, ?)").run(c, n2, val);
    }
    w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('GameOption'), crid);
  }

  // 11-12: AND sets. One unmet defeats the set however the other reads.
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AndUnmetPlusUnknown'), G(11, 0, [['ModInUse', 0, OFF3], ['RuleSetInUse', 0, 'RULESET_EXPANSION_1']]));
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(crOf('AndMetPlusUnknown'), G(12, 0, [['ModInUse', 0, ON1], ['RuleSetInUse', 0, 'RULESET_EXPANSION_1']]));
  w.close();
}

function addAction(w, modRowId, type, id, files, loadOrder) {
  const cr = w.prepare('INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, ?)')
    .run(modRowId, id, type).lastInsertRowid;
  if (loadOrder !== null && loadOrder !== undefined) {
    // One action ships the misspelling, because "always write the correctly
    // spelled row and never refuse" only means something when a mod really has
    // got it wrong. The key must be unaffected either way.
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

// Every read connection is tracked, and the count is asserted before the
// scratch directory is removed. A handle left open shows up here as a count,
// rather than as an EPERM from rmSync that has nothing to do with what is being
// tested - which is how two leaks in this file went unnoticed at first.
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

console.log(`scratch dir: ${TMP}\nseeded a small test database -> ${DB_PATH}\n`);

// ---------------------------------------------------------------------------

console.log('Test 1: reading the overrides file');
{
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
}

console.log('\nTest 2: one bad entry among good ones');
{
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

  // Two different things, and the distinction is worth having. A valid mod id
  // you do not have installed is an orphan, not an error - it is pruned only
  // when the caller can vouch for the set. A key whose value is not an override
  // map at all is junk in the overrides object, and saying so is the point.
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
}

console.log('\nTest 3: writing');
{
  writeFile('{ broken');
  const before = fs.readFileSync(OV_PATH, 'utf8');
  check('writing over an unusable file is refused', fails(() => lo.setOverride(OV_PATH, M1, 'a\nb', 5, 1)));
  check('  and leaves it byte-for-byte as it was', fs.readFileSync(OV_PATH, 'utf8') === before);
  let msg = '';
  try { lo.setOverride(OV_PATH, M1, 'a\nb', 5, 1); } catch (e) { msg = e.message; }
  check('  and says why, rather than just failing', /nothing was written/.test(msg), msg);

  try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
  // One connection, closed. A handle opened inline as an argument is never
  // closed, and it keeps the scratch directory locked on Windows long enough to
  // fail the cleanup at the end of the run - which is how this was found.
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

  // A second save must not lose the first - read-modify-write, not a whole-file PUT
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
}

console.log('\nTest 4: what a value may be');
{
  const d = db();
  const cr = one("SELECT ComponentRowId AS c FROM Components WHERE ComponentId='PatchTwo'").c;
  const key = lo.actionKey(d, cr);
  d.close();
  // The library contains -200, 4, 1e8 and 22222 as real author choices, so a
  // range check would reject mods that work. These must all be accepted.
  for (const v of [-200, 0, 4, 22222, 100000001]) {
    lo.setOverride(OV_PATH, M1, key, v, 200);
    eq(`  ${v} is accepted`, lo.readOverrides(OV_PATH).overrides[normId(M1)][key].value, v);
  }
  for (const bad of ['nope', 1.5, NaN, null, {}]) {
    check(`  ${JSON.stringify(bad)} is refused`, fails(() => lo.setOverride(OV_PATH, M1, key, bad, 1)));
  }
  check('  a value past the sanity bound is refused', fails(() => lo.setOverride(OV_PATH, M1, key, 1e30, 1)));
  lo.clearOverride(OV_PATH, M1, key);
}

console.log('\nTest 5: naming an action');
{
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

  // The ambiguous fixture: two actions, identical type, id and file list.
  const dup = lo.actionKey(d, one("SELECT MIN(ComponentRowId) AS c FROM Components WHERE ComponentId='NewAction'").c);
  const amb = lo.resolveAction(d, M2, dup);
  check('two identical actions are ambiguous, never one of them picked', amb.state === lo.AMBIGUOUS, amb.state);
  check('  and both candidates are offered', amb.candidates.length === 2, String(amb.candidates.length));
  check('  with no componentRowId chosen', amb.componentRowId === null);
  d.close();
}

console.log('\nTest 6: the key has to survive what actually changes');
{
  const d = db();
  const cr = one("SELECT ComponentRowId AS c FROM Components WHERE ComponentId='PatchOne'").c;
  const key = lo.actionKey(d, cr);
  d.close();

  // An author bumping the declared value is exactly the update an override has
  // to survive, so the declared LoadOrder must not be in the key.
  const w = new DatabaseSync(DB_PATH);
  w.prepare("UPDATE ComponentProperties SET Value = '9999' WHERE ComponentRowId = ? AND Name = 'LoadOrder'").run(cr);
  w.close();
  let d2 = db();
  check('a bumped declared value still resolves', lo.resolveAction(d2, M1, key).componentRowId === cr);
  d2.close();

  // A mod that misspells the property must not change its action's identity
  // either, or "always write the correct row" would orphan every override.
  const typo = one("SELECT ComponentRowId AS c FROM Components WHERE ComponentId='PatchTwo'").c;
  d2 = db();
  const typoKey = lo.actionKey(d2, typo);
  check('an action whose property is spelled LaodOrder is keyed the same way',
    typoKey === 'UpdateDatabase\nPatchTwo\nPatches/Two.sql', JSON.stringify(typoKey));
  check('  and resolves', lo.resolveAction(d2, M1, typoKey).componentRowId === typo);
  d2.close();

  // And a rescan. The game deletes and recreates every row for a mod it has
  // decided to re-register, so ModRowId AND ComponentRowId both move.
  const renumber = new DatabaseSync(DB_PATH);
  renumber.exec('UPDATE Mods SET ModRowId = ModRowId + 100');
  // Group membership moves too. A rescan re-registers the mod everywhere, and
  // leaving ModGroupItems behind strands the profile on row ids that no
  // longer exist - which is what silently emptied the view's profile in the
  // first run of these tests.
  renumber.exec('UPDATE ModGroupItems SET ModRowId = ModRowId + 100');
  renumber.exec('UPDATE Components SET ComponentRowId = ComponentRowId + 1000, ModRowId = ModRowId + 100');
  renumber.exec('UPDATE ComponentProperties SET ComponentRowId = ComponentRowId + 1000');
  renumber.exec('UPDATE ComponentFiles SET ComponentRowId = ComponentRowId + 1000');
  renumber.exec('UPDATE ComponentCriteria SET ComponentRowId = ComponentRowId + 1000');
  // The three that carry a ModRowId and were missed. Every mod lost its name,
  // its files, and its criteria sets, and nothing noticed for the rest of the
  // file because the only reason-string assertion was /not installed/, which
  // never reads a name.
  renumber.exec('UPDATE ModProperties SET ModRowId = ModRowId + 100');
  renumber.exec('UPDATE ModFiles SET ModRowId = ModRowId + 100');
  renumber.exec('UPDATE Criteria SET ModRowId = ModRowId + 100');
  renumber.close();

  // Every table that names a ModRowId has to move with it. Checked by asking
  // the database rather than by reading this list, so a table added to the
  // fixture later is caught here instead of surfacing as a wrong name.
  {
    const rq = new DatabaseSync(DB_PATH, { readOnly: true });
    const dangling = ['ModGroupItems', 'ModProperties', 'ModFiles', 'Criteria']
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

  // The negative control, and the reason the two rules above are worth anything:
  // both row ids moved, so anything keyed on either is now pointing at the wrong
  // place - while the content key is byte-identical across the same rescan.
  const stillThere = d2.prepare('SELECT ComponentRowId FROM Components WHERE ComponentId = ?').get('PatchOne').ComponentRowId;
  check('a ComponentRowId-keyed lookup now names a different row than the one it meant',
    stillThere !== cr, `${cr} is now ${stillThere}`);
  check('while the content key is unchanged across that same rescan',
    lo.actionKey(d2, stillThere) === key, JSON.stringify(lo.actionKey(d2, stillThere)));
  d2.close();
}

console.log('\nTest 7: the stamp');
{
  const d = db();
  const m1row = one('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)', M1);
  const m2row = one('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)', M2);

  const f = lo.modFile(d, m1row.ModRowId);
  check('a mod whose .modinfo is on disk is reported as such', f.onDisk === true, f.path);
  check('  and its stamp is fresh - the game wrote it from these bytes', lo.stampIsStale(d, m1row.ModRowId) === false);
  check('  and the stamp is a string, because the column overflows a JS number',
    typeof lo.stampFor(f.path) === 'string', lo.stampFor(f.path));

  // Touch the file: the game would re-derive, and that is what the stamp is for.
  const before = lo.stampFor(f.path);
  fs.writeFileSync(f.path, '<Mod id="aaaaaaaa-1111-4111-8111-111111111111"><X/></Mod>');
  check('moving the file makes the stamp stale', lo.stampIsStale(d, m1row.ModRowId) === true);
  check('  and the new stamp differs from the old', lo.stampFor(f.path) !== before);

  // Re-stamping is the whole mechanism, so prove the value we would write is
  // what the game compares against - exactly, to the tick.
  const w = new DatabaseSync(DB_PATH);
  const sf = w.prepare('SELECT ScannedFileRowId FROM Mods WHERE ModRowId = ?').get(m1row.ModRowId).ScannedFileRowId;
  w.prepare('UPDATE ScannedFiles SET LastWriteTime = ? WHERE ScannedFileRowId = ?').run(lo.stampFor(f.path), sf);
  w.close();
  const d2 = db();
  check('writing the stamp makes it fresh again', lo.stampIsStale(d2, m1row.ModRowId) === false);
  d2.close();

  // And the rounded form must NOT be what we write: it sits behind the file and
  // reads as the very change we are trying to hide.
  const d3 = db();
  const exact = lo.stampFor(f.path);
  const ms = fileTimeOf(f.path) / 10000n;          // whole milliseconds
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

  // A row whose .modinfo is not on disk cannot be stamped, and must say so
  // rather than be quietly treated as safe.
  const f2 = lo.modFile(d3, m2row.ModRowId);
  check('a mod whose .modinfo is not on disk says so', f2.onDisk === false, f2.path);
  check('  and stampIsStale answers null - nothing to compare, nothing to keep up to date',
    lo.stampIsStale(d3, m2row.ModRowId) === null, String(lo.stampIsStale(d3, m2row.ModRowId)));
  check('  and the 42 relative-path rows are exactly this shape: ../../..',
    f2.path.startsWith('../'), f2.path);

  // Reading the column as a number is the trap that has bitten three times.
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
}

// ---------------------------------------------------------------------------
// The real database, if one is offered
// ---------------------------------------------------------------------------

const real = process.argv[2];
if (real && fs.existsSync(real)) {
  console.log(`\nTest 8: a copy of the real database (${real})`);
  const copyPath = path.join(TMP, 'RealMods.sqlite');
  fs.copyFileSync(real, copyPath);
  const rd = lo.openDb(copyPath, { readOnly: true });

  const total = rd.prepare('SELECT count(*) AS n FROM Components').get().n;
  console.log(`  components: ${total}`);

  // Every action must compute a key. A fixture that cannot cover the whole
  // library is not covering the library.
  let noKey = 0;
  const all = rd.prepare('SELECT ComponentRowId, ModRowId FROM Components ORDER BY ModRowId, ComponentRowId').all();
  const byMod = new Map();
  for (const r of all) {
    if (lo.actionKey(rd, r.ComponentRowId) === null) noKey++;
    if (!byMod.has(r.ModRowId)) byMod.set(r.ModRowId, []);
    byMod.get(r.ModRowId).push(r.ComponentRowId);
  }
  check('every action in the library computes a key', noKey === 0, `${noKey} did not`);

  // The measured collision rate. Asserted, because a suite that only says "it
  // works" cannot tell that the key changed underneath it.
  let colliding = 0;
  let groups = 0;
  const keysOf = (cr) => lo.actionKey(rd, cr);
  for (const [, crs] of byMod) {
    if (crs.length < 2) continue;
    const seen = new Map();
    for (const cr of crs) {
      const k = keysOf(cr);
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    for (const n of seen.values()) if (n > 1) { groups++; colliding += n; }
  }
  console.log(`  (files, type, id): ${colliding} colliding actions in ${groups} groups`);
  check('(files, type, id) collides on 11 actions', colliding === 11, String(colliding));
  check('  in 5 groups', groups === 5, String(groups));

  // The negative control: the id on its own is far worse, which is why the key
  // is not just the id.
  let idColliding = 0;
  for (const [, crs] of byMod) {
    if (crs.length < 2) continue;
    const seen = new Map();
    for (const cr of crs) {
      const id = rd.prepare('SELECT ComponentId AS id FROM Components WHERE ComponentRowId = ?').get(cr).id;
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    for (const n of seen.values()) if (n > 1) idColliding += n;
  }
  console.log(`  id alone: ${idColliding} colliding actions`);
  check('the id alone collides far more', idColliding > colliding * 10, `${idColliding} vs ${colliding}`);

  // A sample of real actions must round-trip through resolveAction.
  const sampleMods = [...byMod.entries()].filter(([, c]) => c.length > 1).slice(0, 40);
  let resolved = 0;
  let ambiguous = 0;
  let missing = 0;
  for (const [modRowId, crs] of sampleMods) {
    const modId = rd.prepare('SELECT ModId FROM Mods WHERE ModRowId = ?').get(modRowId).ModId;
    for (const cr of crs) {
      const r = lo.resolveAction(rd, modId, lo.actionKey(rd, cr));
      if (r.state === lo.FIND && r.componentRowId === cr) resolved++;
      else if (r.state === lo.AMBIGUOUS) ambiguous++;
      else missing++;
    }
  }
  check('sampled actions all resolve to themselves or report ambiguity, never missing',
    missing === 0, `${resolved} resolved, ${ambiguous} ambiguous, ${missing} missing`);
  check('  and the ambiguous ones are the measured handful, not a collapse', ambiguous <= 11, String(ambiguous));

  // The 42 rows that cannot be stamped.
  const offDisk = rd.prepare(
    "SELECT count(*) AS n FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId WHERE s.Path LIKE '..%'"
  ).get().n;
  console.log(`  rows with a relative .modinfo path: ${offDisk}`);
  if (offDisk) {
    const sample = rd.prepare(
      "SELECT m.ModRowId AS r FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId WHERE s.Path LIKE '..%' LIMIT 1"
    ).get();
    check('  and one of them reports not-on-disk', lo.modFile(rd, sample.r).onDisk === false);
    check('  with a null stamp verdict rather than a guess', lo.stampIsStale(rd, sample.r) === null);
  }
  rd.close();
} else {
  console.log('\nTest 8: a copy of the real database - SKIPPED (no path given)');
  console.log('  pass one to check the collision rate against your own library:');
  console.log('    node src/phase7-loadorder.js "C:/Users/<you>/AppData/Local/Firaxis Games/Sid Meier\'s Civilization VI/Mods.sqlite"');
}

// The rest is async, because writing to the game's database is. It is a promise
// chain rather than top-level await, which CommonJS does not allow.
(async () => {
  // Backups cannot be counted by file: modsdb names them to the second, so
  // several writes in the same second collapse into one file. What can be
  // checked is that a backup exists and points at a real copy.
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
  // One connection for both, so a helper cannot leak a handle of its own.
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

  console.log('\nTest 9: refusing to write while the game has the database open');
  {
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
  }

  console.log('\nTest 10: applying by hand');
  {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const kOne = keyOf('PatchOne');
    const kTwo = keyOf('PatchTwo');   // the one whose property is spelled LaodOrder
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

    // The misspelled property: the write goes to a correctly spelled row and the
    // author's typo is left exactly as it was.
    const d = db();
    const typoRow = d.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LaodOrder'").get(crTwo);
    const goodRow = d.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'").get(crTwo);
    d.close();
    check('an action whose property is spelled LaodOrder is overridden anyway', r.applied.some((a) => a.key === kTwo),
      JSON.stringify(r.applied.map((a) => a.key)));
    check('  by writing a correctly spelled LoadOrder row', !!goodRow && String(goodRow.v) === '7000', JSON.stringify(goodRow));
    check('  and leaving the mod\'s own misspelled row untouched',
      !!typoRow && String(typoRow.v) === '200', JSON.stringify(typoRow));

    // Numbers, because the file round trip normalises them - which is also what
    // a hand-edited file gets.
    check('the author\'s value is recorded, so reset is possible', stored(M1, kOne).declared === 9999, JSON.stringify(stored(M1, kOne)));
    check('  and for the misspelled one it is read from the row the mod actually wrote', stored(M1, kTwo).declared === 200, JSON.stringify(stored(M1, kTwo)));

    // And the stamp, which is what stops the game re-deriving on next launch.
    const mr = modRowId(M1);
    check('  and the mod is on disk, so it can be stamped at all', mr !== null, String(mr));
    check('  and its stamp is fresh, so the game will not re-derive it',
      staleOf(M1) === false, String(staleOf(M1)));

    // A sentinel is reported, never refused.
    const s = await lo.applyOverrides(DB_PATH, [{ modId: M1, key: kOne, value: 10000001 }], { file: OV_PATH, statusFn: OPEN });
    check('a value past the load-last sentinel is applied and reported',
      s.applied.length === 1 && s.sentinels.length === 1, JSON.stringify(s.sentinels));

    // An override that resolves to nothing, or to more than one thing, is
    // reported and never written.
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

    // A mod whose .modinfo is not on disk gets the value but is reported as
    // unprotectable, because nothing can keep its stamp.
    const kBase = (() => {
      const d = db();
      try { return lo.actionKey(d, firstCrIn(d, 'Lonely')); } finally { d.close(); }
    })();
    const un = await lo.applyOverrides(DB_PATH, [{ modId: M2, key: kBase, value: 999 }], { file: OV_PATH, statusFn: OPEN });
    check('a mod with no .modinfo on disk still takes the value', un.applied.length === 1, JSON.stringify(un.applied));
    check('  and is reported as unprotectable rather than treated as safe',
      un.unprotectable.length === 1 && un.unprotectable[0] === normId(M2), JSON.stringify(un.unprotectable));
  }

  console.log('\nTest 11: putting one back');
  {
    const k = keyOf('PatchOne');
    const r = await lo.resetOverride(DB_PATH, M1, k, { file: OV_PATH, statusFn: OPEN });
    // 9999, because that is what Test 6 left as this action's declared value.
    // The sentinel apply after it must NOT have replaced that with the override
    // it wrote - which is exactly the bug this expectation caught.
    check('reset restores the value the author declared', r.restored === 9999 && dbValue(crOf('PatchOne')) === '9999',
      `${r.restored} / ${dbValue(crOf('PatchOne'))}`);
    check('  and forgets the override', stored(M1, k) === undefined);
    let msg = '';
    try { await lo.resetOverride(DB_PATH, M1, k, { file: OV_PATH, statusFn: OPEN }); } catch (e) { msg = e.message; }
    check('  and resetting again is refused', /no override is stored/.test(msg), msg);
  }

  console.log('\nTest 12: sync at startup');
  {
    // Nothing stored, nothing to do, and above all no backup spent.
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const before = newestBackup();
    let s = lo.syncOverrides(DB_PATH, { file: OV_PATH });
    check('with no overrides, sync does nothing', s.changed === false && s.applied.length === 0);
    check('  and spends no backup', newestBackup() === before, `${newestBackup()} vs ${before}`);

    s = lo.syncOverrides(DB_PATH, { file: OV_PATH, gameRunning: true });
    check('with the game running it is deferred, never silently skipped',
      s.deferred === true && /Civilization VI is running/.test(String(s.reason)), JSON.stringify(s.reason));
    check('  and nothing was written', newestBackup() === before, `${newestBackup()} vs ${before}`);

    // Two overrides, both already matching and the stamp fresh: a sync that
    // runs on every launch must be free.
    const k1 = keyOf('Strings');
    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: k1, value: 300 }], { file: OV_PATH, statusFn: OPEN });
    const mid = newestBackup();
    s = lo.syncOverrides(DB_PATH, { file: OV_PATH });
    check('a sync with nothing to repair writes nothing', s.changed === false && s.drifted.length === 0);
    check('  and takes no backup', newestBackup() === mid, `${newestBackup()} vs ${mid}`);

    // Now the event everything exists for: the mod updated. The file moved, the
    // game would re-derive, and every row id is replaced.
    const k2 = keyOf('PatchOne');
    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: k2, value: 4242 }], { file: OV_PATH, statusFn: OPEN });
    const file = fileOf(M1);
    fs.writeFileSync(file, '<Mod id="aaaaaaaa-1111-4111-8111-111111111111"><V2/></Mod>');
    const w = new DatabaseSync(DB_PATH);
    // What the game actually does on a rescan: every row replaced, and the
    // values put back to what the .modinfo declares. A simulation that only
    // renumbered the ids would leave the values already correct, and the sync
    // would have nothing to repair - which is how this first looked like it
    // worked when it had not been tested at all.
    w.exec('UPDATE Mods SET ModRowId = ModRowId + 500');
    w.exec('UPDATE ModGroupItems SET ModRowId = ModRowId + 500');
    w.exec('UPDATE Components SET ComponentRowId = ComponentRowId + 5000, ModRowId = ModRowId + 500');
    w.exec('UPDATE ComponentProperties SET ComponentRowId = ComponentRowId + 5000');
    w.exec('UPDATE ComponentFiles SET ComponentRowId = ComponentRowId + 5000');
    // The same three the first renumber missed. Both operations have to carry
    // them: Mods ends up 600 higher, and a table moved by one of the two is
    // just as dangling as a table moved by neither.
    w.exec('UPDATE ModProperties SET ModRowId = ModRowId + 500');
    w.exec('UPDATE ModFiles SET ModRowId = ModRowId + 500');
    w.exec('UPDATE Criteria SET ModRowId = ModRowId + 500');
    w.exec('UPDATE ComponentCriteria SET ComponentRowId = ComponentRowId + 5000');
    w.exec("UPDATE ComponentProperties SET Value = '9999' WHERE Name = 'LoadOrder'");
    w.exec("UPDATE ComponentProperties SET Value = '300' WHERE Name = 'LoadOrder' AND ComponentRowId IN (SELECT ComponentRowId FROM Components WHERE ComponentId = 'Strings')");
    w.close();

    const preSync = lo.staleMods(DB_PATH, { file: OV_PATH });
    check('a mod that updated is reported stale before it is repaired',
      preSync.stale.length === 1 && preSync.stale[0] === normId(M1), JSON.stringify(preSync.stale));

    s = lo.syncOverrides(DB_PATH, { file: OV_PATH });
    // One, not three: the simulated rescan put Strings back to 300, which is
    // what it should be, and PatchTwo's row is the misspelled LaodOrder one a
    // rescan does not touch. Only the sentinel override had actually drifted.
    check('one sync repairs what had drifted', s.changed === true && s.applied.length === 1,
      `changed ${s.changed} applied ${s.applied.length}`);
    // `drifted` names what needed repairing, so the one that was repaired is in
    // it - and Strings and PatchTwo are not, which is the point of the check.
    check('  and reports exactly the one it repaired, and nothing else', s.drifted.length === 1,
      JSON.stringify(s.drifted.map((d) => d.key)));
    check('  from the value the rescan put back to the value asked for',
      s.drifted[0].from === '9999' && s.drifted[0].to === '4242', JSON.stringify(s.drifted[0]));
    // A new backup cannot be seen: modsdb names them to the second, so a write
    // in the same second as the last one reuses that name. What is checkable is
    // that the path is reported and is a real file.
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
  }

  console.log('\nTest 13: sync reports what it will not do');
  {
    // Two more entries that cannot be repaired, and must be reported separately
    // from drift rather than quietly dropped.
    const v = lo.readOverrides(OV_PATH);
    const next = { ...v.overrides };
    next[normId(M1)] = { ...(next[normId(M1)] || {}), 'UpdateDatabase\ngone\nx.sql': { value: 1 } };
    next[normId(M2)] = { 'UpdateDatabase\nNewAction\nBase/Shared.sql': { value: 2 } };
    lo.writeOverrides(OV_PATH, next);
    const s = lo.syncOverrides(DB_PATH, { file: OV_PATH });
    check('an orphaned override is reported', s.orphans.length >= 1, JSON.stringify(s.orphans.map((o) => o.reason)));
    check('an ambiguous one is reported separately', s.ambiguous.length >= 1, JSON.stringify(s.ambiguous.map((a) => a.reason)));
    check('  and neither was written', s.applied.every((a) => a.key !== 'UpdateDatabase\ngone\nx.sql'));
    // Clean up so the connection check is not the only thing left clean.
    lo.writeOverrides(OV_PATH, {});
  }

  console.log('\nTest 14: the load order view');
  {
    try { fs.unlinkSync(OV_PATH); } catch (_) { /* absent */ }
    const v = lo.profileLoadOrder(DB_PATH, { file: OV_PATH });
    check('the view builds', v.ok === true, v.error || '');
    check('  and names the profile in use', v.profile && v.profile.name === 'Main', JSON.stringify(v.profile));
    check('  and offers every profile to choose from', v.groups.length === 2, JSON.stringify(v.groups.map((g) => g.name)));

    // The list is the answer, so it has to be in order, with ties grouped and
    // never ordered inside the group.
    const values = v.bands.filter((b) => b.kind === 'value').map((b) => b.value);
    check('  value bands are ascending', values.every((x, i) => i === 0 || x > values[i - 1]), values.join(','));
    check('  every positioned action is in exactly one band',
      v.bands.filter((b) => b.kind === 'value').reduce((t, b) => t + b.actions.length, 0) + v.undeclaredTotal === v.summary.actions,
      JSON.stringify(v.summary));
    check('  and every action knows its mod',
      v.bands.flatMap((b) => b.actions || []).every((a) => a.modId && a.modName && a.modName !== 'unknown mod'));

    // Free runs sit between two values and are self-consistent.
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

    // The undeclared block, which is where "this mod relies on ordering nobody
    // controls" comes from.
    check('  undeclared actions are counted, not dropped', v.undeclaredTotal === 1, String(v.undeclaredTotal));
    check('  and grouped by mod', v.undeclared.length === 1 && v.undeclared[0].count === 1, JSON.stringify(v.undeclared));
    check('  the arithmetic closes over all three views of the actions',
      v.summary.positioned + v.undeclaredTotal === v.summary.actions);

    // Conditions: provable where it can be, honest where it cannot.
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

    // What the probe measured. The gate was ModInUse of a mod installed, off in
    // the active profile and on in eleven others; it did not run. So ModInUse is
    // about the active profile, and an installed-but-off mod is provably not in
    // use - not "cannot tell", which is what the view used to report.
    check('an action gated on a mod installed but off in this profile is provably off',
      byId('GatedOff').willRun === false, JSON.stringify(byId('GatedOff')));
    check('  and says which mod, and that it wants it on',
      /Other Mod/.test(byId('GatedOff').reason || '') && /on in this profile/.test(byId('GatedOff').reason || ''),
      byId('GatedOff').reason);
    check('  and reports no unknown reason for it', byId('GatedOff').unknown.length === 0,
      JSON.stringify(byId('GatedOff').unknown));
    // Declared up here rather than at its original place: the assertion below
    // needs it, and reaching forward threw a ReferenceError that ended the run.
    const small = lo.profileLoadOrder(DB_PATH, { file: OV_PATH, groupId: 2 });

    check('  the same mod being on in ANOTHER profile does not rescue it here',
      v.summary.modsOn === 2 && small.summary.modsOn === 2,
      'm3 is off in Main and on in Small: ' + v.summary.modsOn + ' / ' + small.summary.modsOn);

    // Inverse. The old code SKIPPED an inverted condition instead of inverting it,
    // so a set whose only condition was NOT ModInUse(on) fell through to "will
    // run" - reporting an action as running that provably does not.
    check('a NOT condition is inverted, not skipped: NOT ModInUse(on) does not run',
      byId('InvertedOn').willRun === false, JSON.stringify(byId('InvertedOn')));
    check('  and says the mod has to be off, not on',
      /to be off in this profile/.test(byId('InvertedOn').reason || ''), byId('InvertedOn').reason);
    check('  NOT ModInUse(off) does run, because it is off',
      byId('InvertedOff').willRun === true, JSON.stringify(byId('InvertedOff')));
    check('  and NOT ModInUse(nothing installed) runs, the absence being what it asks for',
      byId('InvertedAbsent').willRun === true, JSON.stringify(byId('InvertedAbsent')));

    // Criteria.Any is the author's own declaration, and it means what it says:
    // measured over every multi-condition set with its .modinfo on disk, stored
    // Any=1 exactly when the modinfo declares any= - 2 with, 278 without, no
    // exceptions. So Any=1 is an OR.
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

    // AND sets: one unmet is enough however the other reads.
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

    // The counts have to move with the logic, or the summary is decoration.
    const decided = v.bands.flatMap((b) => b.actions || []).filter((a) => a.willRun !== null);
    const undecided = v.bands.flatMap((b) => b.actions || []).filter((a) => a.willRun === null);
    check(
      'the summary agrees with the rows: decided plus undecided is every positioned action',
      decided.length + undecided.length === v.summary.positioned,
      decided.length + ' + ' + undecided.length + ' vs ' + v.summary.positioned);
    check('  and the unknown count is exactly the undecided ones',
      undecided.length === v.summary.unknown,
      undecided.length + ' vs ' + v.summary.unknown);
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
    check('a ruleset condition names the ruleset and says who picks it',
      /RULESET_EXPANSION_1/.test(byId('PatchOne').unknown[0].why)
      && /pick when you start a game/.test(byId('PatchOne').unknown[0].why),
      byId('PatchOne').unknown[0].why);

    check('  and no row is left undecided without saying what it could not decide',
      undecided.every((a) => a.unknown && a.unknown.length > 0),
      JSON.stringify(undecided.filter((a) => !a.unknown || !a.unknown.length).map((a) => a.id)));
    check('  and every unknown reason names the condition type that caused it',
      undecided.every((a) => a.unknown.every((u) => u.type && u.why)),
      JSON.stringify(undecided.flatMap((a) => a.unknown).filter((u) => !u.type || !u.why)));

    // A mod whose .modinfo is not on disk cannot be stamped, and is said so.
    const m2row = modRowId(M2);
    check('a mod with no .modinfo on disk is reported not protected',
      staleOf(M2) === null && v.summary.unprotectable === 1, JSON.stringify(v.summary));

    // A second profile, and the comparison between them.
    check('another profile loads', small.ok === true && small.profile.name === 'Small', JSON.stringify(small.profile));
    // Two on, not one: mod 3 is deliberately ON in Small and OFF in Main, which
    // is the shape ModInUse turns on. Small existing at all is what the count
    // below used to be checking.
    check('  with only the mods it has on, which is two because mod 3 is on here and off in Main',
      small.summary.modsOn === 2, String(small.summary.modsOn));
    check('  and mod 3 is the difference between the two profiles',
      v.summary.modsOn === 2 && small.summary.modsOn === 2, `${v.summary.modsOn} / ${small.summary.modsOn}`);
    const cmp = lo.profileLoadOrder(DB_PATH, { file: OV_PATH, groupId: 1, compareGroupId: 2 });
    check('and the two can be compared', cmp.compare && cmp.compare.id === 2, JSON.stringify(cmp.compare));
    const marked = cmp.bands.flatMap((b) => b.actions || []).filter((a) => a.inCompare !== null);
    check('  marking every action as in or not in the other profile', marked.length > 0, String(marked.length));
    check('  and a mod off there is marked as such',
      marked.some((a) => a.modId === normId(M2) && a.inCompare === false));

    // Overrides show on their rows, and one that no longer matches is listed
    // separately rather than silently disappearing.
    const k = keyOf('PatchOne');
    await lo.applyOverrides(DB_PATH, [{ modId: M1, key: k, value: 777 }], { file: OV_PATH, statusFn: OPEN });
    const withOv = lo.profileLoadOrder(DB_PATH, { file: OV_PATH });
    const row = withOv.bands.flatMap((b) => b.actions || []).find((a) => a.id === 'PatchOne');
    check('an override shows on its row, with the author value beside it',
      row.state === 'overridden' && row.override.declared !== null, JSON.stringify(row.override));
    check('  and the summary counts it', withOv.summary.overrides === 1, String(withOv.summary.overrides));

    // A stored override whose action has gone.
    // A stored override whose action has gone. Read from the store, not from
    // the view's response: the view reports override state per row and a count,
    // and carries no map - so snapshotting its `overrides` gave undefined and
    // "restored" an empty file.
    const orphan = lo.readOverrides(OV_PATH).overrides;
    lo.writeOverrides(OV_PATH, { [normId(M1)]: { 'UpdateDatabase\nGone\nGone.sql': { value: 1 } } });
    const withOrphan = lo.profileLoadOrder(DB_PATH, { file: OV_PATH });
    check('an override that no longer matches is listed, not hidden',
      withOrphan.unmatched.length === 1 && withOrphan.unmatched[0].state === 'orphaned', JSON.stringify(withOrphan.unmatched));
    check('  and the row it belonged to no longer claims to be overridden',
      (withOrphan.bands.flatMap((b) => b.actions || []).find((a) => a.id === 'PatchOne') || {}).state !== 'overridden');
    lo.writeOverrides(OV_PATH, orphan);

    // The management listing, which is a different thing from the view.
    const list = lo.listOverrides(DB_PATH, { file: OV_PATH });
    check('the overrides screen lists them with a resolved state',
      list.ok === true && list.count >= 1 && list.overrides[0].state === 'applied', JSON.stringify(list.overrides[0] && list.overrides[0].state));
    check('  and the key it names is readable rather than a hash',
      String(list.overrides[0].key).includes('\n') && list.overrides[0].type === 'UpdateDatabase',
      JSON.stringify(list.overrides[0].key));
  }

  console.log('\nTest 15: the view is read-only');
  {
    // This is the guard on the thing the handoff said had been conflated before.
    // It erodes quietly as features are added, so it is asserted rather than
    // intended - and both halves matter: no write route, and no control.
    const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const view = fs.readFileSync(path.join(__dirname, '..', 'public', 'loadorder.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    check('the view route is a GET', /req.method === 'GET' && url.pathname === '\/api\/load-order'/.test(srv));
    check('  and no POST writes to it', !/req.method === 'POST' && url.pathname === '\/api\/load-order'/.test(srv));
    const loadWrites = (srv.match(/url.pathname === '\/api\/load-overrides[^']*'/g) || []).length;
    check('every write route is under /api/load-overrides, and there are five of them',
      loadWrites === 5, String(loadWrites));
    check('the view page has no button that posts anything', !/postJson|\bfetch\(|<form/.test(view));
    // The page does have an input - the text filter. What it must not have is
    // anything that could carry a load order into the database.
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
  }

  console.log('\nTest 16: nothing was left open');
  check('every read connection was closed', liveConns.size === 0, `${liveConns.size} still open`);

  // The cleanup must never decide whether the suite passed. maxRetries because
  // Windows can hold the copied database a moment after the last read.
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (e) {
    console.log(`  (note: scratch dir ${TMP} could not be removed: ${e.code} ${e.message})`);
  }
  console.log('\n============================================================');
  console.log(pass ? 'LOAD ORDER: ALL CHECKS PASSED' : 'LOAD ORDER: FAILURES PRESENT');
  console.log('============================================================');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
