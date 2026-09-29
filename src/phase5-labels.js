'use strict';

// Phase 5 automated proof: user-defined mod labels.
//
// Operates only on a synthetic labels file in a scratch dir. A real
// mod-labels.json is never read or written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const labels = require('./labels');
// Deliberately not labels.js's own key: the point is to check that the store
// keys by the same normalisation the mod list does, and using its own function
// here would hide it if it ever stopped.
const { normId } = require('./modinfo');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-labels-'));
const FILE = path.join(TMP, 'mod-labels.json');
console.log(`scratch dir: ${TMP}\n`);

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};
const put = (obj) => fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const ID_A = '521b8777-0977-4859-a5ee-3e411a732e5c';
const ID_B = 'fdf9c98a-1111-4222-8333-444455556666';
const SAMPLE = { version: 1, labels: { [ID_A]: ['favourite'], [ID_B]: ['favourite', 'needs-testing'] } };

// --- Test 1: a file that is not there is not a failure -----------------------
console.log('Test 1: no file, no labels');
{
  const v = labels.readLabels(FILE);
  check('a missing file reads as no labels', Object.keys(v.labels).length === 0);
  check('  and says nothing is wrong', v.error === null, String(v.error));
  check('  and nothing was pruned', v.pruned === 0);
  check('  and the label list is empty', v.names.length === 0 && v.counts.length === 0);
}

// --- Test 2: empty and malformed --------------------------------------------
console.log('\nTest 2: empty and malformed files still load the mod list');
{
  put('');
  check('an empty file reads as no labels', Object.keys(labels.readLabels(FILE).labels).length === 0);
  put('   \n\t  ');
  check('a whitespace-only file reads as no labels', Object.keys(labels.readLabels(FILE).labels).length === 0);
  check('  and is not reported as an error', labels.readLabels(FILE).error === null);

  put('{ this is not json');
  const broken = labels.readLabels(FILE);
  check('a syntax error yields no labels', Object.keys(broken.labels).length === 0);
  check('  and a message saying why', /not valid JSON/.test(broken.error || ''), String(broken.error));

  put('[1, 2, 3]');
  check('a JSON array is refused', /does not contain an object/.test(labels.readLabels(FILE).error || ''));
  put({ version: 1, labels: 'nope' });
  check('a labels value that is not an object is refused', /no "labels" object/.test(labels.readLabels(FILE).error || ''));
  put({ version: 99, labels: { [ID_A]: ['favourite'] } });
  const future = labels.readLabels(FILE);
  check('a version we did not write is refused whole', future.labels[normId(ID_A)] === undefined
    && /version 99/.test(future.error || ''), String(future.error));

  // One bad entry must not cost the good ones: the file is valid JSON, and only
  // the entry that is not an array of names is unreadable.
  put({ version: 1, labels: { [ID_A]: ['favourite'], 'not-an-array': 'oops', '': ['x'], [ID_B]: 'no' } });
  const mixed = labels.readLabels(FILE);
  check('a good entry survives a bad one', !!mixed.labels[normId(ID_A)], JSON.stringify(mixed.labels));
  check('  and the bad ones are reported', /could not be read/.test(mixed.error || ''), String(mixed.error));
  check('  and none of the bad ones became keys',
    !Object.keys(mixed.labels).some((k) => k === 'not-an-array' || k === ''));

  // A directory in the file's place is an unreadable file, not a missing one:
  // it should say so rather than claim there is nothing there.
  fs.rmSync(FILE, { force: true });
  fs.mkdirSync(FILE);
  check('an unreadable path is reported, not silently empty', !!labels.readLabels(FILE).error);
  fs.rmdirSync(FILE);
}

// --- Test 3: reading a good file --------------------------------------------
console.log('\nTest 3: counts, names and key normalisation');
{
  put(SAMPLE);
  const v = labels.readLabels(FILE);
  const a = normId(ID_A);
  const b = normId(ID_B);
  check('both mods have their labels', (v.labels[a] || []).join() === 'favourite' && (v.labels[b] || []).join() === 'favourite,needs-testing');
  check('a label on two mods counts two', v.counts.find((c) => c.name === 'favourite').count === 2);
  check('a label on one mod counts one', v.counts.find((c) => c.name === 'needs-testing').count === 1);
  check('counts come back most-used first', v.counts[0].name === 'favourite');
  check('the editor list is alphabetical', v.names.join() === 'favourite,needs-testing', v.names.join());
  check('a well-formed file reports no error', v.error === null, String(v.error));

  // The game, .Civ6Cfg files and hand edits all spell a GUID differently.
  put({ version: 1, labels: { [`{${ID_A.toUpperCase()}}`]: ['favourite'], [ID_B.toUpperCase()]: ['favourite'] } });
  const cased = labels.readLabels(FILE);
  check('braces and case in a key make no difference', !!(cased.labels[a] && cased.labels[b]),
    JSON.stringify(Object.keys(cased.labels)));
  check('  and it is still two mods on the label', cased.counts.find((c) => c.name === 'favourite').count === 2);

  put({ labels: { [ID_A]: ['favourite'] } });
  check('a file with no version field still loads', !!labels.readLabels(FILE).labels[a]);
}

// --- Test 4: pruning --------------------------------------------------------
console.log('\nTest 4: pruning orphans');
{
  put(SAMPLE);
  const a = normId(ID_A);
  const b = normId(ID_B);
  const known = new Set([a]); // mod B is gone from the list
  const v = labels.readLabels(FILE, known);
  check('a label for a mod that is not there is dropped', v.labels[a] && v.labels[b] === undefined,
    JSON.stringify(Object.keys(v.labels)));
  check('  and is counted', v.pruned === 1, `pruned=${v.pruned}`);
  check('  and its label stops being offered', !v.names.includes('needs-testing'), v.names.join());

  // The read must not have touched the file: pruning only becomes permanent
  // when something is written.
  check('a read never writes', Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).labels).length === 2);

  // An incomplete list is not a statement about which mods exist. Pruning
  // against one is how criterion 4 would be met by breaking criterion 2.
  const unsure = labels.readLabels(FILE, null);
  check('an unvouched set prunes nothing', Object.keys(unsure.labels).length === 2 && unsure.pruned === 0);
}

// --- Test 5: label names ----------------------------------------------------
console.log('\nTest 5: what a label may be called');
{
  check('surrounding space is trimmed', labels.cleanLabel('  favourite  ') === 'favourite');
  check('a name at the cap is kept', labels.cleanLabel('x'.repeat(100)).length === 100);
  check('an over-long name is refused', /longer than 100/.test(cap(labels.cleanLabel, 'x'.repeat(101))));
  check('an empty name is refused', /cannot be empty/.test(cap(labels.cleanLabel, '')));
  check('a whitespace-only name is refused', /cannot be empty/.test(cap(labels.cleanLabel, '   ')));
  check('so is no name at all', /cannot be empty/.test(cap(labels.cleanLabel, null)));
}

function cap(fn, arg) {
  try { fn(arg); return ''; } catch (e) { return e.message; }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n============================================================');
console.log(pass ? 'LABELS: ALL CHECKS PASSED' : 'LABELS: FAILURES PRESENT');
console.log('============================================================');
process.exit(pass ? 0 : 1);
