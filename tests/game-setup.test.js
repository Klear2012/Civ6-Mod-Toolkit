'use strict';

// Mirror of src/phase-game-setup.js (Tests 1-8 of 1-15) as node:test + node:assert.
//
// One it() per check(), fixtures and expectations verbatim, so the
// check(-to-it( count gate (116) proves 1:1 cover. Run the whole file with
// `node --test tests/game-setup.test.js`, or one slice with
// `node --test --test-name-pattern="<name>" tests/game-setup.test.js`.
//
// The old script stays authoritative (dual-run); this file never replaces it
// in this change.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const setup = require('../src/gamesetup');
const { makeTmp } = require('./helpers');

const TMP = makeTmp('civ6-gamesetup-test-');
const FILE = path.join(TMP, 'game-setup.json');
const PRIOR = process.env.CIV6_GAMESETUP_FILE;
process.env.CIV6_GAMESETUP_FILE = FILE;

after(() => {
  if (PRIOR === undefined) delete process.env.CIV6_GAMESETUP_FILE;
  else process.env.CIV6_GAMESETUP_FILE = PRIOR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const put = (obj) => fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const cap = (fn, ...args) => {
  try { fn(...args); return ''; } catch (e) { return e.message; }
};
const RULESET = 'RULESET:RULESET_STANDARD';
const MODE = 'GAMEMODE:GAMEMODE_MONOPOLIES';
const CONFIG = 'CONFIG:Map/MapSize=MAPSIZE_DUEL';

describe('Test 1: no file asserts nothing', () => {
  it('a missing file reads as no assertions', () => {
    fs.rmSync(FILE, { force: true });
    assert.equal(Object.keys(setup.readSetup(FILE).asserted).length, 0);
  });
  it('  and says nothing is wrong', () => {
    fs.rmSync(FILE, { force: true });
    const v = setup.readSetup(FILE);
    assert.equal(v.error, null, String(v.error));
  });
  it('  and nothing was pruned', () => {
    fs.rmSync(FILE, { force: true });
    assert.equal(setup.readSetup(FILE).pruned, 0);
  });
  it('  and the key list is empty', () => {
    fs.rmSync(FILE, { force: true });
    assert.equal(setup.readSetup(FILE).keys.length, 0);
  });
  it('  and nothing counts as asserted', () => {
    fs.rmSync(FILE, { force: true });
    assert.ok(!setup.isAsserted(setup.readSetup(FILE), RULESET));
  });
});

describe('Test 2: empty and malformed files never take the verdicts down', () => {
  it('an empty file asserts nothing', () => {
    put('');
    assert.equal(Object.keys(setup.readSetup(FILE).asserted).length, 0);
  });
  it('a whitespace-only file asserts nothing', () => {
    put('   \n\t  ');
    assert.equal(Object.keys(setup.readSetup(FILE).asserted).length, 0);
  });
  it('  and is not reported as an error', () => {
    put('   \n\t  ');
    const blank = setup.readSetup(FILE);
    assert.equal(blank.error, null, String(blank.error));
  });
  it('a syntax error yields no assertions', () => {
    put('{ this is not json');
    assert.equal(Object.keys(setup.readSetup(FILE).asserted).length, 0);
  });
  it('  and a message saying why', () => {
    put('{ this is not json');
    const broken = setup.readSetup(FILE);
    assert.match(broken.error || '', /not valid JSON/, String(broken.error));
  });
  it('  and the file is marked unusable', () => {
    put('{ this is not json');
    assert.equal(setup.readSetup(FILE).unusable, true);
  });
  it('a JSON array is refused', () => {
    put('[1, 2, 3]');
    assert.match(setup.readSetup(FILE).error || '', /does not contain an object/);
  });
  it('an asserted value that is not an object is refused', () => {
    put({ version: 1, asserted: 'nope' });
    assert.match(setup.readSetup(FILE).error || '', /no "asserted" object/);
  });
  it('a version we did not write is refused whole', () => {
    put({ version: 99, asserted: { [RULESET]: true } });
    const future = setup.readSetup(FILE);
    assert.ok(Object.keys(future.asserted).length === 0
      && /version 99/.test(future.error || ''), String(future.error));
  });
  it('a good entry survives a bad one', () => {
    put({ version: 1, asserted: { [RULESET]: true, 'junk-without-a-kind': true, '': true, [MODE]: 'yes' } });
    const mixed = setup.readSetup(FILE);
    assert.equal(mixed.asserted[RULESET], true, JSON.stringify(mixed.asserted));
  });
  it('  and the bad ones are reported', () => {
    put({ version: 1, asserted: { [RULESET]: true, 'junk-without-a-kind': true, '': true, [MODE]: 'yes' } });
    const mixed = setup.readSetup(FILE);
    assert.match(mixed.error || '', /could not be read/, String(mixed.error));
  });
  it('  and none of the bad ones became keys', () => {
    put({ version: 1, asserted: { [RULESET]: true, 'junk-without-a-kind': true, '': true, [MODE]: 'yes' } });
    const mixed = setup.readSetup(FILE);
    assert.ok(!Object.keys(mixed.asserted).some((k) => k === 'junk-without-a-kind' || k === ''));
  });
  it('  and a half-asserted value is not kept', () => {
    put({ version: 1, asserted: { [RULESET]: true, 'junk-without-a-kind': true, '': true, [MODE]: 'yes' } });
    const mixed = setup.readSetup(FILE);
    assert.equal(mixed.asserted[MODE], undefined);
  });
  it('an unreadable path is reported, not silently empty', () => {
    fs.rmSync(FILE, { force: true });
    fs.mkdirSync(FILE);
    try {
      const unreadable = setup.readSetup(FILE);
      assert.ok(!!unreadable.error && unreadable.unusable === true);
    } finally {
      fs.rmdirSync(FILE);
    }
  });
});

describe('Test 3: keys, lists and key normalisation', () => {
  it('every asserted key reads back', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true, [CONFIG]: true } });
    const v = setup.readSetup(FILE);
    assert.ok(setup.isAsserted(v, RULESET) && setup.isAsserted(v, MODE) && setup.isAsserted(v, CONFIG));
  });
  it('the key list is sorted', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true, [CONFIG]: true } });
    const v = setup.readSetup(FILE);
    assert.equal(v.keys.join('|'), [CONFIG, MODE, RULESET].sort().join('|'), v.keys.join('|'));
  });
  it('a well-formed file reports no error', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true, [CONFIG]: true } });
    const v = setup.readSetup(FILE);
    assert.equal(v.error, null, String(v.error));
  });
  it('a key that was never asserted answers false', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true, [CONFIG]: true } });
    assert.ok(!setup.isAsserted(setup.readSetup(FILE), 'RULESET:RULESET_XP2'));
  });
  it('a hand-edit typo answers false, never throws', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true, [CONFIG]: true } });
    assert.ok(!setup.isAsserted(setup.readSetup(FILE), 'junk'));
  });
  it('a file with no version field still loads', () => {
    put({ asserted: { [RULESET]: true } });
    assert.ok(setup.isAsserted(setup.readSetup(FILE), RULESET));
  });
});

describe('Test 4: pruning options the catalog no longer lists', () => {
  it('an assertion the catalog no longer lists is dropped', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true } });
    const known = new Set([RULESET]); // the mode left the library
    const v = setup.readSetup(FILE, known);
    assert.ok(v.asserted[RULESET] === true && v.asserted[MODE] === undefined);
  });
  it('  and is counted', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true } });
    const known = new Set([RULESET]);
    const v = setup.readSetup(FILE, known);
    assert.equal(v.pruned, 1, `pruned=${v.pruned}`);
  });
  it('  and leaves the key list', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true } });
    const known = new Set([RULESET]);
    const v = setup.readSetup(FILE, known);
    assert.ok(!v.keys.includes(MODE), v.keys.join());
  });
  it('a read never writes', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true } });
    setup.readSetup(FILE, new Set([RULESET]));
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).asserted).length, 2);
  });
  it('an unvouched set prunes nothing', () => {
    put({ version: 1, asserted: { [RULESET]: true, [MODE]: true } });
    const unsure = setup.readSetup(FILE, null);
    assert.ok(Object.keys(unsure.asserted).length === 2 && unsure.pruned === 0);
  });
});

describe('Test 5: what an option key may look like', () => {
  it('surrounding space is trimmed', () => {
    assert.equal(setup.cleanKey('  RULESET:X  '), 'RULESET:X');
  });
  it('a key at the cap is kept', () => {
    assert.equal(setup.cleanKey(`RULESET:${'x'.repeat(200 - 8)}`).length, 200);
  });
  it('an over-long key is refused', () => {
    assert.match(cap(setup.cleanKey, `RULESET:${'x'.repeat(201 - 8)}`), /longer than 200/);
  });
  it('an empty key is refused', () => {
    assert.match(cap(setup.cleanKey, ''), /cannot be empty/);
  });
  it('a key with no kind is refused', () => {
    assert.match(cap(setup.cleanKey, 'just-an-id'), /KIND:value/);
  });
  it('a lowercase kind is refused', () => {
    assert.match(cap(setup.cleanKey, 'ruleset:X'), /uppercase/);
  });
  it('simpleKey uppercases the kind', () => {
    assert.equal(setup.simpleKey('ruleset', 'RULESET_STANDARD'), 'RULESET:RULESET_STANDARD');
  });
  it('simpleKey trims the id', () => {
    assert.equal(setup.simpleKey('GAMEMODE', '  GAMEMODE_MONOPOLIES '), MODE);
  });
  it('configKey joins the triple', () => {
    assert.equal(setup.configKey('Map', 'MapSize', 'MAPSIZE_DUEL'), CONFIG);
  });
  it('configKey trims each part', () => {
    assert.equal(setup.configKey(' Map ', ' MapSize ', ' MAPSIZE_DUEL '), CONFIG);
  });
  it('a bad simpleKey id is refused', () => {
    assert.match(cap(setup.simpleKey, 'RULESET', 'has space'), /unsupported character/);
  });
  it('a bad config part is refused', () => {
    assert.match(cap(setup.configKey, 'Map', 'Map Size', 'X'), /unsupported character/);
  });
  it('parseKey takes a simple key apart', () => {
    const simple = setup.parseKey(MODE);
    assert.ok(simple && simple.kind === 'GAMEMODE' && simple.id === 'GAMEMODE_MONOPOLIES', JSON.stringify(simple));
  });
  it('parseKey takes a config key apart', () => {
    const cfg = setup.parseKey(CONFIG);
    assert.ok(cfg && cfg.kind === 'CONFIG' && cfg.group === 'Map' && cfg.configId === 'MapSize' && cfg.value === 'MAPSIZE_DUEL',
      JSON.stringify(cfg));
  });
  it('parseKey answers null for junk', () => {
    assert.equal(setup.parseKey('junk'), null);
  });
});

describe('Test 6: asserting and withdrawing', () => {
  it('an assertion is written and read back', () => {
    fs.rmSync(FILE, { force: true });
    const v = setup.setOption(FILE, RULESET, true);
    assert.equal(v.asserted[RULESET], true);
  });
  it('the file appears on disk', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    assert.ok(fs.existsSync(FILE));
  });
  it('  with the version it was written as', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).version, 1);
  });
  it('  and no temp file left beside it', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    assert.ok(!fs.readdirSync(TMP).some((f) => /\.tmp-/.test(f)), fs.readdirSync(TMP).join());
  });
  it('keys are stored sorted, so the file is diffable by hand', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    setup.setOption(FILE, MODE, true);
    const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.equal(JSON.stringify(Object.keys(onDisk.asserted)), JSON.stringify([MODE, RULESET]), Object.keys(onDisk.asserted).join());
  });
  it('withdrawing leaves no entry behind', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    setup.setOption(FILE, MODE, true);
    const off = setup.setOption(FILE, RULESET, false);
    assert.ok(off.asserted[RULESET] === undefined && setup.isAsserted(off, MODE));
  });
  it('clearing asserts nothing', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    const cleared = setup.clearSetup(FILE);
    assert.ok(Object.keys(cleared.asserted).length === 0 && cleared.error === null);
  });
  it('an empty key is refused whole', () => {
    assert.match(cap(setup.setOption, FILE, '  ', true), /cannot be empty/);
  });
  it('  and nothing was written', () => {
    setup.clearSetup(FILE);
    cap(setup.setOption, FILE, '  ', true);
    assert.equal(Object.keys(setup.readSetup(FILE).asserted).length, 0);
  });
  it('two toggles to different options both survive', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    setup.setOption(FILE, MODE, true);
    const both = setup.readSetup(FILE);
    assert.ok(both.asserted[RULESET] === true && both.asserted[MODE] === true, JSON.stringify(both.asserted));
  });
});

describe('Test 7: a file that cannot be built on', () => {
  it('a toggle over a corrupt file is refused', () => {
    put('{ broken');
    const msg = cap(setup.setOption, FILE, RULESET, true);
    assert.match(msg, /not valid JSON/, msg);
  });
  it('  and the message says nothing was written', () => {
    put('{ broken');
    const msg = cap(setup.setOption, FILE, RULESET, true);
    assert.match(msg, /nothing was written/, msg);
  });
  it('  and the file is left exactly as it was', () => {
    put('{ broken');
    const before = fs.readFileSync(FILE, 'utf8');
    cap(setup.setOption, FILE, RULESET, true);
    assert.equal(fs.readFileSync(FILE, 'utf8'), before);
  });
  it('  and reads still assert nothing', () => {
    put('{ broken');
    cap(setup.setOption, FILE, RULESET, true);
    assert.equal(Object.keys(setup.readSetup(FILE).asserted).length, 0);
  });
  it('a file of the wrong version is refused the same way', () => {
    put({ version: 42, asserted: {} });
    assert.match(cap(setup.setOption, FILE, RULESET, true), /nothing was written/);
  });
  it('clearing a corrupt file is refused too', () => {
    put('{ broken');
    assert.match(cap(setup.clearSetup, FILE), /nothing was written/);
  });
  it('a file with one bad entry is still writable', () => {
    put({ version: 1, asserted: { [RULESET]: true, 'junk-without-a-kind': true } });
    const ok = setup.setOption(FILE, MODE, true);
    assert.ok(setup.isAsserted(ok, RULESET) && setup.isAsserted(ok, MODE));
  });
  it('  and the bad entry is gone from the file', () => {
    put({ version: 1, asserted: { [RULESET]: true, 'junk-without-a-kind': true } });
    setup.setOption(FILE, MODE, true);
    assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(FILE, 'utf8'))).includes('junk-without-a-kind'));
  });
});

describe('Test 8: the store file is deleted', () => {
  it('an option is asserted before the delete', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    assert.ok(setup.isAsserted(setup.readSetup(FILE), RULESET));
  });
  it('after the delete nothing is asserted', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    fs.rmSync(FILE, { force: true });
    const gone = setup.readSetup(FILE);
    assert.ok(!setup.isAsserted(gone, RULESET) && gone.keys.length === 0);
  });
  it('  and the absence itself is not an error', () => {
    fs.rmSync(FILE, { force: true });
    setup.setOption(FILE, RULESET, true);
    fs.rmSync(FILE, { force: true });
    const gone = setup.readSetup(FILE);
    assert.equal(gone.error, null, String(gone.error));
  });
});

describe('Test 9: global scope and no game writes', () => {
  it('the default file is game-setup.json beside the store', () => {
    delete process.env.CIV6_GAMESETUP_FILE;
    try {
      const def = setup.gameSetupFile();
      assert.equal(path.basename(def), 'game-setup.json', def);
    } finally {
      process.env.CIV6_GAMESETUP_FILE = FILE;
    }
  });
  it('  next to mod-labels.json, not in a profile dir', () => {
    delete process.env.CIV6_GAMESETUP_FILE;
    try {
      const def = setup.gameSetupFile();
      assert.equal(path.dirname(def), path.dirname(path.join(__dirname, '..', 'mod-labels.json')), def);
    } finally {
      process.env.CIV6_GAMESETUP_FILE = FILE;
    }
  });
  it('  and the path is overridable for tests', () => {
    process.env.CIV6_GAMESETUP_FILE = FILE;
    assert.equal(setup.gameSetupFile(), FILE);
  });
  it('no function takes a profile', () => {
    assert.ok(!/profile/i.test(
      setup.setOption.toString() + setup.readSetup.toString() + setup.clearSetup.toString()));
  });
  it('the module names sqlite only for the read-only catalog table list', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'gamesetup.js'), 'utf8');
    assert.ok(!/sqlite/i.test(src.replace(/sqlite_master/gi, '')), (src.match(/sqlite/gi) || []).join());
  });
  it('  nor the game database by name', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'gamesetup.js'), 'utf8');
    assert.ok(!/Mods\.sqlite|DebugGameplay|DebugConfiguration/.test(src));
  });
  it('  nor writes one with SQL', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'gamesetup.js'), 'utf8');
    assert.ok(!/INSERT INTO|UPDATE |DELETE FROM/.test(src));
  });
  it('  and writes only through the shared atomic writer', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'gamesetup.js'), 'utf8');
    assert.ok(/atomicWrite\(file, JSON\.stringify/.test(src));
  });
});

const { DatabaseSync } = require('node:sqlite');
const LIB = path.join(TMP, 'Lib.sqlite');
const LIB_TXT = path.join(TMP, 'LibText.sqlite');
const LIB_OR = path.join(TMP, 'LibOr.sqlite');

function seedMainLib() {
  fs.rmSync(LIB, { force: true });
  const seed = new DatabaseSync(LIB);
  seed.exec(`CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  const comp = (id) => seed.prepare("INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (1, ?, 'UpdateDatabase')").run(id).lastInsertRowid;
  const gateNew = (compId, type, inverse, props) => {
    const s = seed.prepare("INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (1, 'C', 0)").run().lastInsertRowid;
    const c = seed.prepare('INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, ?)').run(s, type, inverse).lastInsertRowid;
    for (const [n, v] of props) seed.prepare('INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, ?, ?)').run(c, n, v);
    seed.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(compId, s);
    return s;
  };
  const rs = gateNew(comp('A'), 'RuleSetInUse', 0, [['Value', 'RULESET_EXPANSION_2']]);
  gateNew(comp('B'), 'RuleSetInUse', 0, [['Value', 'RULESET_EXPANSION_2']]);
  gateNew(comp('C'), 'ConfigurationValueMatches', 0, [['Group', 'Game'], ['ConfigurationId', 'GAMEMODE_MONOPOLIES'], ['Value', '1']]);
  gateNew(comp('D'), 'ConfigurationValueMatches', 0, [['Group', 'Map'], ['ConfigurationId', 'MapSize'], ['Value', 'MAPSIZE_DUEL']]);
  gateNew(comp('E'), 'GameCoreInUse', 0, [['Value', 'Expansion1']]);
  gateNew(comp('F'), 'LeaderPlayable', 0, [['Value', 'LEADER_ALEXANDER_MACEDON']]);
  gateNew(comp('G'), 'ModInUse', 0, [['Value', 'AAAAAAAA-1111-4111-8111-111111111111']]);
  gateNew(comp('H'), 'RuleSetInUse', 1, [['Value', 'RULESET_STANDARD']]);
  gateNew(comp('I'), 'ConfigurationValueMatches', 0, [['ConfigurationId', 'MapSize'], ['Value', 'MAPSIZE_DUEL']]);
  { // a set nothing points at gates nothing, whatever it names
    const s = seed.prepare("INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (1, 'Orphan', 0)").run().lastInsertRowid;
    const c = seed.prepare('INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, 0)').run(s, 'RuleSetInUse').lastInsertRowid;
    seed.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, 'Value', 'RULESET_ORPHAN')").run(c);
  }
  seed.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (9999, ?)').run(rs);
  seed.close();
}

function seedTextLib() {
  fs.rmSync(LIB_TXT, { force: true });
  const seed = new DatabaseSync(LIB_TXT);
  // ComponentCriteria.CriteriaRowId declared TEXT, exactly like the live
  // Mods.sqlite; every other id column stays INTEGER. Integer set ids bound
  // into a TEXT-affinity column come back as strings, while Criterion hands
  // the same ids back as numbers - the split that once emptied the panel.
  seed.exec(`CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId TEXT NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  const a = seed.prepare("INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (1, 'A', 'UpdateDatabase')").run().lastInsertRowid;
  const s = seed.prepare("INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (1, 'C', 0)").run().lastInsertRowid;
  const c = seed.prepare("INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, 'RuleSetInUse', 0)").run(s).lastInsertRowid;
  seed.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, 'Value', 'RULESET_STANDARD')").run(c);
  seed.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(a, s);
  seed.close();
}

function seedOrLib() {
  fs.rmSync(LIB_OR, { force: true });
  const seed = new DatabaseSync(LIB_OR);
  seed.exec(`CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  const comp = (id) => seed.prepare("INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (1, ?, 'UpdateDatabase')").run(id).lastInsertRowid;
  const gateNew = (compIds, type, props) => {
    const s = seed.prepare("INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (1, 'C', 0)").run().lastInsertRowid;
    const c = seed.prepare('INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, 0)').run(s, type).lastInsertRowid;
    for (const [n, v] of props) seed.prepare('INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, ?, ?)').run(c, n, v);
    for (const compId of compIds) seed.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(compId, s);
  };
  // Two actions share one comma-listed set: each single counts both.
  gateNew([comp('A'), comp('A2')], 'RuleSetInUse', [['Value', 'RULESET_STANDARD, RULESET_EXPANSION_1']]);
  gateNew([comp('B')], 'GameCoreInUse', [['Value', 'Expansion1,Expansion2']]);
  gateNew([comp('C')], 'LeaderPlayable', [['Value', 'Players:StandardPlayers::LEADER_X,StandardPlayers::LEADER_Y']]);
  gateNew([comp('D')], 'RuleSetInUse', [['Value', 'RULESET_OK, has space']]);
  gateNew([comp('E')], 'RuleSetInUse', [['Value', 'has space']]);
  gateNew([comp('F')], 'RuleSetInUse', [['Value', 'RULESET_SOLO,, ']]);
  seed.close();
}

describe('Test 10: catalog matches the library, nothing more', () => {
  const { before } = require('node:test');
  before(() => { seedMainLib(); });
  it('mining reports no error', () => {
    const lib = new DatabaseSync(LIB);
    const { error } = setup.buildCatalog(lib);
    lib.close();
    assert.equal(error, null, String(error));
  });
  it('the catalog holds exactly the referenced options', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.equal(JSON.stringify([...byKey.keys()].sort()), JSON.stringify([
      'CONFIG:Map/MapSize=MAPSIZE_DUEL',
      'CORE:Expansion1',
      'GAMEMODE:GAMEMODE_MONOPOLIES',
      'LEADER:LEADER_ALEXANDER_MACEDON',
      'RULESET:RULESET_EXPANSION_2',
      'RULESET:RULESET_STANDARD',
    ]), [...byKey.keys()].sort().join());
  });
  it('a value two actions share counts both', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const counts = {};
    for (const o of options) counts[o.key] = o.count;
    assert.equal(counts['RULESET:RULESET_EXPANSION_2'], 2, JSON.stringify(counts));
  });
  it('  and single-gated options count one', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const counts = {};
    for (const o of options) counts[o.key] = o.count;
    assert.ok(counts['GAMEMODE:GAMEMODE_MONOPOLIES'] === 1 && counts['CONFIG:Map/MapSize=MAPSIZE_DUEL'] === 1
      && counts['CORE:Expansion1'] === 1 && counts['LEADER:LEADER_ALEXANDER_MACEDON'] === 1
      && counts['RULESET:RULESET_STANDARD'] === 1, JSON.stringify(counts));
  });
  it('an inverted reference still lists its value', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(byKey.has('RULESET:RULESET_STANDARD'));
  });
  it('a set nothing points at lists nothing', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(![...byKey.keys()].some((k) => k.includes('ORPHAN')));
  });
  it('a link to a missing action inflates no count', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const counts = {};
    for (const o of options) counts[o.key] = o.count;
    assert.equal(counts['RULESET:RULESET_EXPANSION_2'], 2);
  });
  it('mining never writes the library', () => {
    const beforeBytes = fs.readFileSync(LIB);
    const lib = new DatabaseSync(LIB);
    setup.buildCatalog(lib);
    lib.close();
    const afterBytes = fs.readFileSync(LIB);
    assert.ok(beforeBytes.equals(afterBytes));
  });
});

describe('Test 11: names, order and references', () => {
  const { before } = require('node:test');
  before(() => { seedMainLib(); });
  it('ids read as words', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const names = {};
    for (const o of options) names[o.key] = o.name;
    assert.ok(names['RULESET:RULESET_EXPANSION_2'] === 'Expansion 2'
      && names['GAMEMODE:GAMEMODE_MONOPOLIES'] === 'Monopolies'
      && names['LEADER:LEADER_ALEXANDER_MACEDON'] === 'Alexander Macedon'
      && names['CORE:Expansion1'] === 'Expansion 1', JSON.stringify(names));
  });
  it('a config triple reads as option = value', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const names = {};
    for (const o of options) names[o.key] = o.name;
    assert.equal(names['CONFIG:Map/MapSize=MAPSIZE_DUEL'], 'Map Size = Duel', JSON.stringify(names));
  });
  it('options run rulesets, modes, config, cores, leaders', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    assert.equal(options.map((o) => o.kind).join(), 'RULESET,RULESET,GAMEMODE,CONFIG,CORE,LEADER',
      options.map((o) => o.kind).join());
  });
  it('a config entry carries its triple', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const cfg = options.find((o) => o.kind === 'CONFIG');
    assert.ok(cfg.group === 'Map' && cfg.configId === 'MapSize' && cfg.value === 'MAPSIZE_DUEL', JSON.stringify(cfg));
  });
  it('a mode entry carries its id', () => {
    const lib = new DatabaseSync(LIB);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const mode = options.find((o) => o.kind === 'GAMEMODE');
    assert.equal(mode.id, 'GAMEMODE_MONOPOLIES', JSON.stringify(mode));
  });
  it('a junk key labels as given', () => {
    assert.equal(setup.displayName('junk'), 'junk');
  });
  it('criterionKey refuses what is not setup', () => {
    assert.ok(setup.criterionKey('ModInUse', { Value: 'X' }) === null
      && setup.criterionKey('ConfigurationValueMatches', { ConfigurationId: 'MapSize', Value: 'MAPSIZE_DUEL' }) === null
      && setup.criterionKey('RuleSetInUse', {}) === null
      && setup.criterionKey('Nope', { Value: 'X' }) === null);
  });
  it('criterionKey folds modes and keeps triples', () => {
    assert.ok(setup.criterionKey('ConfigurationValueMatches', { Group: 'Game', ConfigurationId: 'GAMEMODE_X', Value: '1' }) === 'GAMEMODE:GAMEMODE_X'
      && setup.criterionKey('ConfigurationValueMatches', { Group: 'Map', ConfigurationId: 'MapSize', Value: 'MAPSIZE_DUEL' }) === 'CONFIG:Map/MapSize=MAPSIZE_DUEL'
      && setup.criterionKey('RuleSetInUse', { Value: 'RULESET_STANDARD' }) === 'RULESET:RULESET_STANDARD');
  });
  it('missing tables mine as empty, not as failure', () => {
    const bare = new DatabaseSync(':memory:');
    const empty = setup.buildCatalog(bare);
    bare.close();
    assert.ok(empty.options.length === 0 && empty.error === null);
  });
  it('no database mines as empty with a reason', () => {
    const noDb = setup.buildCatalog(null);
    assert.ok(noDb.options.length === 0 && !!noDb.error, String(noDb.error));
  });
});

describe('Test 12: catalog-driven pruning', () => {
  const { before } = require('node:test');
  before(() => { seedMainLib(); });
  it('an assertion still in the library survives', () => {
    const lib = new DatabaseSync(LIB);
    const known = new Set(setup.buildCatalog(lib).options.map((o) => o.key));
    lib.close();
    put({ version: 1, asserted: { 'RULESET:RULESET_EXPANSION_2': true, 'RULESET:RULESET_GONE': true } });
    const v = setup.readSetup(FILE, known);
    assert.equal(v.asserted['RULESET:RULESET_EXPANSION_2'], true);
  });
  it('  and one that left it is pruned and counted', () => {
    const lib = new DatabaseSync(LIB);
    const known = new Set(setup.buildCatalog(lib).options.map((o) => o.key));
    lib.close();
    put({ version: 1, asserted: { 'RULESET:RULESET_EXPANSION_2': true, 'RULESET:RULESET_GONE': true } });
    const v = setup.readSetup(FILE, known);
    assert.ok(v.asserted['RULESET:RULESET_GONE'] === undefined && v.pruned === 1);
  });
});

describe('Test 13: TEXT-affinity linkage still yields options', () => {
  const { before } = require('node:test');
  before(() => { seedTextLib(); });
  it('the fixture reproduces the live affinity split (text vs integer)', () => {
    const probe = new DatabaseSync(LIB_TXT, { readOnly: true });
    const linkType = probe.prepare('SELECT typeof(CriteriaRowId) AS t FROM ComponentCriteria LIMIT 1').get().t;
    const critType = probe.prepare('SELECT typeof(CriteriaRowId) AS t FROM Criterion LIMIT 1').get().t;
    probe.close();
    assert.ok(linkType === 'text' && critType === 'integer', `${linkType} vs ${critType}`);
  });
  it('mining reports no error', () => {
    const lib = new DatabaseSync(LIB_TXT);
    const { error } = setup.buildCatalog(lib);
    lib.close();
    assert.equal(error, null, String(error));
  });
  it('the linked option is mined despite the affinity split', () => {
    const lib = new DatabaseSync(LIB_TXT);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    assert.ok(options.length === 1 && options[0].key === 'RULESET:RULESET_STANDARD' && options[0].count === 1,
      JSON.stringify(options));
  });
});

describe('Test 14: comma lists split into single options', () => {
  const { before } = require('node:test');
  before(() => { seedOrLib(); });
  it('mining reports no error', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { error } = setup.buildCatalog(lib);
    lib.close();
    assert.equal(error, null, String(error));
  });
  it('a spaced comma list yields both singles', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(byKey.has('RULESET:RULESET_STANDARD') && byKey.has('RULESET:RULESET_EXPANSION_1'),
      [...byKey.keys()].sort().join());
  });
  it('each single counts every action naming it', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(byKey.get('RULESET:RULESET_STANDARD').count === 2 && byKey.get('RULESET:RULESET_EXPANSION_1').count === 2,
      JSON.stringify([...byKey.values()].map((o) => `${o.key}=${o.count}`)));
  });
  it('a game-core list yields both cores', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(byKey.get('CORE:Expansion1').count === 1 && byKey.get('CORE:Expansion2').count === 1);
  });
  it('a per-slot leader list yields both leader tails', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(byKey.has('LEADER:LEADER_X') && byKey.has('LEADER:LEADER_Y'), [...byKey.keys()].sort().join());
  });
  it('no raw list or slot prefix becomes an option', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(![...byKey.keys()].some((k) => /[, ]/.test(k) || k.includes('Players')), [...byKey.keys()].sort().join());
  });
  it('a mixed list keeps the good single and drops the junk', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(byKey.has('RULESET:RULESET_OK') && ![...byKey.keys()].some((k) => k.includes('has space')));
  });
  it('a junk-only row yields nothing', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(![...byKey.keys()].some((k) => k.includes('space')));
  });
  it('trailing empties yield just the single', () => {
    const lib = new DatabaseSync(LIB_OR);
    const { options } = setup.buildCatalog(lib);
    lib.close();
    const byKey = new Map(options.map((o) => [o.key, o]));
    assert.ok(byKey.has('RULESET:RULESET_SOLO'));
  });
});

describe('Test 15: criterionKeys splits, criterionKey stays first-or-null', () => {
  it('comma input yields one key per single', () => {
    assert.equal(JSON.stringify(setup.criterionKeys('RuleSetInUse', { Value: 'RULESET_A,RULESET_B' })),
      JSON.stringify(['RULESET:RULESET_A', 'RULESET:RULESET_B']));
  });
  it('surrounding space is trimmed and empties dropped', () => {
    assert.equal(JSON.stringify(setup.criterionKeys('RuleSetInUse', { Value: ' RULESET_A ,, RULESET_B ' })),
      JSON.stringify(['RULESET:RULESET_A', 'RULESET:RULESET_B']));
  });
  it('leader singles reduce to their tails', () => {
    assert.equal(JSON.stringify(setup.criterionKeys('LeaderPlayable', { Value: 'Players:StandardPlayers::LEADER_X,StandardPlayers::LEADER_Y' })),
      JSON.stringify(['LEADER:LEADER_X', 'LEADER:LEADER_Y']));
  });
  it('a bare leader still maps as before', () => {
    assert.equal(JSON.stringify(setup.criterionKeys('LeaderPlayable', { Value: 'LEADER_ALEXANDER_MACEDON' })),
      JSON.stringify(['LEADER:LEADER_ALEXANDER_MACEDON']));
  });
  it('junk singles are refused one by one', () => {
    assert.ok(JSON.stringify(setup.criterionKeys('RuleSetInUse', { Value: 'RULESET_OK, has space,,' }))
      === JSON.stringify(['RULESET:RULESET_OK'])
      && setup.criterionKeys('RuleSetInUse', { Value: 'has space' }).length === 0);
  });
  it('config comma values split the triple', () => {
    assert.equal(JSON.stringify(setup.criterionKeys('ConfigurationValueMatches', { Group: 'Map', ConfigurationId: 'MapSize', Value: 'MAPSIZE_DUEL,MAPSIZE_TINY' })),
      JSON.stringify(['CONFIG:Map/MapSize=MAPSIZE_DUEL', 'CONFIG:Map/MapSize=MAPSIZE_TINY']));
  });
  it('criterionKey answers the first single', () => {
    assert.equal(setup.criterionKey('RuleSetInUse', { Value: 'RULESET_A,RULESET_B' }), 'RULESET:RULESET_A');
  });
  it('criterionKey still answers null for junk and non-setup', () => {
    assert.ok(setup.criterionKey('RuleSetInUse', { Value: 'has space' }) === null
      && setup.criterionKey('ModInUse', { Value: 'X' }) === null
      && setup.criterionKey('RuleSetInUse', {}) === null);
  });
  it('splitCommaList splits, trims and drops empties', () => {
    assert.ok(JSON.stringify(setup.splitCommaList(' a ,,b, ')) === JSON.stringify(['a', 'b'])
      && setup.splitCommaList(null).length === 0);
  });
  it('leaderTail takes the tail after the last slot separator', () => {
    assert.ok(setup.leaderTail('Players:StandardPlayers::LEADER_X') === 'LEADER_X'
      && setup.leaderTail('LEADER_X') === 'LEADER_X');
  });
});
