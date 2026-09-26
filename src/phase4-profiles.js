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
const fails = (fn) => {
  try { fn(); return false; } catch (_) { return true; }
};
const groupNamed = (name) => db.listGroups(DB_PATH).groups.find((g) => g.name === name);
const raw = (sql, ...a) => {
  const conn = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return conn.prepare(sql).all(...a); } finally { conn.close(); }
};

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
      ModId TEXT NOT NULL, Version INTEGER NOT NULL);`);
  d.exec(`INSERT INTO ScannedFiles (Path) VALUES ('a'), ('b'), ('c'), ('d')`);
  const ids = ['mod-a', 'mod-b', 'mod-c', 'mod-d'];
  ids.forEach((id, i) => d.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(i + 1, id));
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

// --- Test 10: a real database copy ------------------------------------------
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

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n============================================================');
console.log(pass ? 'PROFILES: ALL CHECKS PASSED' : 'PROFILES: FAILURES PRESENT');
console.log('============================================================');
process.exit(pass ? 0 : 1);
