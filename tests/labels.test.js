'use strict';

// node:test suite cut over from src/phase5-labels.js (Tests 1-11).
//
// One it() per check(), fixtures and expectations verbatim, so the
// check()-to-it() count gate (124) proves 1:1 cover. Run the whole file with
// `node --test tests/labels.test.js`, or one slice with
// `node --test --test-name-pattern="<name>" tests/labels.test.js`
// (this Node rejects the `-t` shorthand — always spell it out).
//
// Cut over in cutover-gate-to-node-test: the phase script is deleted and
// this file is authoritative.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const labels = require('../src/labels');
const { scanMods } = require('../src/modinfo');
// Deliberately not labels.js's own key: the point is to check that the store
// keys by the same normalisation the mod list does, and using its own function
// here would hide it if it ever stopped.
const { normId } = require('../src/modinfo');
const { makeTmp } = require('./helpers');

const TMP = makeTmp('civ6-labels-');
const FILE = path.join(TMP, 'mod-labels.json');

const put = (obj) => fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const ID_A = '521b8777-0977-4859-a5ee-3e411a732e5c';
const ID_B = 'fdf9c98a-1111-4222-8333-444455556666';
const SAMPLE = { version: 1, labels: { [ID_A]: ['favourite'], [ID_B]: ['favourite', 'needs-testing'] } };

function cap(fn, ...args) {
  try { fn(...args); return ''; } catch (e) { return e.message; }
}

describe('Test 1: no file, no labels', () => {
  it('a missing file reads as no labels', () => {
    assert.equal(Object.keys(labels.readLabels(FILE).labels).length, 0);
  });
  it('  and says nothing is wrong', () => {
    assert.equal(labels.readLabels(FILE).error, null);
  });
  it('  and nothing was pruned', () => {
    assert.equal(labels.readLabels(FILE).pruned, 0);
  });
  it('  and the label list is empty', () => {
    const v = labels.readLabels(FILE);
    assert.ok(v.names.length === 0 && v.counts.length === 0);
  });
});

describe('Test 2: empty and malformed files still load the mod list', () => {
  it('an empty file reads as no labels', () => {
    put('');
    assert.equal(Object.keys(labels.readLabels(FILE).labels).length, 0);
  });
  it('a whitespace-only file reads as no labels', () => {
    put('   \n\t  ');
    assert.equal(Object.keys(labels.readLabels(FILE).labels).length, 0);
  });
  it('  and is not reported as an error', () => {
    assert.equal(labels.readLabels(FILE).error, null);
  });
  it('a syntax error yields no labels', () => {
    put('{ this is not json');
    assert.equal(Object.keys(labels.readLabels(FILE).labels).length, 0);
  });
  it('  and a message saying why', () => {
    const broken = labels.readLabels(FILE);
    assert.ok(/not valid JSON/.test(broken.error || ''), String(broken.error));
  });
  it('a JSON array is refused', () => {
    put('[1, 2, 3]');
    assert.ok(/does not contain an object/.test(labels.readLabels(FILE).error || ''));
  });
  it('a labels value that is not an object is refused', () => {
    put({ version: 1, labels: 'nope' });
    assert.ok(/no "labels" object/.test(labels.readLabels(FILE).error || ''));
  });
  it('a version we did not write is refused whole', () => {
    put({ version: 99, labels: { [ID_A]: ['favourite'] } });
    const future = labels.readLabels(FILE);
    assert.ok(future.labels[normId(ID_A)] === undefined
      && /version 99/.test(future.error || ''), String(future.error));
  });
  it('a good entry survives a bad one', () => {
    put({ version: 1, labels: { [ID_A]: ['favourite'], 'not-an-array': 'oops', '': ['x'], [ID_B]: 'no' } });
    const mixed = labels.readLabels(FILE);
    assert.ok(!!mixed.labels[normId(ID_A)], JSON.stringify(mixed.labels));
  });
  it('  and the bad ones are reported', () => {
    const mixed = labels.readLabels(FILE);
    assert.ok(/could not be read/.test(mixed.error || ''), String(mixed.error));
  });
  it('  and none of the bad ones became keys', () => {
    const mixed = labels.readLabels(FILE);
    assert.ok(!Object.keys(mixed.labels).some((k) => k === 'not-an-array' || k === ''));
  });
  it('an unreadable path is reported, not silently empty', () => {
    fs.rmSync(FILE, { force: true });
    fs.mkdirSync(FILE);
    assert.ok(!!labels.readLabels(FILE).error);
    fs.rmdirSync(FILE);
  });
});

describe('Test 3: counts, names and key normalisation', () => {
  it('both mods have their labels', () => {
    put(SAMPLE);
    const v = labels.readLabels(FILE);
    const a = normId(ID_A);
    const b = normId(ID_B);
    assert.ok((v.labels[a] || []).join() === 'favourite' && (v.labels[b] || []).join() === 'favourite,needs-testing');
  });
  it('a label on two mods counts two', () => {
    assert.equal(labels.readLabels(FILE).counts.find((c) => c.name === 'favourite').count, 2);
  });
  it('a label on one mod counts one', () => {
    assert.equal(labels.readLabels(FILE).counts.find((c) => c.name === 'needs-testing').count, 1);
  });
  it('counts come back most-used first', () => {
    assert.equal(labels.readLabels(FILE).counts[0].name, 'favourite');
  });
  it('the editor list is alphabetical', () => {
    assert.equal(labels.readLabels(FILE).names.join(), 'favourite,needs-testing');
  });
  it('a well-formed file reports no error', () => {
    assert.equal(labels.readLabels(FILE).error, null);
  });
  it('braces and case in a key make no difference', () => {
    put({ version: 1, labels: { [`{${ID_A.toUpperCase()}}`]: ['favourite'], [ID_B.toUpperCase()]: ['favourite'] } });
    const cased = labels.readLabels(FILE);
    const a = normId(ID_A);
    const b = normId(ID_B);
    assert.ok(!!(cased.labels[a] && cased.labels[b]), JSON.stringify(Object.keys(cased.labels)));
  });
  it('  and it is still two mods on the label', () => {
    assert.equal(labels.readLabels(FILE).counts.find((c) => c.name === 'favourite').count, 2);
  });
  it('a file with no version field still loads', () => {
    put({ labels: { [ID_A]: ['favourite'] } });
    assert.ok(!!labels.readLabels(FILE).labels[normId(ID_A)]);
  });
});

describe('Test 4: pruning orphans', () => {
  it('a label for a mod that is not there is dropped', () => {
    put(SAMPLE);
    const a = normId(ID_A);
    const b = normId(ID_B);
    const known = new Set([a]); // mod B is gone from the list
    const v = labels.readLabels(FILE, known);
    assert.ok(v.labels[a] && v.labels[b] === undefined, JSON.stringify(Object.keys(v.labels)));
  });
  it('  and is counted', () => {
    const v = labels.readLabels(FILE, new Set([normId(ID_A)]));
    assert.equal(v.pruned, 1, `pruned=${v.pruned}`);
  });
  it('  and its label stops being offered', () => {
    const v = labels.readLabels(FILE, new Set([normId(ID_A)]));
    assert.ok(!v.names.includes('needs-testing'), v.names.join());
  });
  it('a read never writes', () => {
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).labels).length, 2);
  });
  it('an unvouched set prunes nothing', () => {
    const unsure = labels.readLabels(FILE, null);
    assert.ok(Object.keys(unsure.labels).length === 2 && unsure.pruned === 0);
  });
});

describe('Test 5: what a label may be called', () => {
  it('surrounding space is trimmed', () => {
    assert.equal(labels.cleanLabel('  favourite  '), 'favourite');
  });
  it('a name at the cap is kept', () => {
    assert.equal(labels.cleanLabel('x'.repeat(100)).length, 100);
  });
  it('an over-long name is refused', () => {
    assert.ok(/longer than 100/.test(cap(labels.cleanLabel, 'x'.repeat(101))));
  });
  it('an empty name is refused', () => {
    assert.ok(/cannot be empty/.test(cap(labels.cleanLabel, '')));
  });
  it('a whitespace-only name is refused', () => {
    assert.ok(/cannot be empty/.test(cap(labels.cleanLabel, '   ')));
  });
  it('so is no name at all', () => {
    assert.ok(/cannot be empty/.test(cap(labels.cleanLabel, null)));
  });
});

describe('Test 6: writing a label', () => {
  const a = normId(ID_A);
  const known = new Set([a, normId(ID_B)]);
  let two;
  let dup;
  let afterB;
  let afterA;
  let both;
  it('a label is written and read back', () => {
    fs.rmSync(FILE, { force: true });
    const v = labels.setLabels(FILE, ID_A, ['favourite'], known);
    assert.ok(v.labels[a] && v.labels[a][0] === 'favourite', JSON.stringify(v.labels));
  });
  it('the file appears on disk', () => {
    assert.ok(fs.existsSync(FILE));
  });
  it('  with the version it was written as', () => {
    assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).version, 1);
  });
  it('  and no temp file left beside it', () => {
    assert.ok(!fs.readdirSync(TMP).some((f) => /\.tmp-/.test(f)), fs.readdirSync(TMP).join());
  });
  it('the same label on another mod counts twice', () => {
    two = labels.setLabels(FILE, ID_B, ['Favourite', '  needs-testing  '], known);
    assert.equal(two.counts.find((c) => c.name === 'favourite').count, 2, JSON.stringify(two.counts));
  });
  it('case-insensitive: it did not become a second label', () => {
    assert.equal(labels.readLabels(FILE, known).names.length, 2, labels.readLabels(FILE, known).names.join());
  });
  it('  and it took the spelling created first', () => {
    assert.ok(!!labels.readLabels(FILE, known).labels[normId(ID_B)].includes('favourite'),
      JSON.stringify(labels.readLabels(FILE, known).labels[normId(ID_B)]));
  });
  it('names are trimmed on the way in', () => {
    assert.ok(labels.readLabels(FILE, known).labels[normId(ID_B)].includes('needs-testing'));
  });
  it('a mod can carry several labels', () => {
    assert.equal(labels.readLabels(FILE, known).labels[normId(ID_B)].length, 2);
  });
  it('the same name three times in one request is stored once', () => {
    dup = labels.setLabels(FILE, ID_B, ['favourite', 'FAVOURITE', 'favourite'], known);
    assert.equal(dup.labels[normId(ID_B)].length, 1, JSON.stringify(dup.labels[normId(ID_B)]));
  });
  it("removing a mod's last label leaves no empty entry", () => {
    afterB = labels.setLabels(FILE, ID_B, [], known);
    assert.equal(afterB.labels[normId(ID_B)], undefined, JSON.stringify(afterB.labels));
  });
  it('  but the label stays while another mod still carries it', () => {
    assert.ok(labels.readLabels(FILE, known).names.includes('favourite'), labels.readLabels(FILE, known).names.join());
  });
  it('once no mod carries it the label stops existing', () => {
    afterA = labels.setLabels(FILE, ID_A, [], known);
    assert.ok(!afterA.names.includes('favourite'), afterA.names.join());
  });
  it('  and nothing is left in the file', () => {
    assert.ok(Object.keys(afterA.labels).length === 0 && afterA.counts.length === 0);
  });
  it('two saves to different mods both survive', () => {
    labels.setLabels(FILE, ID_A, ['favourite'], known);
    labels.setLabels(FILE, ID_B, ['mp-safe'], known);
    both = labels.readLabels(FILE, known);
    assert.ok(!!both.labels[a] && !!both.labels[normId(ID_B)] && both.labels[normId(ID_B)][0] === 'mp-safe',
      JSON.stringify(both.labels));
  });
  it('a bad name in the request is refused whole', () => {
    assert.ok(/cannot be empty/.test(cap(labels.setLabels, FILE, ID_A, ['ok', '  '], known)));
  });
  it('  and nothing was written', () => {
    assert.equal(JSON.stringify(labels.readLabels(FILE, known).labels), JSON.stringify(both.labels));
  });
  it('an over-long name is refused too', () => {
    assert.ok(/longer than 100/.test(cap(labels.setLabels, FILE, ID_A, ['x'.repeat(101)], known)));
  });
  it('a mod id of nothing is refused', () => {
    assert.ok(/which mod/.test(cap(labels.setLabels, FILE, '', ['a'], known)));
  });
});

describe('Test 7: two saves in quick succession', () => {
  it('every save landed', () => {
    const known = new Set([normId(ID_A), normId(ID_B)]);
    fs.rmSync(FILE, { force: true });
    labels.setLabels(FILE, ID_A, ['one'], known);
    labels.setLabels(FILE, ID_B, ['two'], known);
    labels.setLabels(FILE, ID_A, ['three'], known);
    const v = labels.readLabels(FILE, known);
    assert.ok(v.labels[normId(ID_A)][0] === 'three' && v.labels[normId(ID_B)][0] === 'two',
      JSON.stringify(v.labels));
  });
  it('the file is still valid JSON', () => {
    assert.ok((() => {
      try { JSON.parse(fs.readFileSync(FILE, 'utf8')); return true; } catch (_) { return false; }
    })());
  });
  it('and no temp file was left behind', () => {
    assert.equal(fs.readdirSync(TMP).join(), 'mod-labels.json', fs.readdirSync(TMP).join());
  });
});

describe('Test 8: writing over a broken file', () => {
  const known = new Set([normId(ID_A)]);
  it('a save over a corrupt file is refused', () => {
    put('{ broken');
    const msg = cap(labels.setLabels, FILE, ID_A, ['favourite'], known);
    assert.ok(/not valid JSON/.test(msg), msg);
  });
  it('  and the message says nothing was written', () => {
    const msg = cap(labels.setLabels, FILE, ID_A, ['favourite'], known);
    assert.ok(/nothing was written/.test(msg), msg);
  });
  it('  and the file is left exactly as it was', () => {
    assert.equal(fs.readFileSync(FILE, 'utf8'), '{ broken');
  });
  it('  and the mod list still reads, as no labels', () => {
    assert.equal(Object.keys(labels.readLabels(FILE).labels).length, 0);
  });
  it('a file of the wrong version is refused the same way', () => {
    put({ version: 42, labels: {} });
    assert.ok(/nothing was written/.test(cap(labels.setLabels, FILE, ID_A, ['x'], known)));
  });
  it('a file with one bad entry is still writable', () => {
    put({ version: 1, labels: { [ID_A]: ['keep'], bad: 'oops' } });
    const ok = labels.setLabels(FILE, ID_A, ['keep', 'added'], known);
    assert.ok(ok.labels[normId(ID_A)].join() === 'keep,added', JSON.stringify(ok.labels));
  });
  it('  and the bad entry is gone from the file', () => {
    assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(FILE, 'utf8'))).includes('oops'));
  });
});

describe('Test 9: labels survive a rescan', () => {
  const modsDir = path.join(TMP, 'mods');
  const local = path.join(modsDir, 'Local');
  const workshop = path.join(modsDir, 'Workshop');
  const GUID_1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const GUID_2 = 'bbbbbbbb-2222-4222-8222-222222222222';
  const sources = [{ type: 'local', label: 'local', root: local, exists: true }];
  const dbPath = path.join(TMP, 'Mods.sqlite');
  let ids;
  let before;
  let after;
  let moved;
  const plant = (root, folder, id, name) => {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, folder, `${folder}.modinfo`),
      `<?xml version="1.0" encoding="utf-8"?>\n<Mod id="${id}">\n\t<Properties>\n\t\t<Name>${name}</Name>\n\t</Properties>\n</Mod>\n`);
    return id;
  };
  const seed = () => {
    fs.rmSync(dbPath, { force: true });
    const d = new DatabaseSync(dbPath);
    d.exec('CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModId TEXT NOT NULL);');
    for (const id of [GUID_1, GUID_2]) d.prepare('INSERT INTO Mods (ModId) VALUES (?)').run(id);
    d.close();
  };
  const rowIds = () => {
    const d = new DatabaseSync(dbPath, { readOnly: true });
    try { return Object.fromEntries(d.prepare('SELECT ModRowId, ModId FROM Mods').all().map((r) => [normId(r.ModId), r.ModRowId])); }
    finally { d.close(); }
  };
  it('the scanner finds both mods', () => {
    for (const d of [local, workshop]) fs.mkdirSync(d, { recursive: true });
    plant(local, 'Mover', GUID_1, 'Mover');
    plant(local, 'Stayer', GUID_2, 'Stayer');
    const found = scanMods(sources);
    ids = new Set(found.map((m) => m.idNorm));
    assert.equal(found.length, 2, `${found.length} found`);
  });
  it('  by the GUID from their .modinfo', () => {
    assert.ok(ids.has(normId(GUID_1)) && ids.has(normId(GUID_2)));
    labels.setLabels(FILE, GUID_1, ['favourite'], ids);
    labels.setLabels(FILE, GUID_2, ['favourite', 'needs-testing'], ids);
  });
  it('the rescan really did renumber the rows', () => {
    seed();
    before = rowIds();
    const d = new DatabaseSync(dbPath);
    d.exec('UPDATE Mods SET ModRowId = ModRowId + 1000');
    d.close();
    after = rowIds();
    assert.ok(before[normId(GUID_1)] !== after[normId(GUID_1)] && before[normId(GUID_2)] !== after[normId(GUID_2)],
      `${before[normId(GUID_1)]}->${after[normId(GUID_1)]}, ${before[normId(GUID_2)]}->${after[normId(GUID_2)]}`);
  });
  it('every label is still attached to the same mod', () => {
    const v = labels.readLabels(FILE, ids);
    assert.ok(v.labels[normId(GUID_1)].join() === 'favourite' && v.labels[normId(GUID_2)].join() === 'favourite,needs-testing',
      JSON.stringify(v.labels));
  });
  it('  and nothing was pruned as an orphan', () => {
    const v = labels.readLabels(FILE, ids);
    assert.equal(v.pruned, 0, `pruned=${v.pruned}`);
  });
  it('a file keyed by ModRowId loses the label on rescan, as it must', () => {
    put({ version: 1, labels: { [String(before[normId(GUID_1)])]: ['favourite'] } });
    const byRow = labels.readLabels(FILE, ids);
    assert.ok(byRow.labels[normId(GUID_1)] === undefined && byRow.pruned === 1,
      JSON.stringify(byRow.labels));
  });
  it('the mod is found in its new home', () => {
    labels.setLabels(FILE, GUID_1, ['favourite', 'mp-safe'], ids);
    const wsFolder = path.join(workshop, '12345');
    fs.renameSync(path.join(local, 'Mover'), wsFolder);
    const both = [...sources, { type: 'workshop', label: 'workshop', root: workshop, exists: true }];
    moved = scanMods(both);
    const movedMod = moved.find((m) => m.idNorm === normId(GUID_1));
    assert.ok(!!movedMod, moved.map((m) => `${m.name}:${m.type}`).join());
  });
  it('  and it is now a workshop mod', () => {
    const movedMod = moved.find((m) => m.idNorm === normId(GUID_1));
    assert.ok(movedMod && movedMod.type === 'workshop');
  });
  it('  and both of its labels came with it', () => {
    const after2 = labels.readLabels(FILE, new Set(moved.map((m) => m.idNorm)));
    assert.ok(after2.labels[normId(GUID_1)].join() === 'favourite,mp-safe', JSON.stringify(after2.labels[normId(GUID_1)]));
  });
});

describe('Test 10: wiring — the decisions the server makes about labels', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'mods.js'), 'utf8');
  const block = (name) => {
    const at = srv.indexOf(`'${name}'`);
    return at === -1 ? '' : srv.slice(at, srv.indexOf('\n  }', at));
  };
  const labelsRoute = block('/api/mods/labels');
  const modsRoute = block('/api/mods');
  const matches = /function matchesLabels\(m\) \{([\s\S]*?)\n\}/.exec(page);
  it('there is a labels route', () => {
    assert.ok(!!labelsRoute);
  });
  it('the labels write is NOT refused while Civ6 runs', () => {
    assert.ok(labelsRoute && !/game\.running\s*\)\s*return send\(res, 409/.test(labelsRoute), labelsRoute.slice(0, 200));
  });
  it('  and it does read the game status, for pruning rather than refusal', () => {
    assert.ok(/await gameStatus\(\)/.test(labelsRoute));
  });
  it('pruning is opt-in, so a caller that cannot vouch for its list gets no prune', () => {
    assert.ok(/modList\(opts = \{\}\)/.test(srv) && /opts\.prune \? new Set/.test(srv));
  });
  it('  and /api/mods only opts in when the game is closed', () => {
    assert.ok(/modList\(\{ prune: !game\.running \}\)/.test(modsRoute), modsRoute.slice(0, 200));
  });
  it('a label the server will not accept is a 400', () => {
    assert.ok(/400, \{ error: e\.message \}/.test(labelsRoute));
  });
  it('a file we cannot read is a 500, and says nothing was written', () => {
    assert.ok(/500, \{ error: e\.message \}/.test(labelsRoute));
  });
  it('the whole file is never sent by the page, only one mod id', () => {
    assert.ok(/postJson\('\/api\/mods\/labels', \{ id: idNorm, labels: labelEdit\.names \}\)/.test(page));
  });
  it('a multi-label filter is a union, not an intersection', () => {
    assert.ok(matches && /\.some\(/.test(matches[1]) && !/\.every\(/.test(matches[1]),
      matches ? matches[1].trim() : 'matchesLabels not found');
  });
  it('  and the filter narrows the visible list rather than replacing it', () => {
    assert.ok(/SRC_MATCH\[modsPage\.src\]\(m\)\s*\n\s*&& matchesLabels\(m\)/.test(page));
  });
  it('  and it is a Set, so several labels can be selected at once', () => {
    assert.ok(/labels: new Set\(\)/.test(page) && /modsPage\.labels\.(add|delete|has)\(/.test(page));
  });
  it('  and a label that no longer exists leaves the selection', () => {
    assert.ok(/if \(!live\.has\(k\)\) modsPage\.labels\.delete\(k\)/.test(page));
  });
  it('a label can be renamed across every mod that has it', () => {
    assert.ok(/url\.pathname === '\/api\/mods\/labels\/rename'/.test(srv) && /labelStore\.renameLabel/.test(srv));
  });
  it('and deleted across every mod that has it', () => {
    assert.ok(/url\.pathname === '\/api\/mods\/labels\/delete'/.test(srv) && /labelStore\.deleteLabel/.test(srv));
  });
  it('  and the rename reports how many mods moved, and whether it merged', () => {
    assert.ok(/moved: v\.moved, merged: v\.merged/.test(srv));
  });
  it('  and neither is refused while Civ6 runs, like the other label writes', () => {
    assert.ok(!/409/.test(block('/api/mods/labels/rename')) && !/409/.test(block('/api/mods/labels/delete')));
  });
  it('  and it re-reads the file rather than trusting the page', () => {
    assert.ok(/labelStore\.renameLabel\(labelStore\.labelsFile\(\), body\.from, to,/.test(srv));
  });
});

describe('Test 11: rename and delete', () => {
  const A = normId(ID_A);
  const B = normId(ID_B);
  const known = new Set([A, B]);
  let v;
  const seed = () => labels.writeLabels(FILE, {
    [A]: ['favourite', 'mp-safe'],
    [B]: ['favourite', 'needs-testing'],
  });
  it('a rename reaches every mod that carried the label', () => {
    seed();
    v = labels.renameLabel(FILE, 'favourite', 'starred', known);
    assert.equal(v.moved, 2, `moved=${v.moved}`);
  });
  it('  the new name is on both of them', () => {
    assert.ok(v.labels[A].includes('starred') && v.labels[B].includes('starred'), JSON.stringify(v.labels));
  });
  it('  the old name is on neither', () => {
    assert.ok(!v.names.includes('favourite'), v.names.join());
  });
  it('  and the other labels are untouched', () => {
    assert.equal(v.labels[A].join(), 'starred,mp-safe', JSON.stringify(v.labels[A]));
  });
  it('  and the count followed the rename', () => {
    assert.equal((v.counts.find((c) => c.name === 'starred') || {}).count, 2);
  });
  it('a rename is not reported as a merge', () => {
    assert.equal(v.merged, false);
  });
  it('renaming onto an existing label merges the two', () => {
    v = labels.renameLabel(FILE, 'starred', 'MP-Safe', known);
    assert.ok(v.moved === 2 && v.merged === true, `moved=${v.moved} merged=${v.merged}`);
  });
  it('  every mod ends up with one label, not two', () => {
    assert.equal(v.names.length, 2, v.names.join());
  });
  it('  and it took the spelling already in use', () => {
    assert.ok(v.names.includes('mp-safe') && !v.names.includes('MP-Safe'), v.names.join());
  });
  it('  the mod that had both keeps just the target', () => {
    assert.equal((v.labels[A] || []).join(), 'mp-safe', JSON.stringify(v.labels[A]));
  });
  it('  and the one that had only the old name gains the target', () => {
    assert.equal((v.labels[B] || []).join(), 'mp-safe,needs-testing', JSON.stringify(v.labels[B]));
  });
  it('a rename that only changes case keeps one label', () => {
    seed();
    v = labels.renameLabel(FILE, 'favourite', 'FAVOURITE', known);
    assert.equal(v.names.length, 3, v.names.join());
  });
  it('  and does not report a merge', () => {
    assert.equal(v.merged, false);
  });
  it('  the spelling on file is the one that was there', () => {
    assert.ok(v.names.includes('favourite'));
  });
  it('renaming a label nothing carries is refused', () => {
    assert.ok(/no mod is labelled/.test(cap(labels.renameLabel, FILE, 'nope', 'x', known)));
  });
  it('  and nothing was written', () => {
    assert.ok(!labels.readLabels(FILE, known).names.includes('x'));
  });
  it('renaming to an empty name is refused', () => {
    assert.ok(/cannot be empty/.test(cap(labels.renameLabel, FILE, 'favourite', '  ', known)));
  });
  it('renaming to an over-long name is refused', () => {
    assert.ok(/longer than 100/.test(cap(labels.renameLabel, FILE, 'favourite', 'y'.repeat(101), known)));
  });
  it('renaming nothing at all is refused', () => {
    assert.ok(/which label/.test(cap(labels.renameLabel, FILE, '', 'x', known)));
  });
  it('a rename over a corrupt file is refused', () => {
    put('{ broken');
    const m = cap(labels.renameLabel, FILE, 'a', 'b', known);
    put(JSON.stringify({ version: 1, labels: { [A]: ['favourite'], [B]: ['mp-safe'] } }));
    assert.ok(/nothing was written/.test(m));
  });
  it('a delete reports how many mods it came off', () => {
    seed();
    v = labels.deleteLabel(FILE, 'favourite', known);
    assert.equal(v.removed, 2, `removed=${v.removed}`);
  });
  it('  and none of them has it any more', () => {
    assert.ok(!v.names.includes('favourite'), v.names.join());
  });
  it('  and the other labels survived', () => {
    assert.ok(v.names.includes('mp-safe') && v.names.includes('needs-testing'), v.names.join());
  });
  it('  a mod with another label keeps it', () => {
    assert.equal(v.labels[A].join(), 'mp-safe', JSON.stringify(v.labels[A]));
  });
  it('a mod left with no labels loses its entry entirely', () => {
    labels.writeLabels(FILE, { [A]: ['lonely'], [B]: ['favourite', 'needs-testing'] });
    v = labels.deleteLabel(FILE, 'lonely', known);
    assert.equal(v.labels[A], undefined, JSON.stringify(v.labels[A]));
  });
  it('  so it cannot come back if the label is reused', () => {
    assert.ok(!v.names.includes('lonely'), v.names.join());
  });
  it('deleting a label nothing carries is refused', () => {
    assert.ok(/no mod is labelled/.test(cap(labels.deleteLabel, FILE, 'nothing', known)));
  });
  it('deleting nothing at all is refused', () => {
    assert.ok(/which label/.test(cap(labels.deleteLabel, FILE, '', known)));
  });
  it('a delete over a corrupt file is refused', () => {
    put('{ broken');
    const m = cap(labels.deleteLabel, FILE, 'a', known);
    put(JSON.stringify({ version: 1, labels: { [A]: ['favourite'] } }));
    assert.ok(/nothing was written/.test(m));
  });
  it('a delete matches without regard to case', () => {
    labels.writeLabels(FILE, { [A]: ['Favourite'] });
    assert.equal(labels.deleteLabel(FILE, 'favourite', known).removed, 1);
  });
  it('  and leaves nothing behind', () => {
    assert.equal(Object.keys(labels.readLabels(FILE, known).labels).length, 0);
  });
  it('an unvouched set keeps the entry during a read', () => {
    labels.writeLabels(FILE, { [A]: ['favourite'], 'someone-elses': ['other'] });
    const deferred = labels.readLabels(FILE, null);
    assert.equal(Object.keys(deferred.labels).length, 2);
  });
  it('  and a delete only touches what it can see', () => {
    assert.ok(labels.deleteLabel(FILE, 'other', null).removed === 1 && !labels.readLabels(FILE, null).labels['someone-elses']);
  });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
