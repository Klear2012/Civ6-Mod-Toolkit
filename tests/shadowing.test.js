'use strict';

// Mirror of src/phase9-shadowing.js (all four suites) as node:test + node:assert.
//
// One it() per check(), seeds and expectations verbatim, so the
// check()-to-it() count gate (59) proves 1:1 cover. Run the whole file with
// `node --test tests/shadowing.test.js`, or one slice with
// `node --test --test-name-pattern="<name>" tests/shadowing.test.js`
// (this Node rejects the `-t` shorthand — always spell it out).
//
// The old script stays authoritative (dual-run); this file never replaces it
// in this change. Unlike the script's CLI flags (--contested/--winners/
// --envelope/--warnings select suites), this file seeds and runs every suite
// unconditionally against its own scratch database, so one process covers
// all 59 checks.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const shadowing = require('../src/shadowing');
const { makeTmp } = require('./helpers');

const TMP = makeTmp('civ6-shadowing-');
const DB_PATH = path.join(TMP, 'Mods.sqlite');
const WINNERS_DB = path.join(TMP, 'Winners.sqlite');
const ENVELOPE_DB = path.join(TMP, 'Envelope.sqlite');
const WARNINGS_DB = path.join(TMP, 'Warnings.sqlite');
const TAGGED_DB = path.join(TMP, 'Tagged.sqlite');

const MOD_A = 'AAAAAAAA-1111-4111-8111-111111111111'; // ships UI/Panel.lua as a file
const MOD_B = 'BBBBBBBB-2222-4222-8222-222222222222'; // replaces UI/Panel.lua via LuaReplace only
const MOD_C = 'CCCCCCCC-3333-4333-8333-333333333333'; // ships UI/Both.lua as a file
const MOD_D = 'DDDDDDDD-4444-4444-8444-444444444444'; // disabled; also ships UI/Panel.lua

function addFileAction(w, modRowId, type, id, files, properties) {
  const cr = w.prepare('INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, ?)')
    .run(modRowId, id, type).lastInsertRowid;
  for (const [name, value] of Object.entries(properties || {})) {
    w.prepare('INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, ?, ?)').run(cr, name, value);
  }
  for (const f of files) {
    let row = w.prepare('SELECT FileRowId AS id FROM ModFiles WHERE ModRowId = ? AND Path = ?').get(modRowId, f);
    if (!row) {
      row = { id: w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(modRowId, f).lastInsertRowid };
    }
    w.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId, Priority) VALUES (?, ?, 0)').run(cr, row.id);
  }
  return cr;
}

function addSettingAction(w, modRowId, type, id, files) {
  const sr = w.prepare('INSERT INTO Settings (ModRowId, SettingId, SettingType) VALUES (?, ?, ?)')
    .run(modRowId, id, type).lastInsertRowid;
  for (const f of files || []) {
    let row = w.prepare('SELECT FileRowId AS id FROM ModFiles WHERE ModRowId = ? AND Path = ?').get(modRowId, f);
    if (!row) {
      row = { id: w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(modRowId, f).lastInsertRowid };
    }
    w.prepare('INSERT INTO SettingFiles (SettingRowId, FileRowId, Priority) VALUES (?, ?, 0)').run(sr, row.id);
  }
  return sr;
}

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
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const addMod = (modId, name) => {
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(`C:/mods/${name}.modinfo`).lastInsertRowid;
    const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf, modId).lastInsertRowid;
    w.prepare("INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, 'Name', ?)").run(mid, `LOC_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_NAME`);
    w.prepare("INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, 'en_US', ?)").run(mid, `LOC_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_NAME`, name);
    return mid;
  };

  const mA = addMod(MOD_A, 'File Mod');
  const mB = addMod(MOD_B, 'Replacer Mod');
  const mC = addMod(MOD_C, 'Third Mod');
  const mD = addMod(MOD_D, 'Disabled Mod');

  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, ?)');
  item.run(mA, 0);
  item.run(mB, 0);
  item.run(mC, 0);
  item.run(mD, 1); // off in the active profile: its claims must not count

  // A ships the panel as a file.
  addFileAction(w, mA, 'AddUIScript', 'PanelShip', ['UI/Panel.lua']);
  // A alone ships this one: uncontested, must be omitted from the report.
  addFileAction(w, mA, 'AddUIScript', 'SoloShip', ['UI/Solo.lua']);
  // B replaces the panel via LuaReplace and ships NO <File> for it.
  addFileAction(w, mB, 'ReplaceUIScript', 'PanelReplace', [], { LuaContext: 'Screen', LuaReplace: 'UI/Panel.lua' });
  // File-vs-file contest as the control case.
  addFileAction(w, mB, 'AddUIScript', 'BothShipB', ['UI/Both.lua']);
  addFileAction(w, mC, 'AddUIScript', 'BothShipC', ['UI/Both.lua']);
  // Disabled mod's claim: same path, must not appear as a claimant.
  addFileAction(w, mD, 'AddUIScript', 'PanelShipD', ['UI/Panel.lua']);

  w.close();
}

describe('Test 1: contested-path enumeration (--contested)', () => {
  let contested;
  before(() => {
    seed();
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      contested = shadowing.enumerateContested(db);
    } finally {
      db.close();
    }
  });
  it('exactly the two contested paths are reported', () => {
    const paths = contested.map((c) => c.path);
    assert.ok(JSON.stringify(paths) === JSON.stringify(['UI/Both.lua', 'UI/Panel.lua']), JSON.stringify(paths));
  });
  it('UI/Panel.lua names both claimant mods', () => {
    const panel = contested.find((c) => c.path === 'UI/Panel.lua');
    const panelMods = panel ? panel.claimants.map((c) => c.modId.toLowerCase()) : [];
    assert.ok(panelMods.length === 2 && panelMods.includes(MOD_A.toLowerCase()) && panelMods.includes(MOD_B.toLowerCase()),
      JSON.stringify(panelMods));
  });
  it('the ReplaceUIScript claimant is sourced as LuaReplace', () => {
    const panel = contested.find((c) => c.path === 'UI/Panel.lua');
    const replacer = panel ? panel.claimants.find((c) => c.modId.toLowerCase() === MOD_B.toLowerCase()) : null;
    assert.ok(!!replacer && JSON.stringify(replacer.sources) === JSON.stringify(['LuaReplace']), JSON.stringify(replacer && replacer.sources));
  });
  it('the shipping claimant is sourced as file', () => {
    const panel = contested.find((c) => c.path === 'UI/Panel.lua');
    const shipper = panel ? panel.claimants.find((c) => c.modId.toLowerCase() === MOD_A.toLowerCase()) : null;
    assert.ok(!!shipper && JSON.stringify(shipper.sources) === JSON.stringify(['file']), JSON.stringify(shipper && shipper.sources));
  });
  it('the ReplaceUIScript contest side has zero ComponentFiles links', () => {
    const probe = new DatabaseSync(DB_PATH, { readOnly: true });
    let links = -1;
    try {
      links = probe.prepare(
        `SELECT count(*) AS n FROM ComponentFiles cf
           JOIN Components c ON c.ComponentRowId = cf.ComponentRowId
           JOIN Mods m ON m.ModRowId = c.ModRowId
          WHERE lower(m.ModId) = lower(?) AND c.ComponentType = 'ReplaceUIScript'`
      ).get(MOD_B).n;
    } finally {
      probe.close();
    }
    assert.equal(links, 0, `${links} links`);
  });
  it('a file-list-only scan sees UI/Panel.lua as uncontested (the gap this closes)', () => {
    const fileOnly = new DatabaseSync(DB_PATH, { readOnly: true });
    let panelFileClaimants = -1;
    try {
      panelFileClaimants = fileOnly.prepare(
        `SELECT count(DISTINCT c.ModRowId) AS n
           FROM ComponentFiles cf
           JOIN Components c ON c.ComponentRowId = cf.ComponentRowId
           JOIN ModFiles f ON f.FileRowId = cf.FileRowId
           JOIN ModGroupItems i ON i.ModRowId = c.ModRowId
          WHERE f.Path = 'UI/Panel.lua' AND i.ModGroupRowId = 1 AND i.Disabled = 0`
      ).get().n;
    } finally {
      fileOnly.close();
    }
    assert.equal(panelFileClaimants, 1, `${panelFileClaimants} file claimant(s)`);
  });
  it('the file-vs-file contest still reports both shippers as file', () => {
    const both = contested.find((c) => c.path === 'UI/Both.lua');
    const bothSources = both ? both.claimants.map((c) => c.sources.join('+')).sort() : [];
    assert.ok(JSON.stringify(bothSources) === JSON.stringify(['file', 'file']), JSON.stringify(bothSources));
  });
  it('the uncontested path is omitted', () => {
    const paths = contested.map((c) => c.path);
    assert.ok(!paths.includes('UI/Solo.lua'), JSON.stringify(paths));
  });
  it('the disabled mod is not named as a claimant', () => {
    assert.ok(!contested.some((c) => c.claimants.some((cl) => cl.modId.toLowerCase() === MOD_D.toLowerCase())),
      JSON.stringify(contested.map((c) => [c.path, c.claimants.map((cl) => cl.name)])));
  });
});

const TAG_A = 'e1e1e1e1-aaaa-4aaa-8aaa-aaaaaaaaaa11';
const TAG_B = 'e2e2e2e2-bbbb-4bbb-8bbb-bbbbbbbbbb22';
const TAG_HOLDER = 'e3e3e3e3-cccc-4ccc-8ccc-cccccccccc33';

function seedTagged(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const addTaggedMod = (modId, scannedPath, nameTag) => {
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(scannedPath).lastInsertRowid;
    const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf, modId).lastInsertRowid;
    w.prepare('INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, ?, ?)').run(mid, 'Name', nameTag);
    return mid;
  };
  const tA = addTaggedMod(TAG_A, 'C:/mods/TaggedA.modinfo', 'LOC_EXPANSION1_MOD_TITLE');
  const tB = addTaggedMod(TAG_B, 'C:/mods/TaggedB.modinfo', 'LOC_EXPANSION2_MOD_TITLE');
  const tH = addTaggedMod(TAG_HOLDER, 'C:/mods/TagHolder.modinfo', 'LOC_TAG_HOLDER_NAME');
  w.prepare("INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, 'en_US', ?)")
    .run(tH, 'LOC_TAG_HOLDER_NAME', 'Tag Holder');
  w.prepare("INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, 'en_US', ?)")
    .run(tH, 'LOC_EXPANSION1_MOD_TITLE', 'Expansion: Rise and Fall');
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const tItem = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  tItem.run(tA); tItem.run(tB); tItem.run(tH);
  addFileAction(w, tA, 'AddUIScript', 'TaggedShipA', ['UI/Tagged.lua']);
  addFileAction(w, tB, 'AddUIScript', 'TaggedShipB', ['UI/Tagged.lua']);
  w.close();
}

describe('Test 1b: tagged DLC-style claimant names resolve (no bare LOC_ tag)', () => {
  let tagged;
  before(() => {
    seedTagged(TAGGED_DB);
    const tdb = new DatabaseSync(TAGGED_DB, { readOnly: true });
    try {
      tagged = shadowing.enumerateContested(tdb);
    } finally {
      tdb.close();
    }
  });
  it('the tagged contest is enumerated with both claimants', () => {
    const tEntry = tagged.find((c) => c.path === 'UI/Tagged.lua');
    const tNames = tEntry ? tEntry.claimants.map((c) => c.name) : [];
    assert.ok(!!tEntry && tEntry.claimants.length === 2, JSON.stringify(tNames));
  });
  it('no claimant name is a bare LOC_ tag', () => {
    const tEntry = tagged.find((c) => c.path === 'UI/Tagged.lua');
    const tNames = tEntry ? tEntry.claimants.map((c) => c.name) : [];
    assert.ok(tNames.length === 2 && tNames.every((n) => !/LOC_[A-Z0-9_]+/i.test(n)), JSON.stringify(tNames));
  });
  it('cross-mod text resolves like every other screen (Expansion: Rise and Fall)', () => {
    const tEntry = tagged.find((c) => c.path === 'UI/Tagged.lua');
    const tAName = tEntry ? (tEntry.claimants.find((c) => c.modId.toLowerCase() === TAG_A.toLowerCase()) || {}).name : null;
    assert.equal(tAName, 'Expansion: Rise and Fall', JSON.stringify(tAName));
  });
  it('an unlocalised tag prettifies like every other screen (Expansion: Gathering Storm)', () => {
    const tEntry = tagged.find((c) => c.path === 'UI/Tagged.lua');
    const tBName = tEntry ? (tEntry.claimants.find((c) => c.modId.toLowerCase() === TAG_B.toLowerCase()) || {}).name : null;
    assert.equal(tBName, 'Expansion: Gathering Storm', JSON.stringify(tBName));
  });
});

const WS1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // SingleMax low (two actions: 50 + 100)
const WS2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2'; // SingleMax high (200)
const WP1 = '33333333-cccc-4ccc-8ccc-cccccccccc3'; // Partial declarer (150)
const WP2 = '44444444-dddd-4ddd-8ddd-dddddddddd4'; // Partial silent (no LoadOrder)
const WU1 = '55555555-eeee-4eee-8eee-eeeeeeeeee5'; // Undeclared one
const WU2 = '66666666-ffff-4fff-8fff-ffffffffff6'; // Undeclared two
const WT1 = '77777777-1111-4111-8111-1111111117'; // Tie filer (300, via file)
const WT2 = '88888888-2222-4222-8222-2222222228'; // Tie replacer (300, via LuaReplace only)
const WI1 = '99999999-3333-4333-8333-3333333339'; // Identical-content tie filer A (310, via file)
const WI2 = '00000000-4444-4444-8444-4444444400'; // Identical-content tie filer B (310, via file)

function seedWinners(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const ids = {};
  for (const [modId, name] of [[WS1, 'Single Low'], [WS2, 'Single High'], [WP1, 'Partial Declarer'],
      [WP2, 'Partial Silent'], [WU1, 'Undeclared One'], [WU2, 'Undeclared Two'],
      [WT1, 'Tie Filer'], [WT2, 'Tie Replacer'],
      [WI1, 'Tie Identical A'], [WI2, 'Tie Identical B']]) {
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)')
      .run(`C:/mods/${name.replace(/[^A-Za-z]+/g, '_')}.modinfo`).lastInsertRowid;
    const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)')
      .run(sf, modId).lastInsertRowid;
    ids[modId] = mid;
  }
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  for (const mid of Object.values(ids)) item.run(mid);

  addFileAction(w, ids[WS1], 'AddUIScript', 'MaxLowA', ['UI/SingleMax.lua'], { LoadOrder: '50' });
  addFileAction(w, ids[WS1], 'AddUIScript', 'MaxLowB', ['UI/SingleMax.lua'], { LoadOrder: '100' });
  addFileAction(w, ids[WS2], 'AddUIScript', 'MaxHigh', ['UI/SingleMax.lua'], { LoadOrder: '200' });
  addFileAction(w, ids[WP1], 'AddUIScript', 'PartialShip', ['UI/Partial.lua'], { LoadOrder: '150' });
  addFileAction(w, ids[WP2], 'AddUIScript', 'PartialSilent', ['UI/Partial.lua']);
  addFileAction(w, ids[WU1], 'AddUIScript', 'UndShip1', ['UI/Undeclared.lua']);
  addFileAction(w, ids[WU2], 'AddUIScript', 'UndShip2', ['UI/Undeclared.lua']);
  addFileAction(w, ids[WT1], 'AddUIScript', 'TieShip', ['UI/Tie.lua'], { LoadOrder: '300' });
  addFileAction(w, ids[WT2], 'ReplaceUIScript', 'TieReplace', [], { LuaContext: 'Screen', LuaReplace: 'UI/Tie.lua', LoadOrder: '300' });
  addFileAction(w, ids[WI1], 'AddUIScript', 'TieIdentShipA', ['UI/TieIdentical.lua'], { LoadOrder: '310' });
  addFileAction(w, ids[WI2], 'AddUIScript', 'TieIdentShipB', ['UI/TieIdentical.lua'], { LoadOrder: '310' });

  w.close();
}

describe('Test 2: winner rule - strictly-greatest declared LoadOrder wins (--winners)', () => {
  let decided;
  let byPath;
  let hashA;
  let hashB;
  before(() => {
    seedWinners(WINNERS_DB);
    const db = new DatabaseSync(WINNERS_DB, { readOnly: true });
    try {
      decided = shadowing.resolveWinners(db);
    } finally {
      db.close();
    }
    byPath = new Map(decided.map((d) => [d.path, d]));
    const identBytes = Buffer.from('-- TieIdentical fixture payload v1\n', 'utf8');
    const identA = path.join(TMP, 'TieIdentical-A.lua');
    const identB = path.join(TMP, 'TieIdentical-B.lua');
    fs.writeFileSync(identA, identBytes);
    fs.writeFileSync(identB, identBytes);
    const hashOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    hashA = hashOf(identA);
    hashB = hashOf(identB);
  });
  it('all five winner fixtures are contested', () => {
    assert.equal(decided.length, 5, `${decided.length} path(s)`);
  });
  it('single-max: strictly greatest wins with its declared value', () => {
    const single = byPath.get('UI/SingleMax.lua');
    assert.ok(!!single && single.status === 'decided' && single.winner
      && single.winner.modId.toLowerCase() === WS2.toLowerCase() && single.winner.value === 200,
      JSON.stringify(single && single.winner));
  });
  it('single-max: one mod claiming twice folds to its max (100, not 50)', () => {
    const single = byPath.get('UI/SingleMax.lua');
    const singleLow = single ? single.claimants.find((c) => c.modId.toLowerCase() === WS1.toLowerCase()) : null;
    assert.ok(!!singleLow && singleLow.value === 100, JSON.stringify(singleLow && singleLow.value));
  });
  it('single declarer is trivially the strictly greatest and wins', () => {
    const partial = byPath.get('UI/Partial.lua');
    assert.ok(!!partial && partial.status === 'decided' && partial.winner
      && partial.winner.modId.toLowerCase() === WP1.toLowerCase() && partial.winner.value === 150,
      JSON.stringify(partial && partial.winner));
  });
  it('no declared order is undefined with reason no-declared-order and no winner', () => {
    const und = byPath.get('UI/Undeclared.lua');
    assert.ok(!!und && und.status === 'undefined' && und.reason === 'no-declared-order' && und.winner === null,
      JSON.stringify(und && { status: und.status, reason: und.reason, winner: und.winner }));
  });
  it('undeclared path still names all claimants with null values', () => {
    const und = byPath.get('UI/Undeclared.lua');
    assert.ok(!!und && und.claimants.length === 2 && und.claimants.every((c) => c.value === null),
      JSON.stringify(und && und.claimants.map((c) => [c.modId.slice(0, 8), c.value])));
  });
  it('genuine tie is undefined with reason tie, shared value, and no winner', () => {
    const tie = byPath.get('UI/Tie.lua');
    const tiedIds = tie && tie.tied ? tie.tied.map((t) => t.modId.toLowerCase()).sort() : [];
    assert.ok(!!tie && tie.status === 'undefined' && tie.reason === 'tie' && tie.value === 300 && tie.winner === null
      && tiedIds.length === 2 && tiedIds.includes(WT1.toLowerCase()) && tiedIds.includes(WT2.toLowerCase()),
      JSON.stringify(tie && { status: tie.status, reason: tie.reason, value: tie.value, tied: tie.tied }));
  });
  it('tie spans file vs LuaReplace sources (rule is source-agnostic)', () => {
    const tie = byPath.get('UI/Tie.lua');
    const tieSources = tie ? tie.claimants.map((c) => c.sources.join('+')).sort() : [];
    assert.ok(JSON.stringify(tieSources) === JSON.stringify(['LuaReplace', 'file']), JSON.stringify(tieSources));
  });
  it('tied claimants are listed unranked (modId order, winner stays null)', () => {
    const tie = byPath.get('UI/Tie.lua');
    assert.ok(!!tie && tie.winner === null && tie.tied
      && JSON.stringify(tie.tied.map((t) => t.modId)) === JSON.stringify([...tie.tied.map((t) => t.modId)].sort((a, b) => (a < b ? -1 : 1))),
      JSON.stringify(tie && tie.tied));
  });
  it('identical-content tie payloads are byte-identical (scratch fixtures)', () => {
    assert.equal(hashA, hashB, `${hashA.slice(0, 12)} vs ${hashB.slice(0, 12)}`);
  });
  it('identical content still undefined with reason tie and no winner', () => {
    const tieIdent = byPath.get('UI/TieIdentical.lua');
    const tieIdentIds = tieIdent && tieIdent.tied ? tieIdent.tied.map((t) => t.modId.toLowerCase()).sort() : [];
    assert.ok(!!tieIdent && tieIdent.status === 'undefined' && tieIdent.reason === 'tie' && tieIdent.value === 310 && tieIdent.winner === null
      && tieIdentIds.length === 2 && tieIdentIds.includes(WI1.toLowerCase()) && tieIdentIds.includes(WI2.toLowerCase()),
      JSON.stringify(tieIdent && { status: tieIdent.status, reason: tieIdent.reason, value: tieIdent.value, tied: tieIdent.tied }));
  });
});

const ENVELOPE_REF = {
  mods: 424, components: 3171, contested: 354,
  decidable: 35, noDeclaredOrder: 318, ties: 1, wallMs: 50,
};

function seedEnvelope(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const modRowIds = [];
  const addMod = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)');
  const addModRow = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)');
  for (let i = 0; i < ENVELOPE_REF.mods; i += 1) {
    const modId = `envelope-mod-${String(i).padStart(4, '0')}`;
    const sf = addMod.run(`C:/mods/${modId}.modinfo`).lastInsertRowid;
    modRowIds.push(addModRow.run(sf, modId).lastInsertRowid);
  }
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const addItem = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  for (const mid of modRowIds) addItem.run(mid);

  const addComp = w.prepare("INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, 'AddUIScript')");
  const addProp = w.prepare('INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, ?, ?)');
  const addFile = w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)');
  const addLink = w.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId, Priority) VALUES (?, ?, 0)');
  let seq = 0;
  const claim = (modIdx, uiPath, loadOrder) => {
    const cr = addComp.run(modRowIds[modIdx], `Env${seq}`).lastInsertRowid;
    seq += 1;
    if (loadOrder != null) addProp.run(cr, 'LoadOrder', String(loadOrder));
    const fr = addFile.run(modRowIds[modIdx], uiPath).lastInsertRowid;
    addLink.run(cr, fr);
  };

  w.exec('BEGIN');
  try {
    for (let i = 0; i < ENVELOPE_REF.contested; i += 1) {
      const uiPath = `UI/Contested${String(i).padStart(4, '0')}.lua`;
      const a = i % ENVELOPE_REF.mods;
      const b = (i + 211) % ENVELOPE_REF.mods; // 211 is coprime to 424: always a distinct mod
      if (i < ENVELOPE_REF.decidable) {
        claim(a, uiPath, 100); // strictly-greatest loser side
        claim(b, uiPath, 200 + i); // strictly-greatest winner side
      } else if (i === ENVELOPE_REF.contested - 1) {
        claim(a, uiPath, 500); // genuine tie: shared max
        claim(b, uiPath, 500);
      } else {
        claim(a, uiPath, null); // no claimant declares order
        claim(b, uiPath, null);
      }
    }
    const filler = ENVELOPE_REF.components - ENVELOPE_REF.contested * 2;
    for (let k = 0; k < filler; k += 1) {
      claim(k % ENVELOPE_REF.mods, `UI/Solo${String(k).padStart(4, '0')}.lua`, null);
    }
    w.exec('COMMIT');
  } catch (e) {
    try { w.exec('ROLLBACK'); } catch (_) { /* already failed */ }
    throw e;
  }
  w.close();
}

describe('Test 3: enumeration envelope over the reference-scale corpus (--envelope)', () => {
  let env;
  let lim;
  let limEntry;
  let limSources;
  before(() => {
    seedEnvelope(ENVELOPE_DB);
    const db = new DatabaseSync(ENVELOPE_DB, { readOnly: true });
    try {
      env = shadowing.buildEnvelope(db);
    } finally {
      db.close();
    }
    const LIM_DB = path.join(TMP, 'Limits.sqlite');
    {
      const w = new DatabaseSync(LIM_DB);
      w.exec('CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ModId TEXT NOT NULL);'
        + 'CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);'
        + 'CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));'
        + 'CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);'
        + 'CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));');
      const mF = w.prepare('INSERT INTO Mods (ModId) VALUES (?)').run('lim-filer-0001').lastInsertRowid;
      const mR = w.prepare('INSERT INTO Mods (ModId) VALUES (?)').run('lim-replacer-0002').lastInsertRowid;
      addFileAction(w, mF, 'AddUIScript', 'LimShip', ['UI/Lim.lua']);
      addFileAction(w, mR, 'ReplaceUIScript', 'LimReplace', [], { LuaContext: 'Screen', LuaReplace: 'UI/Lim.lua' });
      w.close();
    }
    const ldb = new DatabaseSync(LIM_DB, { readOnly: true });
    try { lim = shadowing.resolveWinners(ldb); } finally { ldb.close(); }
    limEntry = lim.find((d) => d.path === 'UI/Lim.lua');
    limSources = limEntry ? limEntry.claimants.map((c) => c.sources.join('+')).sort() : [];
  });
  it('envelope scans the reference-scale corpus (mods)', () => {
    assert.equal(env.mods, ENVELOPE_REF.mods, `${env.mods} mods`);
  });
  it('envelope scans the reference-scale corpus (components)', () => {
    assert.equal(env.components, ENVELOPE_REF.components, `${env.components} components`);
  });
  it('envelope reports the contested count', () => {
    assert.equal(env.contested, ENVELOPE_REF.contested, `${env.contested} contested`);
  });
  it('envelope reports the decidable count', () => {
    assert.equal(env.decidable, ENVELOPE_REF.decidable, `${env.decidable} decidable`);
  });
  it('envelope reports undefined-by-reason (no-declared-order)', () => {
    assert.equal(env.noDeclaredOrder, ENVELOPE_REF.noDeclaredOrder, `${env.noDeclaredOrder} no-declared-order`);
  });
  it('envelope reports undefined-by-reason (tie)', () => {
    assert.equal(env.ties, ENVELOPE_REF.ties, `${env.ties} tie(s)`);
  });
  it('contested splits exactly into decided + undefined-by-reason', () => {
    assert.ok(env.contested === env.decidable + env.noDeclaredOrder + env.ties
      && env.undefined === env.noDeclaredOrder + env.ties,
      `${env.contested} vs ${env.decidable}+${env.noDeclaredOrder}+${env.ties}`);
  });
  it('enumeration stays interactive (same order as the ~50ms reference)', () => {
    assert.ok(env.wallClockMs < 1000, `${env.wallClockMs}ms`);
  });
  it('the gate contests exactly the LuaReplace path', () => {
    assert.ok(lim.length === 1 && !!limEntry, `${lim.length} path(s)`);
  });
  it('claimants span file and LuaReplace sources', () => {
    assert.ok(JSON.stringify(limSources) === JSON.stringify(['LuaReplace', 'file']), JSON.stringify(limSources));
  });
  it('an undeclared LuaReplace contest is undefined with reason no-declared-order', () => {
    assert.ok(!!limEntry && limEntry.status === 'undefined' && limEntry.reason === 'no-declared-order' && limEntry.winner === null);
  });
});

const MP_A = 'a1a1a1a1-1111-4111-8111-1111111111a1'; // Pair Alpha: wins the .lua half
const MP_B = 'b2b2b2b2-2222-4222-8222-2222222222b2'; // Pair Beta: wins the .xml half
const MC_F = 'c3c3c3c3-3333-4333-8333-3333333333c3'; // gameplay script in a front-end action
const MC_D = 'd4d4d4d4-4444-4444-8444-4444444444d4'; // script file in a data action, data file in a script action
const MC_OK = 'e5e5e5e5-5555-4555-8555-5555555555e5'; // clean in every direction (the negative case)

function seedWarnings(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE Settings(SettingRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, SettingId TEXT, SettingType TEXT NOT NULL);
    CREATE TABLE SettingFiles(SettingRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(SettingRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const ids = {};
  for (const [modId, name] of [[MP_A, 'Pair Alpha'], [MP_B, 'Pair Beta'], [MC_F, 'Ctx Front'],
      [MC_D, 'Ctx Data'], [MC_OK, 'Ctx Clean']]) {
    const tag = `LOC_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_NAME`;
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)')
      .run(`C:/mods/${name.replace(/[^A-Za-z]+/g, '_')}.modinfo`).lastInsertRowid;
    const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)')
      .run(sf, modId).lastInsertRowid;
    w.prepare('INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, ?, ?)').run(mid, 'Name', tag);
    w.prepare('INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, ?, ?)').run(mid, tag, 'en_US', name);
    ids[modId] = mid;
  }
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  for (const mid of Object.values(ids)) item.run(mid);

  addFileAction(w, ids[MP_A], 'AddUIScript', 'PairLuaA', ['UI/Pair.lua'], { LoadOrder: '200' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'PairLuaB', ['UI/Pair.lua'], { LoadOrder: '100' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'PairXmlA', ['UI/Pair.xml'], { LoadOrder: '50' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'PairXmlB', ['UI/Pair.xml'], { LoadOrder: '300' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'SameLuaA', ['UI/Same.lua'], { LoadOrder: '200' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'SameLuaB', ['UI/Same.lua'], { LoadOrder: '100' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'SameXmlA', ['UI/Same.xml'], { LoadOrder: '200' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'SameXmlB', ['UI/Same.xml'], { LoadOrder: '100' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'TieLuaA', ['UI/TiePair.lua'], { LoadOrder: '300' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'TieLuaB', ['UI/TiePair.lua'], { LoadOrder: '300' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'TieXmlA', ['UI/TiePair.xml'], { LoadOrder: '50' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'TieXmlB', ['UI/TiePair.xml'], { LoadOrder: '400' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'QuietLuaA', ['UI/Quiet.lua']);
  addFileAction(w, ids[MP_B], 'AddUIScript', 'QuietLuaB', ['UI/Quiet.lua']);
  addFileAction(w, ids[MP_A], 'AddUIScript', 'QuietXmlA', ['UI/Quiet.xml']);
  addFileAction(w, ids[MP_B], 'AddUIScript', 'QuietXmlB', ['UI/Quiet.xml']);

  addSettingAction(w, ids[MC_F], 'AddGameplayScripts', 'FrontGame', ['Game/Front.lua']);
  addFileAction(w, ids[MC_D], 'UpdateDatabase', 'MixedData', ['data/ok.sql', 'UI/Stray.lua']);
  addFileAction(w, ids[MC_D], 'AddUIScript', 'ScriptWithSql', ['UI/ScriptWithSql.lua', 'data/stray.sql']);
  addFileAction(w, ids[MC_OK], 'UpdateDatabase', 'GoodData', ['data/good.sql']);
  addFileAction(w, ids[MC_OK], 'AddGameplayScripts', 'GoodGame', ['Game/good.lua']);
  addSettingAction(w, ids[MC_OK], 'UpdateText', 'GoodText', ['Text/good.xml']);
  addFileAction(w, ids[MC_OK], 'AddUIScript', 'GoodUI', ['UI/good.lua', 'UI/good.xml']);

  w.close();
}

describe('Test 4: Lua/XML split-brain pairing warnings (--warnings)', () => {
  let sb;
  before(() => {
    seedWarnings(WARNINGS_DB);
    const db = new DatabaseSync(WARNINGS_DB, { readOnly: true });
    try {
      const decided = shadowing.resolveWinners(db);
      sb = shadowing.detectSplitBrain(decided);
    } finally {
      db.close();
    }
  });
  it('exactly the one split pair warns', () => {
    assert.ok(sb.length === 1 && sb[0].luaPath === 'UI/Pair.lua' && sb[0].xmlPath === 'UI/Pair.xml',
      JSON.stringify(sb.map((x) => [x.luaPath, x.xmlPath])));
  });
  it('the warning names the split winners with their display names', () => {
    assert.ok(sb.length === 1 && sb[0].luaWinner.modId.toLowerCase() === MP_A.toLowerCase() && sb[0].luaWinner.name === 'Pair Alpha'
      && sb[0].xmlWinner.modId.toLowerCase() === MP_B.toLowerCase() && sb[0].xmlWinner.name === 'Pair Beta',
      JSON.stringify(sb[0] && { lua: sb[0].luaWinner, xml: sb[0].xmlWinner }));
  });
  it('the same-winner pair stays silent', () => {
    const sbText = JSON.stringify(sb);
    assert.ok(!sbText.includes('Same'), sbText);
  });
  it('the tie-decided pair stays silent (undefined side names no winner)', () => {
    const sbText = JSON.stringify(sb);
    assert.ok(!sbText.includes('TiePair'), sbText);
  });
  it('the undeclared pair stays silent', () => {
    const sbText = JSON.stringify(sb);
    assert.ok(!sbText.includes('Quiet'), sbText);
  });
});

describe('Test 5: wrong-context placement warnings (--warnings)', () => {
  let warnCtx;
  let warnAll;
  let envW;
  let sb;
  before(() => {
    if (!fs.existsSync(WARNINGS_DB)) seedWarnings(WARNINGS_DB);
    const db = new DatabaseSync(WARNINGS_DB, { readOnly: true });
    try {
      const decided = shadowing.resolveWinners(db);
      warnCtx = shadowing.detectWrongContext(db);
      warnAll = shadowing.collectWarnings(db, decided);
      sb = shadowing.detectSplitBrain(decided);
    } finally {
      db.close();
    }
    const dbw = new DatabaseSync(WARNINGS_DB, { readOnly: true });
    try {
      envW = shadowing.buildEnvelope(dbw);
    } finally {
      dbw.close();
    }
  });
  it('exactly the three misplaced files/actions warn', () => {
    assert.equal(warnCtx.length, 3,
      JSON.stringify(warnCtx.map((x) => [x.dir, x.actionType, x.files])));
  });
  it('a gameplay script in a front-end action warns with scope and action', () => {
    const front = warnCtx.find((x) => x.dir === 'gameplay-in-frontend');
    assert.ok(!!front && front.scope === 'frontend' && front.actionType === 'AddGameplayScripts'
      && front.modId.toLowerCase() === MC_F.toLowerCase() && front.name === 'Ctx Front',
      JSON.stringify(front));
  });
  it('a .lua inside a database action warns naming only the script file', () => {
    const inData = warnCtx.find((x) => x.dir === 'script-in-data-action');
    assert.ok(!!inData && inData.scope === 'ingame' && inData.actionType === 'UpdateDatabase'
      && JSON.stringify(inData.files) === JSON.stringify(['UI/Stray.lua']),
      JSON.stringify(inData && inData.files));
  });
  it('a .sql inside a script action warns naming the database file', () => {
    const inScript = warnCtx.find((x) => x.dir === 'data-in-script-action');
    assert.ok(!!inScript && inScript.actionType === 'AddUIScript'
      && JSON.stringify(inScript.files) === JSON.stringify(['data/stray.sql']),
      JSON.stringify(inScript && inScript.files));
  });
  it('the clean mod warns nowhere', () => {
    assert.ok(!warnCtx.some((x) => x.modId.toLowerCase() === MC_OK.toLowerCase()),
      JSON.stringify(warnCtx.map((x) => x.name)));
  });
  it('collectWarnings joins both layers, split-brain first', () => {
    assert.ok(warnAll.length === sb.length + warnCtx.length
      && warnAll[0].kind === 'split-brain' && warnAll.slice(1).every((x) => x.kind === 'wrong-context'),
      JSON.stringify(warnAll.map((x) => x.kind)));
  });
  it('the envelope carries the warnings', () => {
    assert.equal(envW.warnings.length, warnAll.length,
      `${envW.warnings.length} warning(s)`);
  });
  it('a nonzero warning count appends to the envelope line', () => {
    assert.ok(/pairing\/placement warning/.test(shadowing.formatEnvelope(envW)), shadowing.formatEnvelope(envW));
  });
});

describe('Zero-warning pin: the Test 1 corpus warns nowhere and keeps its envelope line', () => {
  let envZ;
  before(() => {
    // The Test 1 corpus only exists when the contested block seeded it; a
    // filtered run that skips Test 1 seeds it here instead of reading a
    // missing file — the seed is deterministic, so the state is identical.
    if (!fs.existsSync(DB_PATH)) seed();
    const dbz = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      envZ = shadowing.buildEnvelope(dbz);
    } finally {
      dbz.close();
    }
  });
  it('no warnings on the contested-only corpus', () => {
    assert.equal(envZ.warnings.length, 0,
      JSON.stringify(envZ.warnings));
  });
  it('a zero warning count leaves the envelope line byte-identical', () => {
    assert.ok(!/warning/.test(shadowing.formatEnvelope(envZ)), shadowing.formatEnvelope(envZ));
  });
});

const WARNINGS_DLC_DB = path.join(TMP, 'WarningsDlc.sqlite');
const MD_A = 'd1d1d1d1-aaaa-4aaa-8aaa-aaaaaaaaaa01'; // DLC claimant (relative ../../../DLC path)
const MD_B = 'b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbb02'; // base-game claimant (relative ../../../Base path)
const MR_R = 'c3c3c3c3-cccc-4ccc-8ccc-cccccccccc03'; // real mod (absolute .modinfo path)

function seedWarningsDlc(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));`);

  const addMod = (modId, scannedPath) => w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)')
    .run(w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(scannedPath).lastInsertRowid, modId).lastInsertRowid;
  const dlcA = addMod(MD_A, '../../../DLC/Expansion1/Expansion1.modinfo');
  const baseB = addMod(MD_B, '../../../Base/Game/BaseGame.modinfo');
  const realR = addMod(MR_R, 'C:/mods/RealMod.modinfo');
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  item.run(dlcA); item.run(baseB); item.run(realR);

  addFileAction(w, dlcA, 'AddUIScript', 'DlcLuaA', ['UI/DlcPair.lua'], { LoadOrder: '200' });
  addFileAction(w, baseB, 'AddUIScript', 'DlcLuaB', ['UI/DlcPair.lua'], { LoadOrder: '100' });
  addFileAction(w, dlcA, 'AddUIScript', 'DlcXmlA', ['UI/DlcPair.xml'], { LoadOrder: '50' });
  addFileAction(w, baseB, 'AddUIScript', 'DlcXmlB', ['UI/DlcPair.xml'], { LoadOrder: '300' });
  addFileAction(w, realR, 'AddUIScript', 'MixLuaR', ['UI/MixedPair.lua'], { LoadOrder: '200' });
  addFileAction(w, dlcA, 'AddUIScript', 'MixLuaA', ['UI/MixedPair.lua'], { LoadOrder: '100' });
  addFileAction(w, realR, 'AddUIScript', 'MixXmlR', ['UI/MixedPair.xml'], { LoadOrder: '50' });
  addFileAction(w, dlcA, 'AddUIScript', 'MixXmlA', ['UI/MixedPair.xml'], { LoadOrder: '300' });
  addFileAction(w, baseB, 'UpdateDatabase', 'DlcData', ['data/dlc.sql', 'UI/DlcStray.lua']);
  addFileAction(w, realR, 'UpdateDatabase', 'RealData', ['data/real.sql', 'UI/RealStray.lua']);

  w.close();
}

describe('Test 6: base/DLC warning silence (DLC-vs-DLC quiet, mod-vs-DLC fires) (--warnings)', () => {
  let decided;
  let byPath;
  let sbBare;
  let sb;
  let warnCtx;
  let warnAll;
  let envD;
  before(() => {
    seedWarningsDlc(WARNINGS_DLC_DB);
    const dd = new DatabaseSync(WARNINGS_DLC_DB, { readOnly: true });
    try {
      decided = shadowing.resolveWinners(dd);
      sbBare = shadowing.detectSplitBrain(decided);
      sb = shadowing.detectSplitBrain(decided, dd);
      warnCtx = shadowing.detectWrongContext(dd);
      warnAll = shadowing.collectWarnings(dd, decided);
    } finally {
      dd.close();
    }
    byPath = new Map(decided.map((d) => [d.path, d]));
    const dde = new DatabaseSync(WARNINGS_DLC_DB, { readOnly: true });
    try {
      envD = shadowing.buildEnvelope(dde);
    } finally {
      dde.close();
    }
  });
  it('all four DLC-corpus paths stay contested and decided (winner math unchanged)', () => {
    assert.ok(decided.length === 4 && decided.every((d) => d.status === 'decided'),
      JSON.stringify(decided.map((d) => [d.path, d.status])));
  });
  it('the DLC-vs-DLC halves still decide for their DLC/base winners', () => {
    const dlcLua = byPath.get('UI/DlcPair.lua');
    const dlcXml = byPath.get('UI/DlcPair.xml');
    assert.ok(!!dlcLua && dlcLua.winner.modId.toLowerCase() === MD_A.toLowerCase() && dlcLua.winner.value === 200
      && !!dlcXml && dlcXml.winner.modId.toLowerCase() === MD_B.toLowerCase() && dlcXml.winner.value === 300,
      JSON.stringify({ lua: dlcLua && dlcLua.winner, xml: dlcXml && dlcXml.winner }));
  });
  it('the mod-vs-DLC halves still decide across the real/DLC line', () => {
    const mixLua = byPath.get('UI/MixedPair.lua');
    const mixXml = byPath.get('UI/MixedPair.xml');
    assert.ok(!!mixLua && mixLua.winner.modId.toLowerCase() === MR_R.toLowerCase() && mixLua.winner.value === 200
      && !!mixXml && mixXml.winner.modId.toLowerCase() === MD_A.toLowerCase() && mixXml.winner.value === 300,
      JSON.stringify({ lua: mixLua && mixLua.winner, xml: mixXml && mixXml.winner }));
  });
  it('without the database the filter is off and both split pairs warn', () => {
    assert.equal(sbBare.length, 2, JSON.stringify(sbBare.map((x) => [x.luaPath, x.xmlPath])));
  });
  it('with the database only the mod-vs-DLC pair warns', () => {
    assert.ok(sb.length === 1 && sb[0].luaPath === 'UI/MixedPair.lua' && sb[0].xmlPath === 'UI/MixedPair.xml',
      JSON.stringify(sb.map((x) => [x.luaPath, x.xmlPath])));
  });
  it('the firing pair names the real .lua winner beside the DLC .xml winner', () => {
    assert.ok(sb.length === 1 && sb[0].luaWinner.modId.toLowerCase() === MR_R.toLowerCase()
      && sb[0].xmlWinner.modId.toLowerCase() === MD_A.toLowerCase(),
      JSON.stringify(sb[0] && { lua: sb[0].luaWinner, xml: sb[0].xmlWinner }));
  });
  it('exactly the real-mod misplacement warns (the DLC stray stays silent)', () => {
    assert.ok(warnCtx.length === 1 && warnCtx[0].dir === 'script-in-data-action'
      && warnCtx[0].modId.toLowerCase() === MR_R.toLowerCase()
      && JSON.stringify(warnCtx[0].files) === JSON.stringify(['UI/RealStray.lua']),
      JSON.stringify(warnCtx.map((x) => [x.dir, x.modId, x.files])));
  });
  it('collectWarnings joins the firing layers, split-brain first', () => {
    assert.ok(warnAll.length === 2 && warnAll[0].kind === 'split-brain' && warnAll[1].kind === 'wrong-context',
      JSON.stringify(warnAll.map((x) => x.kind)));
  });
  it('the envelope carries the two firing warnings', () => {
    assert.equal(envD.warnings.length, 2,
      `${envD.warnings.length} warning(s)`);
  });
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // Best effort: a locked handle on Windows reports here rather than silently.
  }
});
