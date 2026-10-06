'use strict';

// Suite for static packaging checks (cut over from src/phase10-packaging.js, Tests 1-5).
//
// One it() per check(), fixtures and expectations verbatim, so the
// check()-to-it() count gate (73) proves 1:1 cover. Run the whole file with
// `node --test tests/packaging.test.js`, or one slice with
// `node --test --test-name-pattern="<name>" tests/packaging.test.js`
// (this Node rejects the `-t` shorthand — always spell it out).
//
// Cut over in cutover-gate-to-node-test: the phase script is deleted and
// this file is authoritative.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const iconv = require('iconv-lite');
const packaging = require('../src/packaging');
const { makeTmp } = require('./helpers');

const TMP = makeTmp('civ6-packaging-');
const FILES_DB = path.join(TMP, 'PackFiles.sqlite');
const SCHEMA_DB = path.join(TMP, 'PackSchema.sqlite');
const DUP_DB = path.join(TMP, 'PackDup.sqlite');
const XML_DB = path.join(TMP, 'PackXml.sqlite');

const slash = (p) => String(p).replace(/\\/g, '/');

const SCHEMA = `CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
  CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
  CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
  CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
  CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
  CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
  CREATE TABLE Settings(SettingRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, SettingId TEXT, SettingType TEXT NOT NULL);
  CREATE TABLE SettingFiles(SettingRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(SettingRowId, FileRowId));
  CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
  CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`;

function addMod(w, modId, recordedPath, name) {
  const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(recordedPath).lastInsertRowid;
  const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf, modId).lastInsertRowid;
  const tag = `LOC_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_NAME`;
  w.prepare('INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, ?, ?)').run(mid, 'Name', tag);
  w.prepare('INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, ?, ?)').run(mid, tag, 'en_US', name);
  return mid;
}

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

function addUnlinkedFile(w, modRowId, file) {
  w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(modRowId, file);
}

function makeModFolder(name, files) {
  const dir = path.join(TMP, 'mods', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.modinfo`), `<Mod id="fixture" version="1"><Properties><Name>${name}</Name></Properties></Mod>\n`);
  for (const f of files) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `-- fixture ${f}\n`);
  }
  return slash(dir);
}

function readOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

const MOD_ALPHA = 'aaaaaaaa-1111-4111-8111-111111111111';
const MOD_CLEAN = 'bbbbbbbb-2222-4222-8222-222222222222';
const MOD_FDLC = 'cccccccc-3333-4333-8333-333333333333';

describe('Test 1: files no action references', () => {
  let folders;
  let findings;
  let alphaFolder;
  let mA;
  let mD;
  before(() => {
    alphaFolder = makeModFolder('PackAlpha', ['Data/used.sql', 'Data/dead.sql', 'UI/Ghost.lua', 'Extra.sql',
      'UI/Extra2.lua', 'Art/unused.artdef', 'MacOS/BLPs/texture.blp', 'Audio/boom.wem', 'Models/unit.fbx', 'Data/readme.txt']);
    const cleanFolder = makeModFolder('PackClean', ['ok.sql']);
    const w = new DatabaseSync(FILES_DB);
    w.exec(SCHEMA);
    mA = addMod(w, MOD_ALPHA, `${alphaFolder}/PackAlpha.modinfo`, 'Pack Alpha');
    const mC = addMod(w, MOD_CLEAN, `${cleanFolder}/PackClean.modinfo`, 'Pack Clean');
    mD = addMod(w, MOD_FDLC, '../../../DLC/Pack/Pack.modinfo', 'Pack DLC');
    addFileAction(w, mA, 'UpdateDatabase', 'Main', ['Data/used.sql']);
    addFileAction(w, mA, 'ReplaceUIScript', 'GhostRep', [], { LuaContext: 'Screen', LuaReplace: 'UI/Ghost.lua' });
    addUnlinkedFile(w, mA, 'Data/dead.sql');
    addUnlinkedFile(w, mA, 'UI/Ghost.lua');
    addUnlinkedFile(w, mA, 'Art/unused.artdef');
    addFileAction(w, mC, 'UpdateDatabase', 'Main', ['ok.sql']);
    addUnlinkedFile(w, mD, 'dlc-dead.sql');
    w.close();

    const db = readOnly(FILES_DB);
    try {
      folders = packaging.modFolders(db);
      findings = packaging.detectUnregisteredFiles(db);
    } finally {
      db.close();
    }
  });
  it('the mod folder resolves like the mod manager (dirname of the recorded path)', () => {
    assert.ok(folders.get(mA).folder === alphaFolder && folders.get(mA).kind === 'local',
      JSON.stringify(folders.get(mA)));
  });
  it('DLC paths classify as DLC, not local', () => {
    assert.equal(folders.get(mD).kind, 'dlc');
  });
  it('exactly the three loadable orphans warn', () => {
    assert.ok(findings.length === 3 && findings.every((f) => f.kind === 'unregistered-file'),
      JSON.stringify(findings.map((f) => f.file)));
  });
  it('a listed-but-unused file warns with the mod display name', () => {
    const dead = findings.find((f) => f.file === 'Data/dead.sql');
    assert.ok(!!dead && dead.name === 'Pack Alpha' && /no action loads it/.test(dead.reason), JSON.stringify(dead));
  });
  it('an on-disk-but-unlisted file warns with the mod display name', () => {
    const extra = findings.find((f) => f.file === 'Extra.sql');
    assert.ok(!!extra && extra.name === 'Pack Alpha' && /does not list it/.test(extra.reason), JSON.stringify(extra));
  });
  it('an on-disk-but-unlisted loadable .lua warns too', () => {
    const extra2 = findings.find((f) => f.file === 'UI/Extra2.lua');
    assert.ok(!!extra2 && extra2.name === 'Pack Alpha' && /does not list it/.test(extra2.reason), JSON.stringify(extra2));
  });
  it('engine assets stay silent in both layers (artdef, blp, audio, models, platform dirs, plain text)', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!/artdef|\.blp|\.wem|\.fbx|readme|MacOS/i.test(text), text.slice(0, 300));
  });
  it('the used file stays silent', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!text.includes('used.sql'));
  });
  it('the LuaReplace-only override stays silent (its claim lives in properties, not links)', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!text.includes('Ghost.lua'));
  });
  it('the .modinfo descriptor itself stays silent', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!/\.modinfo/.test(text));
  });
  it('the fully-used mod warns nowhere', () => {
    assert.ok(!findings.some((f) => f.modId.toLowerCase() === MOD_CLEAN.toLowerCase()));
  });
  it('the DLC row warns nowhere', () => {
    assert.ok(!findings.some((f) => f.modId.toLowerCase() === MOD_FDLC.toLowerCase()));
  });
  it('reasons use plain words (no raw tags or ids)', () => {
    assert.ok(findings.every((f) => !/LOC_[A-Z0-9_]+/i.test(f.reason) && !/[0-9a-f-]{8,}/i.test(f.reason)));
  });
});

const MOD_FRONT = 'd1d1d1d1-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const MOD_GAME = 'c3c3c3c3-cccc-4ccc-8ccc-cccccccccc03';
const MOD_SDLCA = 'd1d1d1d1-bbbb-4bbb-8bbb-bbbbbbbbbb01';

describe('Test 2: files whose tables live in the other database', () => {
  let findings;
  let collected;
  let missing;
  let missingFiles;
  let mined;
  before(() => {
    const frontFolder = makeModFolder('SchemaFront', ['Data/front-units.sql', 'Data/front-shared.sql',
      'Data/dual-units.sql', 'Data/front-loc.xml', 'Data/front-sql.xml', 'Data/script-only.sql']);
    const gameFolder = makeModFolder('SchemaGame', ['Data/game-units.sql', 'Data/game-shell.sql',
      'Data/dual-units.sql', 'Data/game-loc.xml']);
    const gameMaster = path.join(TMP, 'DebugGameplay.sqlite');
    const configMaster = path.join(TMP, 'DebugConfiguration.sqlite');
    {
      const g = new DatabaseSync(gameMaster);
      g.exec('CREATE TABLE Units (UnitType TEXT); CREATE TABLE SharedText (Tag TEXT);');
      g.close();
      const c = new DatabaseSync(configMaster);
      c.exec('CREATE TABLE ShellParams (Name TEXT); CREATE TABLE SharedText (Tag TEXT);');
      c.close();
    }
    mined = packaging.mineDebugTableSets({ gameplayFile: gameMaster, configFile: configMaster });
    const CONTENTS = {
      'Data/front-units.sql': "INSERT INTO Units (UnitType) VALUES ('U1');",
      'Data/front-shared.sql': "INSERT INTO SharedText (Tag) VALUES ('T1');",
      'Data/dual-units.sql': "INSERT INTO Units (UnitType) VALUES ('U2');",
      'Data/front-loc.xml': '<GameData><Units><Row UnitType="LX"/></Units></GameData>\n',
      'Data/front-sql.xml': "<GameData><Sql>UPDATE Units SET Cost = 1 WHERE UnitType = 'LX';</Sql></GameData>\n",
      'Data/game-units.sql': "INSERT INTO Units (UnitType) VALUES ('U3');",
      'Data/game-shell.sql': "INSERT INTO ShellParams (Name) VALUES ('P1');",
      'Data/game-loc.xml': '<GameData><SharedText><Row Tag="G1"/></SharedText></GameData>\n',
      'dlc-front.sql': "INSERT INTO Units (UnitType) VALUES ('UDLC');",
    };
    for (const [rel, content] of Object.entries(CONTENTS)) {
      for (const folder of [frontFolder, gameFolder]) {
        const full = path.join(folder, rel);
        try {
          if (fs.existsSync(full)) fs.writeFileSync(full, content);
        } catch (_) {
          // Fixture setup; the missing-file path is covered elsewhere.
        }
      }
    }

    const w = new DatabaseSync(SCHEMA_DB);
    w.exec(SCHEMA);
    const mF = addMod(w, MOD_FRONT, `${frontFolder}/SchemaFront.modinfo`, 'Schema Front');
    const mG = addMod(w, MOD_GAME, `${gameFolder}/SchemaGame.modinfo`, 'Schema Game');
    const mDA = addMod(w, MOD_SDLCA, '../../../DLC/A/A.modinfo', 'Schema Dlc');
    addSettingAction(w, mF, 'UpdateDatabase', 'FrontUnits', ['Data/front-units.sql']);
    addSettingAction(w, mF, 'UpdateDatabase', 'FrontShared', ['Data/front-shared.sql']);
    addFileAction(w, mG, 'UpdateDatabase', 'GameShared', ['Data/game-loc.xml']);
    addFileAction(w, mG, 'UpdateDatabase', 'GameUnits', ['Data/game-units.sql']);
    addFileAction(w, mG, 'UpdateDatabase', 'GameShell', ['Data/game-shell.sql']);
    addFileAction(w, mG, 'UpdateDatabase', 'GameDual', ['Data/dual-units.sql']);
    addSettingAction(w, mF, 'UpdateDatabase', 'FrontDual', ['Data/dual-units.sql']);
    addSettingAction(w, mF, 'UpdateText', 'FrontLoc', ['Data/front-loc.xml']);
    addSettingAction(w, mF, 'UpdateDatabase', 'FrontSql', ['Data/front-sql.xml']);
    addSettingAction(w, mF, 'AddUIScript', 'FrontUI', ['Data/script-only.sql']);
    addFileAction(w, mG, 'UpdateDatabase', 'GameEmpty', []);
    addSettingAction(w, mDA, 'UpdateDatabase', 'DlcFront', ['dlc-front.sql']);
    w.close();

    const schemaOpts = { gameplayTables: mined.gameplay, configTables: mined.config };
    const db = readOnly(SCHEMA_DB);
    try {
      findings = packaging.detectSchemaMismatch(db, schemaOpts);
      collected = packaging.collectPackagingWarnings(db, schemaOpts);
      missing = packaging.detectSchemaMismatch(db, { gameplayTables: null, configTables: null });
      missingFiles = packaging.detectSchemaMismatch(db, {
        debugGameplayFile: path.join(TMP, 'no-such-gameplay.sqlite'),
        debugConfigFile: path.join(TMP, 'no-such-config.sqlite'),
      });
    } finally {
      db.close();
    }
  });
  it('the miner reads both masters (gameplay-only, shared, front-end-only)', () => {
    assert.ok(!!mined.gameplay && mined.gameplay.has('units') && mined.gameplay.has('sharedtext') && !mined.gameplay.has('shellparams')
      && !!mined.config && mined.config.has('shellparams') && mined.config.has('sharedtext') && !mined.config.has('units'),
      JSON.stringify({ gameplay: [...(mined.gameplay || [])], config: [...(mined.config || [])] }));
  });
  it('the old dual-loading check is gone (no detector, no findings of its kind)', () => {
    assert.ok(packaging.detectWrongDatabase === undefined
      && findings.every((f) => f.kind !== 'wrong-database')
      && collected.every((f) => f.kind !== 'wrong-database'));
  });
  it('exactly the five misplaced files warn', () => {
    assert.ok(findings.length === 5 && findings.every((f) => f.kind === 'schema-mismatch'),
      JSON.stringify(findings.map((f) => `${f.name}:${f.file}:${f.table}`)));
  });
  it('the finding names mod, file, table, and the expected database', () => {
    const frontUnits = findings.find((f) => f.file === 'Data/front-units.sql');
    assert.ok(!!frontUnits && frontUnits.name === 'Schema Front' && frontUnits.table === 'Units'
      && frontUnits.expectedDb === 'gameplay' && frontUnits.side === 'front-end'
      && /lives in the gameplay database/.test(frontUnits.reason) && /move it into a gameplay action/.test(frontUnits.reason),
      JSON.stringify(frontUnits));
  });
  it('the mirror direction names the front-end database', () => {
    const gameShell = findings.find((f) => f.file === 'Data/game-shell.sql');
    assert.ok(!!gameShell && gameShell.name === 'Schema Game' && gameShell.table === 'ShellParams'
      && gameShell.expectedDb === 'front-end' && /move it into a front-end action/.test(gameShell.reason),
      JSON.stringify(gameShell));
  });
  it('a same-named file on both sides warns only for the misplaced copy', () => {
    const dual = findings.filter((f) => f.file === 'Data/dual-units.sql');
    assert.ok(dual.length === 1 && dual[0].name === 'Schema Front' && dual[0].side === 'front-end',
      JSON.stringify(dual.map((f) => f.name)));
  });
  it('XML table wrappers warn like SQL', () => {
    const frontLoc = findings.find((f) => f.file === 'Data/front-loc.xml');
    assert.ok(!!frontLoc && frontLoc.table === 'Units', JSON.stringify(frontLoc));
  });
  it('  including tables inside <Sql> blocks', () => {
    const frontSql = findings.find((f) => f.file === 'Data/front-sql.xml');
    assert.ok(!!frontSql && frontSql.table === 'Units', JSON.stringify(frontSql));
  });
  it('shared tables load silently on either side', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!text.includes('front-shared.sql') && !text.includes('game-loc.xml'));
  });
  it('the legit-side copies stay silent', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!findings.some((f) => f.name === 'Schema Game' && (f.file === 'Data/dual-units.sql' || f.file === 'Data/game-units.sql'))
      && !text.includes('game-units.sql'));
  });
  it('the script-typed claimant stays silent here', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!text.includes('script-only.sql'));
  });
  it('the DLC row stays silent', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!findings.some((f) => f.name === 'Schema Dlc') && !text.includes('dlc-front.sql'));
  });
  it('reasons use plain words with a what-to-do-next (no raw tags or ids)', () => {
    assert.ok(findings.every((f) => f.reason.includes(' — ') && !/LOC_[A-Z0-9_]+/i.test(f.reason) && !/[0-9a-f-]{8,}/i.test(f.reason)));
  });
  it('the formatted lines name mod, file, and table', () => {
    const text = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(findings.every((f) => text.includes(`schema-mismatch: ${f.name}: ${f.file} table ${f.table}`)));
  });
  it('a missing debug master stays silent instead of guessing', () => {
    assert.ok(missing.length === 0 && missingFiles.length === 0,
      JSON.stringify({ missing: missing.length, missingFiles: missingFiles.length }));
  });
  it('collectPackagingWarnings joins every layer (nothing else fires on this corpus)', () => {
    assert.ok(collected.length === findings.length && collected.every((f) => f.kind === 'schema-mismatch'),
      JSON.stringify(collected.map((f) => f.kind)));
  });
});

const DUP_ID = 'dddddddd-1111-4111-8111-111111111111';
const CASE_ID_UP = 'EEEEEEEE-2222-4222-8222-222222222222';
const CASE_ID_LO = 'eeeeeeee-2222-4222-8222-222222222222';
const DUP_SOLO = 'ffffffff-3333-4333-8333-333333333333';

describe('Test 3: one ModId claimed by more than one mod folder', () => {
  let findings;
  let folders;
  before(() => {
    folders = {};
    for (const name of ['DupA', 'DupB', 'DupC', 'DupD', 'DupE']) {
      folders[name] = makeModFolder(name, []);
    }
    const w = new DatabaseSync(DUP_DB);
    w.exec(SCHEMA);
    addMod(w, DUP_ID, `${folders.DupA}/DupA.modinfo`, 'Dup Alpha');
    addMod(w, DUP_ID, `${folders.DupB}/DupB.modinfo`, 'Dup Beta');
    addMod(w, CASE_ID_UP, `${folders.DupC}/DupC.modinfo`, 'Dup Gamma');
    addMod(w, CASE_ID_LO, `${folders.DupD}/DupD.modinfo`, 'Dup Delta');
    addMod(w, DUP_SOLO, `${folders.DupE}/DupE.modinfo`, 'Dup Solo');
    w.close();

    const db = readOnly(DUP_DB);
    try {
      findings = packaging.detectDuplicateModIds(db);
    } finally {
      db.close();
    }
  });
  it('exactly the two clashing ids warn', () => {
    assert.ok(findings.length === 2 && findings.every((f) => f.kind === 'duplicate-mod-id'),
      JSON.stringify(findings.map((f) => f.key)));
  });
  it('the duplicate names every claimant folder with display names', () => {
    const dup = findings.find((f) => f.key === DUP_ID.toLowerCase());
    assert.ok(!!dup && dup.claimants.length === 2
      && dup.claimants.some((c) => c.name === 'Dup Alpha' && c.folder === folders.DupA)
      && dup.claimants.some((c) => c.name === 'Dup Beta' && c.folder === folders.DupB)
      && /more than one mod folder/.test(dup.reason),
      JSON.stringify(dup && dup.claimants));
  });
  it('a case-only difference still groups (the manager key)', () => {
    const cased = findings.find((f) => f.key === CASE_ID_LO.toLowerCase());
    assert.ok(!!cased && cased.claimants.length === 2
      && cased.claimants.some((c) => c.folder === folders.DupC)
      && cased.claimants.some((c) => c.folder === folders.DupD),
      JSON.stringify(cased && cased.claimants.map((c) => c.folder)));
  });
  it('the unique id stays silent', () => {
    assert.ok(!findings.some((f) => (f.claimants || []).some((c) => c.name === 'Dup Solo')));
  });
});

const MOD_XMLGOOD = 'e1e1e1e1-1111-4111-8111-111111111101';
const MOD_XMLBAD = 'e2e2e2e2-2222-4222-8222-222222222202';
const MOD_XMLDLC = 'e3e3e3e3-3333-4333-8333-333333333303';

describe('Test 4: GameData XML lint names the offending tag', () => {
  let findings;
  let collected;
  before(() => {
    const goodFolder = makeModFolder('XmlGood', []);
    const badFolder = makeModFolder('XmlBad', []);
    const writeText = (dir, rel, text) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    };
    writeText(goodFolder, 'Data/good.xml', [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<!-- a normal database file: every block below stays silent -->',
      '<GameData>',
      '  <Types>',
      '    <Row Type="GOOD_UNIT" Kind="KIND_UNIT"/>',
      '  </Types>',
      '  <Units>',
      '    <Row UnitType="GOOD_UNIT" BaseMoves="2"/>',
      '    <Replace UnitType="GOOD_UNIT" BaseMoves="3"/>',
      '    <Update>',
      '      <Where UnitType="GOOD_UNIT"/>',
      '      <Set BaseMoves="4"/>',
      '    </Update>',
      '    <Delete UnitType="GONE_UNIT"/>',
      '    <InsertOrIgnore UnitType="GOOD_UNIT" BaseMoves="2"/>',
      '  </Units>',
      '  <Sql>UPDATE Units SET BaseMoves = 5 WHERE UnitType = \'GOOD_UNIT\';</Sql>',
      '</GameData>',
      '',
    ].join('\n'));
    writeText(goodFolder, 'Text/strings.xml',
      '<GameData><LocalizedText><Row Tag="LOC_GOOD_NAME" Language="en_US" Text="Good Mod"/></LocalizedText></GameData>\n');
    const utf16Body = '<GameData><Units><Row UnitType="U16" BaseMoves="1"/></Units></GameData>\n';
    fs.writeFileSync(path.join(goodFolder, 'Data', 'utf16.xml'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(utf16Body, 'utf16-le')]));
    writeText(goodFolder, 'Text/nested-replace.xml', [
      '<GameData>',
      '  <LocalizedText>',
      '    <Replace Tag="LOC_STEEL_DESC" Language="en_US"><Text>Forged steel description.</Text></Replace>',
      '  </LocalizedText>',
      '</GameData>',
      '',
    ].join('\n'));
    writeText(goodFolder, 'Text/nested-row.xml',
      '<GameData><LocalizedText><Row Tag="LOC_THUNDER_DESC" Language="en_US"><Text>Thunder description.</Text></Row></LocalizedText></GameData>\n');
    writeText(badFolder, 'Data/broken.xml', [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<GameData>',
      '  <Units>',
      '    <Row Type="BROKEN">',
      '  </Units>',
      '</GameData>',
      '',
    ].join('\n'));
    writeText(badFolder, 'Data/unknown.xml', [
      '<GameData>',
      '  <Units>',
      '    <Row UnitType="U1"/>',
      '    <Add UnitType="U2"/>',
      '  </Units>',
      '</GameData>',
      '',
    ].join('\n'));
    writeText(badFolder, 'Data/stray.xml', '<GameData>\n  <Row Type="LOST"/>\n</GameData>\n');
    writeText(badFolder, 'Data/empty.xml', '   \n  \n');
    writeText(badFolder, 'Data/uicontext.xml', '<Context>\n  <Box/>\n</Context>\n');
    writeText(badFolder, 'Data/nowhere.xml', '<GameData><Units><Update><Set BaseMoves="1"/></Update></Units></GameData>\n');
    writeText(badFolder, 'Data/wipe.xml', '<GameData><Units><Delete/></Units></GameData>\n');
    writeText(badFolder, 'Data/loosewhere.xml', '<GameData><Units><Where UnitType="U1"/></Units></GameData>\n');
    writeText(badFolder, 'Data/broken.sql', '<GameData><Oops>\n');
    writeText(badFolder, 'UI/layout.xml', '<Context><Box/></Context>\n');

    const w = new DatabaseSync(XML_DB);
    w.exec(SCHEMA);
    const mG = addMod(w, MOD_XMLGOOD, `${goodFolder}/XmlGood.modinfo`, 'Xml Good');
    const mB = addMod(w, MOD_XMLBAD, `${badFolder}/XmlBad.modinfo`, 'Xml Bad');
    const mD = addMod(w, MOD_XMLDLC, '../../../DLC/Xml/Xml.modinfo', 'Xml Dlc');
    addFileAction(w, mG, 'UpdateDatabase', 'GoodMain', ['Data/good.xml', 'Data/utf16.xml']);
    addFileAction(w, mG, 'UpdateText', 'GoodText', ['Text/strings.xml', 'Text/nested-replace.xml', 'Text/nested-row.xml']);
    addFileAction(w, mB, 'UpdateDatabase', 'BadMain', ['Data/broken.xml', 'Data/unknown.xml', 'Data/stray.xml',
      'Data/empty.xml', 'Data/uicontext.xml', 'Data/nowhere.xml', 'Data/wipe.xml', 'Data/loosewhere.xml',
      'Data/missing.xml', 'Data/broken.sql']);
    addFileAction(w, mB, 'AddUIScript', 'BadUI', ['UI/layout.xml']);
    addFileAction(w, mD, 'UpdateDatabase', 'DlcMain', ['Data/dlcbroken.xml']);
    w.close();

    const db = readOnly(XML_DB);
    try {
      findings = packaging.detectXmlIssues(db);
      collected = packaging.collectPackagingWarnings(db, { gameplayTables: null, configTables: null });
    } finally {
      db.close();
    }
  });
  it('exactly the seven broken database files warn', () => {
    assert.ok(findings.length === 7 && findings.every((f) => f.kind === 'xml-issue'),
      JSON.stringify(findings.map((f) => f.file)));
  });
  it('every finding names the Xml Bad display name', () => {
    assert.ok(findings.every((f) => f.name === 'Xml Bad'));
  });
  it('a mismatched close names the still-open tag with its line', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    const broken = byFile.get('Data/broken.xml');
    assert.ok(!!broken && broken.tag === 'Row' && broken.line === 5 && /still open/.test(broken.reason),
      JSON.stringify(broken));
  });
  it('an unknown command names the tag and its table with the spelling cue', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    const unknown = byFile.get('Data/unknown.xml');
    assert.ok(!!unknown && unknown.tag === 'Add' && unknown.line === 4 && /<Units>/.test(unknown.reason) && /check the spelling/.test(unknown.reason),
      JSON.stringify(unknown));
  });
  it('a row outside any table names the tag', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    const stray = byFile.get('Data/stray.xml');
    assert.ok(!!stray && stray.tag === 'Row' && stray.line === 2 && /directly under <GameData>/.test(stray.reason),
      JSON.stringify(stray));
  });
  it('a non-GameData root names the root once', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    const uicontext = byFile.get('Data/uicontext.xml');
    assert.ok(!!uicontext && uicontext.tag === 'Context' && /instead of <GameData>/.test(uicontext.reason)
      && findings.filter((f) => f.file === 'Data/uicontext.xml').length === 1,
      JSON.stringify(uicontext));
  });
  it('an Update with no Where names Update', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    const nowhere = byFile.get('Data/nowhere.xml');
    assert.ok(!!nowhere && nowhere.tag === 'Update' && /no <Where>/.test(nowhere.reason),
      JSON.stringify(nowhere));
  });
  it('a Delete with no values names Delete and the every-row risk', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    const wipe = byFile.get('Data/wipe.xml');
    assert.ok(!!wipe && wipe.tag === 'Delete' && /every row/.test(wipe.reason),
      JSON.stringify(wipe));
  });
  it('a Where outside any Update names Where', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    const loose = byFile.get('Data/loosewhere.xml');
    assert.ok(!!loose && loose.tag === 'Where' && /outside any <Update>/.test(loose.reason),
      JSON.stringify(loose));
  });
  it('valid, UTF-16, nested-Text, empty, missing, non-xml, script-loaded, and DLC files stay silent', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    const silentFiles = ['Data/good.xml', 'Data/utf16.xml', 'Text/strings.xml', 'Text/nested-replace.xml',
      'Text/nested-row.xml', 'Data/empty.xml',
      'Data/missing.xml', 'Data/broken.sql', 'UI/layout.xml', 'Data/dlcbroken.xml'];
    assert.ok(silentFiles.every((f) => !byFile.has(f)), JSON.stringify([...byFile.keys()]));
  });
  it('nested <Text> inside <Replace> stays silent (the localized-text shape the game reads)', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    assert.ok(!byFile.has('Text/nested-replace.xml'));
  });
  it('nested <Text> inside <Row> stays silent too', () => {
    const byFile = new Map(findings.map((f) => [f.file, f]));
    assert.ok(!byFile.has('Text/nested-row.xml'));
  });
  it('the clean and DLC mods warn nowhere', () => {
    assert.ok(!findings.some((f) => f.name === 'Xml Good' || f.name === 'Xml Dlc'));
  });
  it('reasons use plain words with a what-to-do-next (no raw tags or ids)', () => {
    assert.ok(findings.every((f) => f.reason.includes(' — ') && !/LOC_[A-Z0-9_]+/i.test(f.reason) && !/[0-9a-f-]{8,}/i.test(f.reason)));
  });
  it('the formatted lines name mod, file, tag, and line', () => {
    const xmlText = findings.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(findings.every((f) => xmlText.includes(`xml-issue: Xml Bad: ${f.file} <${f.tag}> (line ${f.line})`)),
      xmlText.split('\n')[0]);
  });
  it('collectPackagingWarnings joins every layer (nothing else fires on this corpus)', () => {
    assert.ok(collected.length === findings.length && collected.every((f) => f.kind === 'xml-issue'),
      JSON.stringify(collected.map((f) => f.kind)));
  });
  it('empty and comment-only texts lint to nothing', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok(lint('').length === 0 && lint('  \n ').length === 0 && lint('<!-- nothing loaded -->').length === 0);
  });
  it('plain words are not XML (names the expected root)', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok(lint('hello').length === 1 && lint('hello')[0].tag === 'GameData' && /no XML tags/.test(lint('hello')[0].reason));
  });
  it('an unclosed block names its tag', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok((() => { const r = lint('<GameData><Units>'); return r.length === 1 && r[0].tag === 'Units' && /missing/.test(r[0].reason); })());
  });
  it('a stray closing tag names itself', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok((() => { const r = lint('</Row>'); return r.length === 1 && r[0].tag === 'Row'; })());
  });
  it('twin roots fault', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok(lint('<GameData/><GameData/>').some((f) => /second top-level/.test(f.reason)));
  });
  it('a complete Update stays silent', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok(lint('<GameData><Units><Update><Where A="1"/><Set B="2"/></Update></Units></GameData>').length === 0);
  });
  it('an Update with no Set names Update', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok((() => { const r = lint('<GameData><Units><Update><Where A="1"/></Update></Units></GameData>'); return r.length === 1 && r[0].tag === 'Update' && /no <Set>/.test(r[0].reason); })());
  });
  it('an empty Set names Set', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok((() => { const r = lint('<GameData><Units><Update><Where A="1"/><Set/></Update></Units></GameData>'); return r.length === 1 && r[0].tag === 'Set'; })());
  });
  it('a misplaced Row inside an Update names Row', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok((() => { const r = lint('<GameData><Units><Update><Where A="1"/><Row B="2"/><Set C="3"/></Update></Units></GameData>'); return r.length === 1 && r[0].tag === 'Row' && /inside an <Update>/.test(r[0].reason); })());
  });
  it('a block inside a Row names the block', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok((() => { const r = lint('<GameData><Units><Row A="1"><Foo/></Row></Units></GameData>'); return r.length === 1 && r[0].tag === 'Foo'; })());
  });
  it('nested <Text> inside <Replace> lints to nothing', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok(lint('<GameData><LocalizedText><Replace Tag="LOC_X" Language="en_US"><Text>Steel description.</Text></Replace></LocalizedText></GameData>').length === 0);
  });
  it('nested <Text> inside <Row> lints to nothing', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok(lint('<GameData><LocalizedText><Row Tag="LOC_Y" Language="en_US"><Text>Row description.</Text></Row></LocalizedText></GameData>').length === 0);
  });
  it('a self-closing <Text/> inside <Replace> lints to nothing', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok(lint('<GameData><LocalizedText><Replace Tag="LOC_Z" Language="en_US"><Text/></Replace></LocalizedText></GameData>').length === 0);
  });
  it('a <Text> directly inside a table still faults', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok((() => { const r = lint('<GameData><Units><Text/></Units></GameData>'); return r.length === 1 && r[0].tag === 'Text'; })());
  });
  it('a stray < faults', () => {
    const lint = packaging.lintGameDataXml;
    assert.ok(lint('<GameData><Units>a < b<Row A="1"/></Units></GameData>').some((f) => /starts no tag/.test(f.reason)));
  });
});

const MOD_EARLY = 'f1f1f1f1-1111-4111-8111-111111111101';
const MOD_LATE = 'f2f2f2f2-2222-4222-8222-222222222202';
const MOD_FREE = 'f3f3f3f3-3333-4333-8333-333333333303';
const DUP_MIX_ID = 'f4f4f4f4-4444-4444-8444-444444444404';
const DUP_OFF_ID = 'f5f5f5f5-5555-4555-8555-555555555505';

describe('Test 5: checks cover the active profile\'s enabled mods, in load order', () => {
  let unreg;
  let schema;
  let dup;
  let xml;
  let collected;
  before(() => {
    const PROFILE_DB = path.join(TMP, 'PackProfile.sqlite');
    const PROFILE_SCHEMA = `CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete INTEGER NOT NULL, Selected INTEGER NOT NULL, SortIndex INTEGER NOT NULL);
  CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled INTEGER NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));`;
    const earlyFolder = makeModFolder('ProfEarly', ['early.sql', 'schema-early.sql']);
    const lateFolder = makeModFolder('ProfLate', ['late.sql']);
    const freeFolder = makeModFolder('ProfFree', ['free.sql']);
    const offFolder = makeModFolder('ProfOff', ['schema-off.sql', 'orphan-off.sql']);
    const offDupFolder = makeModFolder('ProfOffDup', []);
    const offD1Folder = makeModFolder('ProfOffD1', []);
    const offD2Folder = makeModFolder('ProfOffD2', []);
    const writeText = (dir, rel, text) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    };
    const brokenXml = ['<GameData>', '  <Units>', '    <Row Type="BROKEN">', '  </Units>', '</GameData>', ''].join('\n');
    writeText(lateFolder, 'broken-late.xml', brokenXml);
    writeText(offFolder, 'broken-off.xml', brokenXml);
    const profileTables = { gameplayTables: new Set(['units', 'sharedtext']), configTables: new Set(['shellparams', 'sharedtext']) };
    writeText(earlyFolder, 'schema-early.sql', "INSERT INTO ShellParams (Name) VALUES ('P1');\n");
    writeText(offFolder, 'schema-off.sql', "INSERT INTO ShellParams (Name) VALUES ('P1');\n");

    const w = new DatabaseSync(PROFILE_DB);
    w.exec(SCHEMA);
    w.exec(PROFILE_SCHEMA);
    const mEarly = addMod(w, MOD_EARLY, `${earlyFolder}/ProfEarly.modinfo`, 'Prof Early');
    const mLate = addMod(w, MOD_LATE, `${lateFolder}/ProfLate.modinfo`, 'Prof Late');
    const mFree = addMod(w, MOD_FREE, `${freeFolder}/ProfFree.modinfo`, 'Prof Free');
    const mOff = addMod(w, DUP_MIX_ID, `${offFolder}/ProfOff.modinfo`, 'Prof Off');
    const mOffDup = addMod(w, DUP_MIX_ID, `${offDupFolder}/ProfOffDup.modinfo`, 'Prof Off Dup');
    const mOffD1 = addMod(w, DUP_OFF_ID, `${offD1Folder}/ProfOffD1.modinfo`, 'Prof Off D1');
    const mOffD2 = addMod(w, DUP_OFF_ID, `${offD2Folder}/ProfOffD2.modinfo`, 'Prof Off D2');
    const gid = w.prepare("INSERT INTO ModGroups (Name, CanDelete, Selected, SortIndex) VALUES ('Active Profile', 1, 1, 0)")
      .run().lastInsertRowid;
    const flag = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (?, ?, ?)');
    flag.run(gid, mEarly, 0);
    flag.run(gid, mLate, 0);
    flag.run(gid, mFree, 0);
    flag.run(gid, mOff, 1);
    flag.run(gid, mOffDup, 0);
    flag.run(gid, mOffD1, 1);
    flag.run(gid, mOffD2, 1);
    addFileAction(w, mEarly, 'UpdateDatabase', 'E1', ['early.sql', 'schema-early.sql'], { LoadOrder: '10' });
    addUnlinkedFile(w, mEarly, 'dead-early.sql');
    addFileAction(w, mLate, 'UpdateDatabase', 'L1', ['late.sql', 'broken-late.xml'], { LoadOrder: '90' });
    addUnlinkedFile(w, mLate, 'dead-late.sql');
    addFileAction(w, mFree, 'UpdateDatabase', 'F1', ['free.sql']);
    addUnlinkedFile(w, mFree, 'dead-free.sql');
    addFileAction(w, mOff, 'UpdateDatabase', 'OffMain', ['schema-off.sql'], { LoadOrder: '5' });
    addFileAction(w, mOff, 'UpdateDatabase', 'OffXml', ['broken-off.xml']);
    addUnlinkedFile(w, mOff, 'dead-off.sql');
    w.close();

    const db = readOnly(PROFILE_DB);
    try {
      unreg = packaging.detectUnregisteredFiles(db);
      schema = packaging.detectSchemaMismatch(db, profileTables);
      dup = packaging.detectDuplicateModIds(db);
      xml = packaging.detectXmlIssues(db);
      collected = packaging.collectPackagingWarnings(db, profileTables);
    } finally {
      db.close();
    }
  });
  it('unregistered files present the enabled mods in load order (10, 90, undeclared last)', () => {
    assert.ok(JSON.stringify(unreg.map((f) => f.file)) === JSON.stringify(['dead-early.sql', 'dead-late.sql', 'dead-free.sql']),
      JSON.stringify(unreg.map((f) => f.file)));
  });
  it('the disabled mod warns nowhere, in either layer (its LoadOrder 5 would sort first)', () => {
    const unregText = unreg.map((f) => packaging.formatWarning(f)).join('\n');
    assert.ok(!/Prof Off|dead-off\.sql|orphan-off\.sql/i.test(unregText), unregText.slice(0, 200));
  });
  it('exactly the one enabled misplaced table warns, naming mod, file, table, and database', () => {
    assert.ok(schema.length === 1 && schema[0].kind === 'schema-mismatch' && schema[0].file === 'schema-early.sql'
      && schema[0].name === 'Prof Early' && schema[0].table === 'ShellParams' && schema[0].expectedDb === 'front-end',
      JSON.stringify(schema.map((f) => `${f.name}:${f.file}:${f.table}`)));
  });
  it('the disabled misplaced table stays silent (its LoadOrder 5 would sort first)', () => {
    assert.ok(!schema.some((f) => f.file === 'schema-off.sql'));
  });
  it('exactly the one enabled-vs-disabled id warns, naming both claimants', () => {
    assert.ok(dup.length === 1 && dup[0].kind === 'duplicate-mod-id' && dup[0].key === DUP_MIX_ID.toLowerCase()
      && dup[0].claimants.length === 2
      && dup[0].claimants.some((c) => c.name === 'Prof Off')
      && dup[0].claimants.some((c) => c.name === 'Prof Off Dup'),
      JSON.stringify(dup.map((f) => f.key)));
  });
  it('the all-disabled duplicate pair stays silent', () => {
    assert.ok(!dup.some((f) => f.key === DUP_OFF_ID.toLowerCase()));
  });
  it('exactly the enabled broken file warns, naming its tag', () => {
    assert.ok(xml.length === 1 && xml[0].kind === 'xml-issue' && xml[0].file === 'broken-late.xml'
      && xml[0].tag === 'Row' && xml[0].name === 'Prof Late',
      JSON.stringify(xml.map((f) => `${f.file}<${f.tag}>`)));
  });
  it('the disabled broken file stays silent', () => {
    assert.ok(!xml.some((f) => f.file === 'broken-off.xml'));
  });
  it('collectPackagingWarnings joins every layer in order (unregistered, schema, dup-ids, xml)', () => {
    assert.ok(collected.length === 6
      && JSON.stringify(collected.map((f) => f.kind)) === JSON.stringify(
        ['unregistered-file', 'unregistered-file', 'unregistered-file', 'schema-mismatch', 'duplicate-mod-id', 'xml-issue']),
      JSON.stringify(collected.map((f) => f.kind)));
  });
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // Best effort: a locked handle on Windows reports here rather than silently.
  }
});
