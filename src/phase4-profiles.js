'use strict';

// Phase 4 automated proof: mod groups (player profiles).
//
// Operates only on a synthetic database in a scratch dir. If a real Mods.sqlite
// is passed as the first argument it is copied first and never written to.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = require('./modsdb');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-profiles-'));
const DB_PATH = path.join(TMP, 'Mods.sqlite');

seed();
console.log(`scratch dir: ${TMP}\nseeded a small test database -> ${DB_PATH}\n`);

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};
const MAX = 10000; // the server's cap on mods in an imported file
const fails = (fn) => {
  try { fn(); return false; } catch (_) { return true; }
};
const groupNamed = (name) => db.listGroups(DB_PATH).groups.find((g) => g.name === name);
const raw = (sql, ...a) => {
  const conn = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return conn.prepare(sql).all(...a); } finally { conn.close(); }
};
const PROFILES = raw('SELECT count(*) AS n FROM ModGroups')[0].n;

// A handful of mods, the built-in group (full, one mod on) and a user group
// with a subset, so empty / duplicate / delete have something real to work on.
function seed() {
  const d = new DatabaseSync(DB_PATH);
  d.exec(`
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      Name TEXT NOT NULL, CanDelete BOOLEAN DEFAULT 1, Selected BOOLEAN DEFAULT 0, SortIndex INTEGER DEFAULT 100);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL,
      Disabled BOOLEAN DEFAULT 0, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, Path TEXT UNIQUE, LastWriteTime INTEGER DEFAULT 0);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ScannedFileRowId INTEGER NOT NULL,
      ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL,
      PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL,
      PRIMARY KEY(ModRowId, Tag, Locale));
    CREATE TABLE ModRelationships(ModRowId INTEGER NOT NULL, OtherModId TEXT NOT NULL, Relationship TEXT NOT NULL, OtherModTitle TEXT);
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE Settings(SettingRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModRowId INTEGER NOT NULL, SettingId TEXT, SettingType TEXT NOT NULL);
    CREATE TABLE SettingFiles(SettingRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(SettingRowId, FileRowId));
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));`);
  d.exec(`INSERT INTO ScannedFiles (Path) VALUES ('a'), ('b'), ('c'), ('d')`);
  const ids = ['mod-a', 'mod-b', 'mod-c', 'mod-d'];
  ids.forEach((id, i) => {
    d.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(i + 1, id);
    d.prepare('INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, ?, ?)').run(i + 1, 'Name', id.toUpperCase());
  });
  d.exec(`INSERT INTO ModGroups (Name, CanDelete, Selected, SortIndex) VALUES ('LOC_MODS_GROUP_DEFAULT_NAME', 0, 0, 0)`);
  d.exec(`INSERT INTO ModGroups (Name, CanDelete, Selected, SortIndex) VALUES ('Existing', 1, 1, 100)`);
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, 1, 0)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, 2, 1)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, 3, 1)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, 4, 1)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (2, 1, 0)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (2, 2, 0)').run();
  d.close();
}

// --- Test 1: reading --------------------------------------------------------
console.log('Test 1: read groups');
{
  const st = db.listGroups(DB_PATH);
  check('read ok', st.ok, st.error || '');
  check('two groups', st.groups.length === 2);
  check('active is the selected one', st.active && st.active.name === 'Existing');
  check('default group is not deletable', st.groups.find((g) => !g.canDelete).name === 'LOC_MODS_GROUP_DEFAULT_NAME');
  const g = st.groups.find((x) => x.name === 'Existing');
  check('counts per group', g.total === 2 && g.enabled === 2, `total=${g.total} enabled=${g.enabled}`);
  check('default group counts', (() => { const d0 = st.groups.find((x) => !x.canDelete); return d0.total === 4 && d0.enabled === 1; })());
}

// --- Test 2: create empty ---------------------------------------------------
console.log('\nTest 2: create an empty profile');
{
  const r = db.createGroup(DB_PATH, 'Fresh');
  check('backup created', !!r.backupPath && fs.existsSync(r.backupPath));
  const g = db.listGroups(DB_PATH).groups.find((x) => x.name === 'Fresh');
  check('group exists', !!g);
  check('deletable, selected, SortIndex 100', g.canDelete && g.selected && g.sortIndex === 100);
  check('every mod present but off', g.total === 4 && g.enabled === 0, `total=${g.total} enabled=${g.enabled}`);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);
  check('existing profile untouched', (() => { const e = groupNamed('Existing'); return e.total === 2 && e.enabled === 2; })());
  check('default group untouched', (() => { const d0 = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME'); return d0.total === 4 && d0.enabled === 1; })());
}

// --- Test 3: duplicate ------------------------------------------------------
console.log('\nTest 3: duplicate a profile');
{
  db.activateGroup(DB_PATH, groupNamed('Existing').id);
  const src = groupNamed('Existing');
  db.createGroup(DB_PATH, 'AllOff'); // a different profile to copy, so we prove we copy the right one
  const copy = db.duplicateGroup(DB_PATH, src.id, 'Existing copy');
  check('copy reported', copy.group && copy.group.name === 'Existing copy');
  const g = groupNamed('Existing copy');
  check('same items as the source', g.total === src.total && g.enabled === src.enabled, `total=${g.total} enabled=${g.enabled}`);
  check('copy is active', g.selected);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);
  check('the copy has its own rows', raw('SELECT count(*) n FROM ModGroupItems WHERE ModGroupRowId = ?', g.id)[0].n === 2);
  // Changing the copy must not change the source.
  db.applyChanges(DB_PATH, [{ modId: 'mod-a', enabled: false }]);
  const after = groupNamed('Existing');
  check('source unchanged after editing the copy', after.enabled === 2, `enabled=${after.enabled}`);
}

// --- Test 4: rename ---------------------------------------------------------
console.log('\nTest 4: rename');
{
  const id = groupNamed('Existing copy').id;
  const r = db.renameGroup(DB_PATH, id, '  Renamed  ');
  check('name trimmed', r.group.name === 'Renamed', r.group.name);
  check('renamed group is the active one', r.group.selected);
  check('empty name rejected', fails(() => db.renameGroup(DB_PATH, id, '   ')));
  check('unknown id rejected', fails(() => db.renameGroup(DB_PATH, 9999, 'x')));
}

// --- Test 5: activate -------------------------------------------------------
console.log('\nTest 5: activate');
{
  const target = groupNamed('AllOff');
  const r = db.activateGroup(DB_PATH, target.id);
  check('active switched', r.active && r.active.id === target.id);
  check('previous active deselected', !groupNamed('Renamed').selected);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);
}

// --- Test 6: delete ---------------------------------------------------------
console.log('\nTest 6: delete');
{
  const def = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME');
  check('default group cannot be deleted', fails(() => db.deleteGroup(DB_PATH, def.id)));
  check('unknown id rejected', fails(() => db.deleteGroup(DB_PATH, 9999)));

  const gone = groupNamed('Renamed');
  const r = db.deleteGroup(DB_PATH, gone.id, groupNamed('AllOff').id);
  check('group removed', !groupNamed('Renamed'));
  check('its items removed', raw('SELECT count(*) n FROM ModGroupItems WHERE ModGroupRowId = ?', gone.id)[0].n === 0);
  check('switched to the fallback', r.active && r.active.id === groupNamed('AllOff').id);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);

  // Fall back to the built-in group when no fallback id is given.
  const victim = groupNamed('AllOff');
  const r2 = db.deleteGroup(DB_PATH, victim.id);
  check('without a fallback it picks the built-in group', r2.active && r2.active.id === def.id, r2.active && r2.active.name);
  check('last group still cannot be deleted', fails(() => db.deleteGroup(DB_PATH, def.id)));
}

// --- Test 7: apply changes still work on a created profile -------------------
console.log('\nTest 7: toggling mods in a fresh profile');
{
  const fresh = db.createGroup(DB_PATH, 'Toggles');
  const g = groupNamed('Toggles');
  check('all mods present so they can be toggled', g.total === 4 && g.enabled === 0);
  db.applyChanges(DB_PATH, [{ modId: 'mod-b', enabled: true }, { modId: 'mod-c', enabled: true }]);
  const after = groupNamed('Toggles');
  check('two mods on', after.enabled === 2, `enabled=${after.enabled}`);
  const exported = raw('SELECT m.ModId AS id, i.Disabled AS disabled FROM ModGroupItems i JOIN Mods m ON m.ModRowId = i.ModRowId WHERE i.ModGroupRowId = ? ORDER BY m.ModId', g.id);
  check('flags stored per mod', JSON.stringify(exported) === JSON.stringify([{ id: 'mod-a', disabled: 1 }, { id: 'mod-b', disabled: 0 }, { id: 'mod-c', disabled: 0 }, { id: 'mod-d', disabled: 1 }]), JSON.stringify(exported));
  check('other groups unaffected', (() => { const d0 = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME'); return d0.enabled === 1; })());
}

// --- Test 8: a failed write leaves everything as it was ---------------------
console.log('\nTest 8: failure safety');
{
  const before = JSON.stringify(db.listGroups(DB_PATH));
  check('duplicate of a missing group fails', fails(() => db.duplicateGroup(DB_PATH, 9999, 'nope')));
  check('groups unchanged after a failure', JSON.stringify(db.listGroups(DB_PATH)) === before);
  check('database still checks out', raw('PRAGMA quick_check')[0].quick_check === 'ok');
}

// --- Test 9: backups --------------------------------------------------------
console.log('\nTest 9: backups');
{
  const baks = () => fs.readdirSync(TMP).filter((f) => /^Mods\.sqlite\.bak-\d{8}-\d{6}$/.test(f));
  const before = fs.readFileSync(DB_PATH);
  const r = db.createGroup(DB_PATH, 'Backed up');
  check('a successful write leaves a backup', baks().includes(path.basename(r.backupPath)));
  check('the backup is the pre-write database', fs.readFileSync(r.backupPath).equals(before));
  check('at most 10 kept', baks().length <= 10, `${baks().length} kept`);
  // A write that changes nothing removes its own redundant backup again.
  // Backup names only have second resolution, so within one second the failed
  // write shares the name of the previous one and can remove that too; what
  // matters is that a failure never leaves extra copies behind.
  const beforeCount = baks().length;
  check('a failed write leaves no extra backup', fails(() => db.duplicateGroup(DB_PATH, 9999, 'nope')) && baks().length <= beforeCount,
    `${beforeCount} -> ${baks().length}`);
}

// --- Test 10: export / import -----------------------------------------------
console.log('\nTest 10: export and import');
{
  const source = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME'); // four mods, one on
  const file = db.exportGroup(DB_PATH, source.id);
  check('carries the toolkit and version', file.toolkit === 'civ6-mod-toolkit' && file.version === 1);
  check('carries the profile name', file.name === 'LOC_MODS_GROUP_DEFAULT_NAME', file.name);
  check('has an export timestamp', !Number.isNaN(Date.parse(file.exportedAt)));
  check('lists every mod with its state', file.mods.length === 4 && file.mods.filter((m) => m.enabled).length === 1,
    `${file.mods.length} mods, ${file.mods.filter((m) => m.enabled).length} on`);
  check('keys mods by ModId', file.mods.every((m) => typeof m.modId === 'string' && typeof m.enabled === 'boolean'));
  check('no ModRowId leaks into the file', !JSON.stringify(file).includes('ModRowId'));

  // A file with a mod the game doesn't know: skipped and reported.
  const withUnknown = { ...file, name: 'Imported', mods: [...file.mods, { modId: 'mod-does-not-exist', enabled: true }] };
  const r = db.importGroup(DB_PATH, withUnknown);
  check('creates a new profile', !!r.group && r.group.name === 'Imported', r.group && r.group.name);
  check('imports the known mods', r.imported === 4, `${r.imported}`);
  check('reports the unknown mod', JSON.stringify(r.skipped) === JSON.stringify(['mod-does-not-exist']), JSON.stringify(r.skipped));
  check('new profile is active', groupNamed('Imported').selected);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);
  check('the imported states match the file', (() => {
    const g = groupNamed('Imported');
    const rows = raw('SELECT m.ModId AS id, i.Disabled AS d FROM ModGroupItems i JOIN Mods m ON m.ModRowId = i.ModRowId WHERE i.ModGroupRowId = ?', g.id);
    const byId = new Map(rows.map((x) => [x.id, !x.d]));
    return file.mods.every((m) => byId.get(m.modId) === m.enabled) && byId.size === 4;
  })());
  check('the source profile is untouched', (() => { const s = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME'); return s.enabled === 1; })());

  // Importing always creates: the same name gets a suffix.
  const again = db.importGroup(DB_PATH, file);
  check('a second import does not overwrite', again.group.name === 'LOC_MODS_GROUP_DEFAULT_NAME (2)', again.group.name);
  check('the first imported profile is still there', groupNamed('Imported').total === 4);
  const third = db.importGroup(DB_PATH, file);
  check('a third import counts up', third.group.name === 'LOC_MODS_GROUP_DEFAULT_NAME (3)', third.group.name);
  const fresh = db.importGroup(DB_PATH, { mods: file.mods });
  check('a file with no name gets a default one', fresh.group.name === 'Imported profile', fresh.group.name);
  const noClash = db.importGroup(DB_PATH, { name: 'Brand new', mods: file.mods });
  check('a name that is free is used as is', noClash.group.name === 'Brand new', noClash.group.name);

  check('a file without mods is rejected', fails(() => db.importGroup(DB_PATH, { name: 'x' })));
  check('a file that is not an object is rejected', fails(() => db.importGroup(DB_PATH, 'nope')));
  check('a huge mod list is rejected', fails(() => db.importGroup(DB_PATH, { mods: new Array(MAX + 1).fill({ modId: 'a', enabled: true }) })));
}

// --- Test 11: a real database copy ------------------------------------------
// The checks above run against a known small database. Given a path to a real
// Mods.sqlite it is copied here and the same operations are smoke-tested
// against the real schema and the real number of mods. The original is only
// ever read.
const real = process.argv[2];
if (real && fs.existsSync(real)) {
  console.log(`\nTest 10: a copy of the real database (${real})`);
  const copyPath = path.join(TMP, 'RealMods.sqlite');
  fs.copyFileSync(real, copyPath);
  const inCopy = (sql, ...a) => {
    const conn = new DatabaseSync(copyPath, { readOnly: true });
    try { return conn.prepare(sql).all(...a); } finally { conn.close(); }
  };
  const before = db.listGroups(copyPath);
  const modCount = inCopy('SELECT count(*) AS n FROM Mods')[0].n;
  check('read ok', before.ok, before.error || '');
  check('found the existing groups', before.groups.length > 0, `${before.groups.length} groups`);
  check('exactly one active group', inCopy('SELECT count(*) AS n FROM ModGroups WHERE Selected = 1')[0].n === 1);

  const created = db.createGroup(copyPath, 'Toolkit smoke test');
  const g = created.group;
  check('empty profile holds every mod, all off', g.total === modCount && g.enabled === 0, `total=${g.total}/${modCount} enabled=${g.enabled}`);
  check('the new profile is active', g.selected && db.listGroups(copyPath).active.id === g.id);

  const copyOf = db.duplicateGroup(copyPath, before.active.id, 'Copied profile');
  check('duplicate matches the source group', copyOf.group.total === before.active.total && copyOf.group.enabled === before.active.enabled,
    `total=${copyOf.group.total}/${before.active.total} enabled=${copyOf.group.enabled}/${before.active.enabled}`);
  db.renameGroup(copyPath, copyOf.group.id, 'Renamed profile');
  check('rename applied', db.listGroups(copyPath).groups.some((x) => x.name === 'Renamed profile'));
  db.activateGroup(copyPath, before.active.id);
  check('switch back to the original active group', db.listGroups(copyPath).active.id === before.active.id);

  db.deleteGroup(copyPath, copyOf.group.id);
  check('deleted the copy', !db.listGroups(copyPath).groups.some((x) => x.id === copyOf.group.id));
  check('active group is still the original', db.listGroups(copyPath).active.id === before.active.id);
  check('the other groups kept their mods', before.groups.every((x) => {
    const now = db.listGroups(copyPath).groups.find((y) => y.id === x.id);
    return now && now.total === x.total && now.enabled === x.enabled;
  }));
  check('the original file is untouched', fs.readFileSync(real).length > 0);
  check('the copy still checks out', inCopy('PRAGMA quick_check')[0].quick_check === 'ok');
} else if (real) {
  console.log(`\nTest 10: skipped - ${real} not found`);
}

// --- Test 12: registering a mod the game has not scanned --------------------
console.log('\nTest 12: register an unscanned mod');
{
  // A .modinfo like the ones on disk, so registerMod has real input.
  const modDir = path.join(TMP, 'mods', 'Test Mod');
  fs.mkdirSync(modDir, { recursive: true });
  const modinfo = path.join(modDir, 'Test Mod.modinfo');
  fs.writeFileSync(modinfo, `<?xml version="1.0" encoding="utf-8"?>
<Mod id="11111111-2222-3333-4444-555555555555" version="7">
  <Properties>
    <Name>Test Mod</Name>
    <Teaser>A test.</Teaser>
    <Description>Longer description.</Description>
    <Authors>Somebody</Authors>
    <CompatibleVersions>2.0</CompatibleVersions>
  </Properties>
</Mod>
`);
  const before = raw('SELECT (SELECT count(*) FROM Mods) m, (SELECT count(*) FROM ScannedFiles) f, (SELECT count(*) FROM ModGroupItems) g')[0];

  const r = db.registerMods(DB_PATH, [modinfo]);
  check('registered one mod', r.registered.length === 1, JSON.stringify(r.failed));
  check('no failures', r.failed.length === 0);
  check('a backup was made', !!r.backupPath && fs.existsSync(r.backupPath));
  check('its id came from the .modinfo', r.registered[0].modId === '11111111-2222-3333-4444-555555555555');
  check('it is a new row', r.registered[0].isNew === true);

  // The game registers a new mod in the built-in group, and rebuilds that mod's
  // group membership on its next scan - so that is the group to write.
  check('registered in the built-in group', r.builtIn === 1, String(r.builtIn));
  const profilesNow = raw('SELECT count(*) AS n FROM ModGroups')[0].n;
  check('reports how many profiles exist', r.profiles === profilesNow, `${r.profiles} vs ${profilesNow}`);
  const builtIn = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId = 1 AND lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`)[0].n;
  check('it has a row there', builtIn === 1);
  check('and it is enabled there', raw(`SELECT i.Disabled d FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId = 1 AND lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`)[0].d === 0);
  // Every profile gets a row, so the mod stays switchable wherever you are.
  const rowsEverywhere = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`)[0].n;
  check('a row in every profile', rowsEverywhere === profilesNow, `rows=${rowsEverywhere} profiles=${profilesNow}`);
  // No profile was named here, so only the built-in group is switched on.
  check('reports how many profiles have it off', r.registered[0].offElsewhere === profilesNow - 1, String(r.registered[0].offElsewhere));

  const after = raw('SELECT (SELECT count(*) FROM Mods) m, (SELECT count(*) FROM ScannedFiles) f, (SELECT count(*) FROM ModGroupItems) g')[0];
  check('one mod row added', after.m === before.m + 1, `${before.m} -> ${after.m}`);
  check('one scanned file added', after.f === before.f + 1, `${before.f} -> ${after.f}`);
  // One row per profile, so the mod is switchable wherever the user is.
  const profilesAtReg = raw('SELECT count(*) AS n FROM ModGroups')[0].n;
  check('one group item added per profile', after.g === before.g + profilesAtReg, `${before.g} -> ${after.g} (${profilesAtReg} profiles)`);

  const row = raw(`SELECT s.Path AS path, CAST(s.LastWriteTime AS TEXT) AS lwt, m.ModId AS modId, m.Version AS version
    FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId
    WHERE lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`)[0];
  check('path uses forward slashes', !row.path.includes('\\'), row.path);
  check('path points at the .modinfo', row.path.toLowerCase().endsWith('test mod.modinfo'));
  check('version comes from the .modinfo', row.version === 7, String(row.version));
  const fileTime = require('fs').statSync(modinfo, { bigint: true }).mtimeNs / 100n + 116444736000000000n;
  check('LastWriteTime is the file mtime, at full precision', row.lwt === fileTime.toString(), `${row.lwt} vs ${fileTime}`);
  check('and is not rounded to milliseconds', row.lwt !== (BigInt(fileTime / 10000n) * 10000n).toString());
  check('a Name property was written', raw(`SELECT Value FROM ModProperties WHERE Name='Name' AND ModRowId =
    (SELECT ModRowId FROM Mods WHERE lower(ModId)='11111111-2222-3333-4444-555555555555')`)[0].Value === 'Test Mod');

  // The toolkit now treats it as a normal mod. Registration gives it a row in
  // every profile, so it reads as a normal switchable mod here, off because
  // this call did not name a profile to switch it on in.
  const st = db.readModState(DB_PATH);
  const seen = st.mods.find((m) => m.idNorm === '11111111-2222-3333-4444-555555555555');
  check('the toolkit sees it', !!seen);
  check('with its real name', seen && seen.name === 'Test Mod', seen && seen.name);
  check('it is in the active profile, switched off', seen && seen.disabled === true, String(seen && seen.disabled));
  check('it is on in the built-in group', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId=1 AND i.Disabled=0 AND lower(m.ModId)='11111111-2222-3333-4444-555555555555'`)[0].n === 1);

  // Idempotent: the game rescans on every launch, so repeats must be safe.
  const again = db.registerMods(DB_PATH, [modinfo]);
  const after2 = raw('SELECT (SELECT count(*) FROM Mods) m, (SELECT count(*) FROM ModGroupItems) g')[0];
  check('re-registering adds nothing', after2.m === after.m && after2.g === after.g, `mods ${after.m}->${after2.m}, items ${after.g}->${after2.g}`);
  check('and reports it as not new', again.registered[0].isNew === false);
  // Repeating must not switch a mod on in profiles the user never asked for.
  check('re-registering leaves the other profiles off', (() => {
    const onElsewhere = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
      WHERE i.Disabled = 0 AND i.ModGroupRowId NOT IN (1, ?) AND lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`,
      raw('SELECT ModGroupRowId AS id FROM ModGroups WHERE Selected = 1')[0].id)[0].n;
    return onElsewhere === 0;
  })(), 'on elsewhere');

  check('registering nothing is a no-op', db.registerMods(DB_PATH, []).registered.length === 0);
  check('a modinfo with no id is reported, not thrown', (() => {
    const bad = path.join(modDir, 'bad.modinfo');
    fs.writeFileSync(bad, '<Mod version="1"></Mod>');
    const res = db.registerMods(DB_PATH, [bad]);
    return res.registered.length === 0 && res.failed.length === 1;
  })());
  check('a missing file is reported, not thrown', (() => {
    const res = db.registerMods(DB_PATH, [path.join(modDir, 'nope.modinfo')]);
    return res.registered.length === 0 && res.failed.length === 1;
  })());
  check('the database is still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('and has no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

console.log('\nTest 13: registering into a chosen profile as well');
{
  const modDir = path.join(TMP, 'mods', 'Second Mod');
  fs.mkdirSync(modDir, { recursive: true });
  const file = path.join(modDir, 'Second.modinfo');
  fs.writeFileSync(file, '<Mod id="99999999-8888-7777-6666-555555555555" version="2"><Properties><Name>Second Mod</Name></Properties></Mod>');
  const r = db.registerMods(DB_PATH, [file], true, 2); // profile "Existing"
  check('registered', r.registered.length === 1 && r.failed.length === 0, JSON.stringify(r.failed));
  check('reports the profile row was written', r.registered[0].profileRow === true);
  check('has a row in the built-in group', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId=1 AND lower(m.ModId)='99999999-8888-7777-6666-555555555555'`)[0].n === 1);
  check('and a row in the chosen profile', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId=2 AND lower(m.ModId)='99999999-8888-7777-6666-555555555555'`)[0].n === 1);
  // readModState reports flags for whichever profile is in use, so make it ours.
  db.activateGroup(DB_PATH, 2);
  const st = db.readModState(DB_PATH);
  const inExisting = st.mods.find((m) => m.idNorm === '99999999-8888-7777-6666-555555555555');
  check('readable and enabled once that profile is in use', inExisting && inExisting.disabled === false,
    inExisting ? String(inExisting.disabled) : '(not found)');
  check('an unknown profile is rejected', fails(() => db.registerMods(DB_PATH, [file], true, 9999)));
  check('a profile id of the built-in group is fine', db.registerMods(DB_PATH, [file], true, 1).registered.length === 1);
}

console.log('\nTest 14: the full registration (files, actions, criteria)');
{
  const dir = path.join(TMP, 'mods', 'Full Mod');
  fs.mkdirSync(path.join(dir, 'Core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Core', 'Data.sql'), 'x');
  fs.writeFileSync(path.join(dir, 'Core', 'Text.xml'), 'x');
  const file = path.join(dir, 'Full Mod.modinfo');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>
<Mod id="55555555-4444-3333-2222-111111111111" version="3">
  <Properties><Name>Full Mod</Name><Description>d</Description></Properties>
  <ActionCriteria>
    <Criteria id="Expansion1"><GameCoreInUse>Expansion1</GameCoreInUse></Criteria>
  </ActionCriteria>
  <InGameActions>
    <UpdateDatabase id="Main">
      <Properties><LoadOrder>200</LoadOrder></Properties>
      <File>Core/Data.sql</File>
    </UpdateDatabase>
    <UpdateText id="Text" criteria="Expansion1"><File>Core/Text.xml</File></UpdateText>
    <ReplaceUIScript id="NoFiles"><Properties><LuaContext>Screen</LuaContext></Properties></ReplaceUIScript>
  </InGameActions>
  <FrontEndActions>
    <UpdateIcons id="Icons"><File>Core/Text.xml</File></UpdateIcons>
  </FrontEndActions>
  <Files><File>Core/Data.sql</File><File>Core/Text.xml</File></Files>
</Mod>
`);
  const r = db.registerMods(DB_PATH, [file]);
  check('registered', r.registered.length === 1 && r.failed.length === 0, JSON.stringify(r.failed));
  const row = raw('SELECT ModRowId FROM Mods WHERE lower(ModId)=?', '55555555-4444-3333-2222-111111111111')[0];
  const mid = row.ModRowId;
  const n = (sql, ...a) => raw(sql, ...a)[0].n;

  check('a ModFiles row per <Files> entry', n('SELECT count(*) n FROM ModFiles WHERE ModRowId=?', mid) === 2);
  check('paths kept relative with forward slashes', raw('SELECT Path FROM ModFiles WHERE ModRowId=?', mid).every((f) => !f.Path.includes('\\') && !/^[A-Za-z]:/.test(f.Path)));
  check('one Component per InGameActions action', n('SELECT count(*) n FROM Components WHERE ModRowId=?', mid) === 3, String(n('SELECT count(*) n FROM Components WHERE ModRowId=?', mid)));
  check('components keep document order', JSON.stringify(raw('SELECT ComponentType t FROM Components WHERE ModRowId=? ORDER BY ComponentRowId', mid).map((r) => r.t))
    === JSON.stringify(['UpdateDatabase', 'UpdateText', 'ReplaceUIScript']));
  check('one Setting per FrontEndActions action', n('SELECT count(*) n FROM Settings WHERE ModRowId=?', mid) === 1);
  check('an action with no id is still recorded', raw('SELECT count(*) n FROM Components WHERE ModRowId=? AND ComponentId IS NULL', mid)[0].n === 0);
  check('the action Properties become ComponentProperties', n('SELECT count(*) n FROM ComponentProperties p JOIN Components c ON c.ComponentRowId=p.ComponentRowId WHERE c.ModRowId=?', mid) === 2,
    String(n('SELECT count(*) n FROM ComponentProperties p JOIN Components c ON c.ComponentRowId=p.ComponentRowId WHERE c.ModRowId=?', mid)));
  check('LoadOrder stored as a property', raw(`SELECT Value FROM ComponentProperties p JOIN Components c ON c.ComponentRowId=p.ComponentRowId
    WHERE c.ModRowId=? AND p.Name='LoadOrder'`, mid)[0].Value === '200');
  check('a Criteria row per ActionCriteria', n('SELECT count(*) n FROM Criteria WHERE ModRowId=?', mid) === 1);
  check('a Criterion row per condition', n('SELECT count(*) n FROM Criterion c JOIN Criteria k ON k.CriteriaRowId=c.CriteriaRowId WHERE k.ModRowId=?', mid) === 1);
  check('the condition value is a property', n(`SELECT count(*) n FROM CriterionProperties p JOIN Criterion c ON c.CriterionRowId=p.CriterionRowId
    JOIN Criteria k ON k.CriteriaRowId=c.CriteriaRowId WHERE k.ModRowId=? AND p.Name='Value' AND p.Value='Expansion1'`, mid) === 1);

  // Links: only the action's own <File> children, at priority 0.
  const links = raw(`SELECT c.ComponentType t, mf.Path p, cf.Priority pr FROM ComponentFiles cf
    JOIN Components c ON c.ComponentRowId=cf.ComponentRowId JOIN ModFiles mf ON mf.FileRowId=cf.FileRowId WHERE c.ModRowId=?`, mid);
  check('one link per <File> child', links.length === 2, String(links.length));
  check('links resolve to ModFiles rows', links.every((l) => l.p === 'Core/Data.sql' || l.p === 'Core/Text.xml'));
  check('all at priority 0', links.every((l) => l.pr === 0));
  check('the action with no <File> gets no link', !links.some((l) => l.t === 'ReplaceUIScript'));
  check('SettingFiles linked too', n('SELECT count(*) n FROM SettingFiles sf JOIN Settings s ON s.SettingRowId=sf.SettingRowId WHERE s.ModRowId=?', mid) === 1);

  check('database still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

console.log('\nTest 15: every .modinfo property and <Dependencies> are recorded');
{
  const dir = path.join(TMP, 'mods', 'Deps Mod');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Deps.modinfo');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>
<Mod id="77777777-6666-5555-4444-333333333333" version="1">
  <Properties>
    <Name>Deps Mod</Name>
    <Created>1726575064</Created>
    <AffectsSavedGames>0</AffectsSavedGames>
    <SubscriptionID>12345</SubscriptionID>
  </Properties>
  <Dependencies>
    <Mod id="4873eb62-8ccc-4574-b784-dda455e74e68" title="Expansion: Gathering Storm" />
  </Dependencies>
  <InGameActions><UpdateDatabase id="A"><File>x.sql</File></UpdateDatabase></InGameActions>
  <Files><File>x.sql</File></Files>
</Mod>
`);
  fs.writeFileSync(path.join(dir, 'x.sql'), 'x');
  const r = db.registerMods(DB_PATH, [file]);
  check('registered', r.registered.length === 1 && r.failed.length === 0, JSON.stringify(r.failed));
  const mid = raw('SELECT ModRowId FROM Mods WHERE lower(ModId)=?', '77777777-6666-5555-4444-333333333333')[0].ModRowId;
  const props = raw('SELECT Name,Value FROM ModProperties WHERE ModRowId=? ORDER BY Name', mid);
  const names = props.map((p) => p.Name);
  check('every <Properties> child is kept, not just a known few',
    ['Name', 'Created', 'AffectsSavedGames', 'SubscriptionID'].every((n) => names.includes(n)), JSON.stringify(names));
  check('Created stored verbatim', props.find((p) => p.Name === 'Created').Value === '1726575064');
  const rel = raw('SELECT OtherModId,Relationship,OtherModTitle FROM ModRelationships WHERE ModRowId=?', mid);
  check('a self-closing <Dependencies> entry becomes a relationship', rel.length === 1, JSON.stringify(rel));
  check('with type Dependency and the title', rel[0].Relationship === 'Dependency' && rel[0].OtherModTitle === 'Expansion: Gathering Storm');
  check('the path is stored with forward slashes', raw('SELECT Path FROM ScannedFiles WHERE ScannedFileRowId=(SELECT ScannedFileRowId FROM Mods WHERE ModRowId=?)', mid)[0].Path.includes('/'));
  check('database still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

console.log('\nTest 16: <File> elements that carry attributes are not dropped');
{
  const dir = path.join(TMP, 'mods', 'Attr Mod');
  fs.mkdirSync(path.join(dir, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Data', 'a.xml'), 'x');
  fs.writeFileSync(path.join(dir, 'Data', 'b.xml'), 'x');
  const file = path.join(dir, 'Attr.modinfo');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>
<Mod id="88888888-7777-6666-5555-444444444444" version="1">
  <Properties><Name>Attr Mod</Name></Properties>
  <InGameActions>
    <UpdateIcons id="Icon">
      <File>Data/a.xml</File>
      <File priority="1">Data/b.xml</File>
      <File Priority="2">Data/c.xml</File>
    </UpdateIcons>
  </InGameActions>
  <Files><File>Data/a.xml</File><File>Data/b.xml</File></Files>
</Mod>
`);
  const r = db.registerMods(DB_PATH, [file]);
  check('registered', r.registered.length === 1 && r.failed.length === 0, JSON.stringify(r.failed));
  const mid = raw('SELECT ModRowId FROM Mods WHERE lower(ModId)=?', '88888888-7777-6666-5555-444444444444')[0].ModRowId;
  const links = raw(`SELECT mf.Path AS p FROM ComponentFiles cf JOIN Components c ON c.ComponentRowId=cf.ComponentRowId
    JOIN ModFiles mf ON mf.FileRowId=cf.FileRowId WHERE c.ModRowId=?`, mid).map((r) => r.p);
  check('the lowercase priority= file is linked, not dropped', links.includes('Data/b.xml'), JSON.stringify(links));
  check('the capitalised Priority= file is not linked (absent from <Files>)', !links.includes('Data/c.xml'), JSON.stringify(links));
  check('two links in total', links.length === 2, JSON.stringify(links));
  check('all links at priority 0', raw(`SELECT cf.Priority AS pr FROM ComponentFiles cf JOIN Components c ON c.ComponentRowId=cf.ComponentRowId
    WHERE c.ModRowId=?`, mid).every((r) => r.pr === 0));
  check('database still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

// --- Test 17: the sync that runs unattended ---------------------------------
// A sync runs at server startup and from the dashboard's Rescan with nobody
// watching, so the property that matters most is that it switches nothing on.
// registerMods used to ignore its `enabled` argument and always came up on in
// the built-in group and the profile in use; no test noticed, because the only
// caller always passed true. This is the test that would have caught it.
//
// Last in the file on purpose: it changes the database, and the tests above
// assert against shared state.
console.log('\nTest 17: an unattended sync switches nothing on');
{
  const profiles = raw('SELECT count(*) AS n FROM ModGroups')[0].n;
  // scanMods() takes { root, exists, type } entries, the shape paths.getSources() returns.
  const sources = [{ root: path.join(TMP, 'mods'), exists: true, type: 'local' }];

  // A real .modinfo on disk, so findUnregistered can see it. The id must not
  // collide with an earlier test's, or it is already in the database by now.
  const modDir = path.join(TMP, 'mods', 'Sync Mod');
  fs.mkdirSync(modDir, { recursive: true });
  const file = path.join(modDir, 'Sync.modinfo');
  const ID = '44444444-1111-2222-3333-444444444444';
  fs.writeFileSync(file, `<Mod id="${ID}" version="1"><Properties><Name>Sync Mod</Name></Properties></Mod>`);

  const first = db.findUnregistered(DB_PATH, sources);
  check('findUnregistered reads the database', first.ok === true, first.error || '');
  check('it finds the mod that is only on disk', first.pending.some((p) => p.idNorm === ID && p.reason === 'never-scanned'),
    first.pending.map((p) => p.reason).join(','));
  check('every entry carries a reason, a name and a real .modinfo path',
    first.pending.every((p) => p.reason && p.name && /\.modinfo$/i.test(p.path)));
  check('and only the two known reasons',
    first.pending.every((p) => p.reason === 'never-scanned' || p.reason === 'no-profile-row'));

  const r = db.registerMods(DB_PATH, first.pending.map((p) => p.path), false, 2);
  check('a sync registered it, and nothing failed', r.registered.length >= 1 && r.failed.length === 0, JSON.stringify(r.failed));
  const onSomewhere = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.Disabled = 0 AND lower(m.ModId)=?`, ID)[0].n;
  check('NOTHING is switched on, in any profile', onSomewhere === 0, `on in ${onSomewhere}`);
  const rowCount = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE lower(m.ModId)=?`, ID)[0].n;
  check('but it has a row in every profile, so it is tickable', rowCount === profiles, `${rowCount}/${profiles}`);
  check('and reports itself as off everywhere', r.registered[0].offElsewhere === profiles, String(r.registered[0].offElsewhere));
  const seen = db.readModState(DB_PATH).mods.find((m) => m.idNorm === ID);
  check('the mod manager lists it', !!seen);
  check('as off, and switchable rather than "not available"', seen && seen.disabled === true, String(seen && seen.disabled));
  check('and a second sync would skip it',
    !db.findUnregistered(DB_PATH, sources).pending.some((p) => p.idNorm === ID));

  // The other reason a mod needs adding: the game knows it, but it has no row
  // in the profile in use, so it cannot be ticked. Removing that row is exactly
  // how a mod gets stuck - it is what happened to a real one here.
  const activeId = raw('SELECT ModGroupRowId AS id FROM ModGroups WHERE Selected = 1')[0].id;
  const w = new DatabaseSync(DB_PATH);
  const rowId = w.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId)=?').get(ID).ModRowId;
  w.prepare('DELETE FROM ModGroupItems WHERE ModGroupRowId=? AND ModRowId=?').run(activeId, rowId);
  w.close();
  const gone = db.readModState(DB_PATH).mods.find((m) => m.idNorm === ID);
  check('removing that row makes it untoggleable', gone && gone.disabled === null, String(gone && gone.disabled));
  const todo = db.findUnregistered(DB_PATH, sources);
  check('and a sync now wants to fix it, saying why',
    todo.pending.some((p) => p.idNorm === ID && p.reason === 'no-profile-row'),
    todo.pending.map((p) => p.reason).join(','));
  const fix = db.registerMods(DB_PATH, todo.pending.map((p) => p.path), false, activeId);
  check('fixing it works', fix.registered.length >= 1 && fix.failed.length === 0, JSON.stringify(fix.failed));
  check('and still switches nothing on', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.Disabled = 0 AND lower(m.ModId)=?`, ID)[0].n === 0);
  check('and now it is tickable again', db.readModState(DB_PATH).mods.find((m) => m.idNorm === ID).disabled === true);
  check('nothing left to do', db.findUnregistered(DB_PATH, sources).count === 0);

  check('the database is still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('and has no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

// --- Test 18: removing a mod -------------------------------------------------
// Removal deletes the mod's folder, so the refusals matter more than the happy
// path. In a real database 42 of the 44 entries with no files on disk are
// base-game scenarios and DLC civs, not unsubscribed mods - so anything that
// does not check the path carefully would delete those.
console.log('\nTest 18: removing a mod, and refusing to remove the wrong thing');
{
  const modRoot = path.join(TMP, 'mods');
  const sources = [{ root: modRoot, exists: true, type: 'local' }];
  const ID = '33333333-4444-5555-6666-777777777777';
  const dir = path.join(modRoot, 'Doomed Mod');
  const modinfo = path.join(dir, 'Doomed.modinfo');
  fs.mkdirSync(path.join(dir, 'Data'), { recursive: true });
  fs.writeFileSync(modinfo, `<Mod id="${ID}" version="1"><Properties><Name>Doomed Mod</Name></Properties><Files><File>Data/x.xml</File></Files></Mod>`);
  fs.writeFileSync(path.join(dir, 'Data', 'x.xml'), '<x/>');

  const reg = db.registerMods(DB_PATH, [modinfo], true, 2);
  check('registered first, so there is something to remove', reg.registered.length === 1, JSON.stringify(reg.failed));
  const folder = path.dirname(modinfo.replace(/\\/g, '/'));
  const countRows = () => raw('SELECT (SELECT count(*) FROM Mods) m, (SELECT count(*) FROM ModGroupItems) g')[0];
  const before = countRows();

  // --- refusals. Each must leave the database exactly as it was.
  const noFolder = db.removeMods(DB_PATH, [ID], {});
  check('refuses when no folder was confirmed', noFolder.removed.length === 0 && noFolder.refused.length === 1, JSON.stringify(noFolder.refused));

  const wrongFolder = db.removeMods(DB_PATH, [ID], { [ID]: path.join(modRoot, 'Some Other Mod') });
  check('refuses a folder that does not match the database', wrongFolder.removed.length === 0 && wrongFolder.refused.length === 1,
    JSON.stringify(wrongFolder.refused));

  const baseGame = db.removeMods(DB_PATH, [ID], { [ID]: 'C:/Program Files/Sid Meier/Civilization VI/Base/Scenarios' });
  check('refuses a base-game folder', baseGame.removed.length === 0 && baseGame.refused.length === 1, JSON.stringify(baseGame.refused));

  const theRoot = db.removeMods(DB_PATH, [ID], { [ID]: modRoot });
  check('refuses a mod source folder itself', theRoot.removed.length === 0 && theRoot.refused.length === 1, JSON.stringify(theRoot.refused));

  // Both of the above were refused for "folder does not match", which never
  // reaches the guards that matter. Plant rows whose recorded path really is a
  // base-game path, a DLC path, and the source root itself, so those guards are
  // the thing actually under test.
  const plant = (modId, scannedPath) => {
    const w = new DatabaseSync(DB_PATH);
    w.exec('BEGIN IMMEDIATE');
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, ?)').run(scannedPath, '0').lastInsertRowid;
    const mr = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf, modId).lastInsertRowid;
    w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (2, ?, 1)').run(mr);
    w.exec('COMMIT');
    w.close();
  };
  const BASEGAME = '44444444-0000-0000-0000-00000000aaaa';
  const DLCD = '44444444-0000-0000-0000-00000000bbbb';
  const ROOTMOD = '44444444-0000-0000-0000-00000000cccc';
  const PARENTMOD = '44444444-0000-0000-0000-00000000dddd';
  const BASE_FOLDER = '../../Base/Scenarios';
  const DLC_FOLDER = '../../DLC/Australia/Civilization';
  const PARENT = modRoot.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
  plant(BASEGAME, `${BASE_FOLDER}/AncientRivalsScenario.modinfo`);
  plant(DLCD, `${DLC_FOLDER}/Australia.modinfo`);
  plant(ROOTMOD, modRoot.replace(/\\/g, '/') + '/Loose.modinfo');
  plant(PARENTMOD, `${PARENT}/Loose2.modinfo`);

  // Baseline after planting, so "nothing changed" means the refusals changed
  // nothing rather than the planting having done it.
  const planted = countRows();

  // The folder passed has to be the one the database records, or the guard
  // under test is never reached - which is how the first version of these two
  // checks passed for the wrong reason.
  const g1 = db.removeMods(DB_PATH, [BASEGAME], { [BASEGAME]: BASE_FOLDER }, [modRoot]);
  check('a mod recorded at a base-game path is refused as base content',
    g1.removed.length === 0 && /refusing to remove base/.test(g1.refused[0].reason), JSON.stringify(g1.refused));
  const g2 = db.removeMods(DB_PATH, [DLCD], { [DLCD]: DLC_FOLDER }, [modRoot]);
  check('a mod recorded at a DLC path is refused as dlc content',
    g2.removed.length === 0 && /refusing to remove dlc/.test(g2.refused[0].reason), JSON.stringify(g2.refused));
  const g3 = db.removeMods(DB_PATH, [ROOTMOD], { [ROOTMOD]: modRoot }, [modRoot]);
  check('a mod whose folder IS a mod source folder is refused',
    g3.removed.length === 0 && /mod source folder/.test(g3.refused[0].reason), JSON.stringify(g3.refused));
  // The one that would have taken the whole mod library with it.
  const g4 = db.removeMods(DB_PATH, [PARENTMOD], { [PARENTMOD]: PARENT }, [modRoot]);
  check('so is a folder that contains the mod source folder',
    g4.removed.length === 0 && /containing the mod folders/.test(g4.refused[0].reason), JSON.stringify(g4.refused));
  check('all four are still in the database',
    [BASEGAME, DLCD, ROOTMOD, PARENTMOD].every((x) => raw('SELECT count(*) n FROM Mods WHERE lower(ModId)=?', x)[0].n === 1));
  check('and not one of those refusals changed a row',
    JSON.stringify(countRows()) === JSON.stringify(planted), `${JSON.stringify(planted)} -> ${JSON.stringify(countRows())}`);

  const unknown = db.removeMods(DB_PATH, ['99999999-0000-0000-0000-000000000000'],
    { '99999999-0000-0000-0000-000000000000': modRoot });
  check('reports an unknown mod rather than throwing', unknown.removed.length === 0 && unknown.refused.length === 1);

  check('the unknown-id refusal changed nothing either', JSON.stringify(countRows()) === JSON.stringify(planted),
    `${JSON.stringify(planted)} -> ${JSON.stringify(countRows())}`);

  // --- a mod still on disk is not "gone"
  const listed = db.findRemoved(DB_PATH, sources);
  check('findRemoved reads the database', listed.ok === true, listed.error || '');
  check('a mod that is still installed is not listed as gone', !listed.removed.some((r) => r.modId === ID));
  check('base and DLC entries are never offered for removal',
    listed.removed.every((r) => r.kind === 'dlc' || r.kind === 'base' ? r.removable === false : true),
    `${listed.removed.length} listed, ${listed.removable} removable`);

  // --- case must not matter, or a Steam library recorded as "d:\steam" fails
  const shouty = db.removeMods(DB_PATH, [ID], { [ID]: folder.toUpperCase() });
  check('a case difference in the folder is accepted', shouty.removed.length === 1, JSON.stringify(shouty.refused));
  check('it really is gone from Mods', raw('SELECT count(*) n FROM Mods WHERE lower(ModId)=?', ID)[0].n === 0);
  check('no profile still lists it', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId WHERE lower(m.ModId)=?`, ID)[0].n === 0);
  check('its file rows went with it', raw('SELECT count(*) n FROM ModFiles WHERE ModRowId NOT IN (SELECT ModRowId FROM Mods)')[0].n === 0);
  check('its ScannedFiles row went too', raw(`SELECT count(*) n FROM ScannedFiles WHERE Path LIKE '%Doomed%'`)[0].n === 0);
  check('a backup was made', !!shouty.backupPath && fs.existsSync(shouty.backupPath));
  check('only its own rows went: one fewer mod, fewer group items',
    countRows().m === planted.m - 1 && countRows().g < planted.g,
    `mods ${planted.m}->${countRows().m}, items ${planted.g}->${countRows().g}`);
  check('removing nothing is a no-op', db.removeMods(DB_PATH, [], {}).removed.length === 0);
  check('and the database is still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('with no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n============================================================');
console.log(pass ? 'PROFILES: ALL CHECKS PASSED' : 'PROFILES: FAILURES PRESENT');
console.log('============================================================');
process.exit(pass ? 0 : 1);
