'use strict';

// node:test suite cut over from src/phase6-sorting.js (Tests 1-11).
//
// One it() per check(), labels and expectations verbatim, so the
// check(-to-it( count gate (59) proves 1:1 cover. Run the whole file with
// `node --test tests/sorting.test.js`, or one slice with
// `node --test tests/sorting.test.js -t "wiring"`.
//
// Cut over in cutover-gate-to-node-test: the phase script is deleted and
// this file is authoritative.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const sort = require('../public/modsort');

const readPage = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const names = (list) => list.map((m) => m.name);
const str = (list) => names(list).join(', ');

// Fixture kept verbatim from the deleted src/phase6-sorting.js library().
function library() {
  return [
    { name: 'Zeta', sortName: 'Zeta', source: 'local', enabled: false, labels: [] },
    { name: 'alpha', sortName: 'alpha', source: 'workshop', enabled: true, labels: ['favourite'] },
    { name: 'Bravo', sortName: 'Bravo', source: 'workshop', enabled: true, labels: ['mp-safe', 'favourite'] },
    { name: 'Delta', sortName: 'Delta', source: 'dlc', enabled: null, labels: ['favourite'] },
    { name: 'Echo', sortName: 'Echo', source: 'local', enabled: false, labels: ['needs-testing'], lastChanged: 1700000000000 },
    { name: 'Foxtrot', sortName: 'Foxtrot', source: 'workshop', enabled: false, labels: [], lastChanged: 1800000000000 },
    { name: 'Golf', sortName: 'Golf', source: 'workshop', enabled: true, labels: ['favourite'], lastChanged: null },
  ];
}
const ctx = {
  isOn: (m) => (m.name === 'Bravo' ? false : m.enabled === true),
  problemCount: (m) => (m.name === 'Foxtrot' ? 2 : m.name === 'Echo' ? 1 : 0),
};
const order = (key, list, context) => str(sort.sortMods(list || library(), key, context || ctx));
const at = (key, name, list, context) => str(sort.sortMods(list || library(), key, context || ctx)).split(', ').indexOf(name);

describe('Test 1: name, the default', () => {
  it('alphabetical, without regard to case', () => {
    assert.equal(order('name'), 'alpha, Bravo, Delta, Echo, Foxtrot, Golf, Zeta');
  });
  it('an unknown key falls back to name rather than throwing', () => {
    assert.equal(order('nonsense'), order('name'));
  });
  it('a mod with no sortName falls back to its name', () => {
    assert.equal(str(sort.sortMods([{ name: 'Solo', enabled: true }], 'name', ctx)), 'Solo');
  });
  it('a null sortName falls back to the name too, rather than throwing', () => {
    assert.equal(str(sort.sortMods([{ name: 'A', sortName: null }, { name: 'C', sortName: 'B' }], 'name', ctx)), 'A, C');
  });
});

describe('Test 2: state', () => {
  it('enabled first, then disabled, by name within each group', () => {
    assert.equal(order('state'), 'alpha, Golf, Bravo, Delta, Echo, Foxtrot, Zeta');
  });
  it('a pending change reads as the current state, not the saved one: Bravo is saved on and sorts as off', () => {
    assert.equal(at('state', 'Bravo'), 2);
  });
  it('enabled as null counts as not enabled, so DLC Delta sits with the disabled', () => {
    assert.equal(at('state', 'Delta'), 3);
  });
  it('with no isOn supplied it uses the mod\'s own enabled', () => {
    assert.equal(str(sort.sortMods([{ name: 'A', enabled: false }, { name: 'B', enabled: true }], 'state', {})), 'B, A');
  });
  it('  and two mods equal on the key fall back to name', () => {
    assert.equal(str(sort.sortMods([{ name: 'B', enabled: true }, { name: 'A', enabled: true }], 'state', {})), 'A, B');
  });
});

describe('Test 3: source', () => {
  it('workshop, then local, then DLC, by name within each', () => {
    assert.equal(order('source'), 'alpha, Bravo, Foxtrot, Golf, Echo, Zeta, Delta');
  });
  it('an unrecognised source sorts last rather than throwing', () => {
    assert.ok(sort.bySource({ source: 'weird' }, { source: 'workshop' }) > 0);
  });
  it('and base content would be after DLC, not before workshop', () => {
    assert.ok(sort.bySource({ source: 'base' }, { source: 'dlc' }) > 0 && sort.bySource({ source: 'base' }, { source: 'workshop' }) > 0);
  });
});

describe('Test 4: label', () => {
  it('by the first label, then the mods with none last', () => {
    assert.equal(order('label'), 'alpha, Delta, Golf, Bravo, Echo, Foxtrot, Zeta');
  });
  it('comparison is without regard to case', () => {
    assert.equal(sort.byLabel({ labels: ['Favourite'] }, { labels: ['favourite'] }), 0);
  });
  it('"first" is the array order, not the alphabetically first: mp-safe then favourite sorts under m', () => {
    assert.ok(sort.byLabel({ labels: ['zzz', 'aaa'] }, { labels: ['mmm'] }) > 0);
  });
  it('a label list of one behaves the same way', () => {
    assert.ok(sort.byLabel({ labels: ['favourite'] }, { labels: [] }) < 0);
  });
  it('two unlabelled mods tie and fall back to name', () => {
    assert.equal(sort.byLabel({ labels: [] }, { labels: [] }), 0);
  });
});

describe('Test 5: needs attention', () => {
  it('mods with problems first, then by name; two problems and one are the same group', () => {
    assert.equal(order('attention'), 'Echo, Foxtrot, alpha, Bravo, Delta, Golf, Zeta');
  });
  it('any number of problems outranks none', () => {
    assert.ok(sort.byAttention({ name: 'a' }, { name: 'b' }, { problemCount: (m) => (m.name === 'a' ? 1 : 0) }) < 0);
  });
  it('  including two against one, which are peers rather than ranked', () => {
    assert.equal(sort.byAttention({ name: 'a' }, { name: 'b' }, { problemCount: (m) => (m.name === 'a' ? 2 : 1) }), 0);
  });
  it('with no problemCount supplied nothing is a problem, so it is pure name order', () => {
    assert.equal(order('attention', null, {}), order('name', null, {}));
  });
});

describe('Test 6: last changed', () => {
  it('newest first, then the ones with no timestamp by name', () => {
    assert.equal(order('changed'), 'Foxtrot, Echo, alpha, Bravo, Delta, Golf, Zeta');
  });
  it('Golf has an explicit null and so sorts with the absent ones, not as epoch', () => {
    assert.equal(at('changed', 'Golf'), 5);
  });
  it('a non-numeric timestamp is treated as absent too', () => {
    assert.ok(sort.byChanged({ lastChanged: 'yesterday' }, { lastChanged: 1 }) > 0);
  });
  it('Infinity is absent, not the newest thing in the list', () => {
    assert.ok(sort.byChanged({ lastChanged: Infinity }, { lastChanged: 1 }) > 0);
  });
  it('a string that looks like a number is still not a timestamp', () => {
    assert.ok(sort.byChanged({ lastChanged: '1800000000000' }, { lastChanged: 1 }) > 0);
  });
  it('the key is offered when at least one mod has a timestamp', () => {
    assert.ok(sort.availableSorts(library()).map((s) => s.key).includes('changed'));
  });
  it('  and withheld when the server sent no timestamps at all - an older server', () => {
    assert.ok(!sort.availableSorts([{ name: 'A' }]).map((s) => s.key).includes('changed'));
  });
  it('  and withheld for an empty list', () => {
    assert.ok(!sort.availableSorts([]).map((s) => s.key).includes('changed'));
  });
  it('the other five keys are always offered', () => {
    assert.equal(sort.availableSorts([]).map((s) => s.key).join(), 'name,state,source,label,attention');
  });
});

describe('Test 7: sorting does not reorder the caller\'s data', () => {
  it('modsPage.data.mods is unchanged after sorting by all six keys', () => {
    const list = library();
    const before = list.map((m) => m.name).join();
    for (const key of sort.SORTS.map((s) => s.key)) sort.sortMods(list, key, ctx);
    assert.equal(list.map((m) => m.name).join(), before);
  });
});

describe('Test 8: re-sorting never shuffles equal rows', () => {
  it('every key reaches a fixed point within a few passes', () => {
    const keys = sort.SORTS.map((s) => s.key);
    const stuck = {};
    for (const key of keys) {
      let list = library();
      for (let pass = 0; pass < 6; pass++) {
        const next = sort.sortMods(list, key, ctx).map((m) => m.name).join();
        if (next === list.map((m) => m.name).join()) break;
        if (pass === 5) stuck[key] = next;
        list = sort.sortMods(list, key, ctx);
      }
    }
    assert.equal(Object.keys(stuck).length, 0);
  });
  it('every key keeps arrival order for mods equal on it', () => {
    const keys = sort.SORTS.map((s) => s.key);
    const tied = [
      { name: 'second', sortName: 'same', source: 'workshop', enabled: true, labels: ['x'] },
      { name: 'first', sortName: 'same', source: 'workshop', enabled: true, labels: ['x'] },
      { name: 'third', sortName: 'same', source: 'workshop', enabled: true, labels: ['x'] },
    ];
    const broke = [];
    for (const key of keys) {
      if (str(sort.sortMods(tied, key, ctx)) !== 'second, first, third') broke.push(key);
    }
    assert.deepEqual(broke, []);
  });
});

describe('Test 9: a stored key is only honoured if it can be sorted by', () => {
  it('a key this build knows is kept', () => {
    assert.equal(sort.resolveSortKey('label', sort.availableSorts(library())), 'label');
  });
  it('the default is name', () => {
    assert.equal(sort.resolveSortKey('name', sort.availableSorts(library())), 'name');
  });
  it('an absent or empty stored value falls back to name', () => {
    assert.equal(sort.resolveSortKey('', sort.availableSorts(library())), 'name');
  });
  it('an unknown stored value falls back to name', () => {
    assert.equal(sort.resolveSortKey('by-vibes', sort.availableSorts(library())), 'name');
  });
  it('a key the server cannot support falls back to name rather than sorting everything to last', () => {
    assert.equal(sort.resolveSortKey('changed', sort.availableSorts([{ name: 'A' }])), 'name');
  });
  it('with no availability list at all, every key resolves', () => {
    assert.ok(sort.SORTS.every((s) => sort.resolveSortKey(s.key) === s.key));
  });
  it('the availability list is the same shape the resolve call takes', () => {
    const withDates = sort.availableSorts(library());
    assert.ok(sort.SORTS.every((s, i) => withDates[i].key === sort.resolveSortKey(s.key, withDates)));
  });
});

describe('Test 10: wiring from the control to the list', () => {
  const page = readPage('mods.js');
  const html = readPage('index.html');
  const atRe = (re) => { const m = re.exec(html); return m ? m.index : -1; };
  it('modsort.js is loaded before mods.js, which reads it at load time', () => {
    assert.ok(atRe(/modsort\.js/) > -1 && atRe(/modsort\.js/) < atRe(/mods\.js/));
  });
  it('the page reaches the orderings through the global the file publishes', () => {
    assert.ok(/modsort\.(sortMods|availableSorts|resolveSortKey|labelKey)/.test(page));
  });
  it('sorting happens in exactly one place - the end of visibleMods()', () => {
    assert.ok(/return modsort\.sortMods\(shown, modsPage\.sort, sortContext\(\)\)/.test(page)
      && (page.match(/modsort\.sortMods\(/g) || []).length === 1);
  });
  it('the label and source filters are applied before the sort', () => {
    const visible = /function visibleMods\(\)[\s\S]*?\n\}/.exec(page);
    assert.ok(!!visible && visible[0].indexOf('matchesLabels(m)') < visible[0].indexOf('modsort.sortMods(')
      && visible[0].indexOf('SRC_MATCH[modsPage.src](m)') < visible[0].indexOf('modsort.sortMods('));
  });
  it('the state ordering is given isOn, so a pending change counts as current', () => {
    assert.ok(/return \{ isOn, problemCount:/.test(page));
  });
  it('  and problemCount is problemsOf, the same function the warning bar uses', () => {
    assert.ok(/problemCount: \(m\) => problemsOf\(m, all\)\.length/.test(page));
  });
  it('the stored key is read at load, inside a try, defaulting to name', () => {
    assert.ok(/modsPage\.sort = localStorage\.getItem\(SORT_KEY\) \|\| 'name'/.test(page));
  });
  it('  and the change handler stores it back and re-renders', () => {
    assert.ok(/localStorage\.setItem\(SORT_KEY, modsPage\.sort\)/.test(page)
      && /addEventListener\('change'[\s\S]{0,400}renderMods\(\)/.test(page));
  });
  it('  and a failed write does not stop the sort - the view preference does the same', () => {
    assert.ok(/localStorage\.setItem\(SORT_KEY, modsPage\.sort\); \} catch \(_\)/.test(page));
  });
  it('the select is built from the keys that can be sorted by, and the stored one validated', () => {
    assert.ok(/availableSorts\([\s\S]{0,160}resolveSortKey\(/.test(page));
  });
  it('the sort control is in the left half of the filter row', () => {
    assert.ok(/id="sortSelect"/.test(html)
      && atRe(/id="sortSelect"/) > atRe(/class="filter-half"/)
      && atRe(/id="sortSelect"/) < html.indexOf('class="filter-half"', atRe(/class="filter-half"/) + 1));
  });
  it('  and the placeholder it replaced is gone, not left as dead markup', () => {
    assert.ok(!/id="sortSlot"/.test(html) && !/SPEC-mod-sorting\.md puts the sort control/.test(html));
  });
});

describe('Test 11: tooltip - every key has something to say about itself', () => {
  it('every key on offer carries a hint', () => {
    const all = sort.availableSorts(library());
    assert.ok(all.every((s) => typeof s.hint === 'string' && s.hint.length > 0));
  });
  it('no hint is a placeholder - each is longer than "TODO"', () => {
    const all = sort.availableSorts(library());
    assert.ok(all.every((s) => s.hint.length > 20));
  });
  it('no hint is just the label again', () => {
    const all = sort.availableSorts(library());
    assert.ok(all.every((s) => s.hint.toLowerCase() !== s.label.toLowerCase()));
  });
  it('with no data at all, the keys still carry hints - a tooltip must not need a page', () => {
    assert.ok(sort.availableSorts([]).every((s) => s.hint && s.hint.length > 0));
  });
  it('every key a stored value can resolve to is one that has a hint', () => {
    const stale = ['', 'by-vibes', 'changed', 'NAME', null, undefined];
    const withDates = sort.availableSorts(library());
    const without = sort.availableSorts([{ name: 'A' }]);
    const bare = [];
    for (const stored of stale) {
      for (const list of [withDates, without]) {
        const key = sort.resolveSortKey(stored, list);
        const entry = list.find((s) => s.key === key);
        if (!entry || !entry.hint) bare.push(`${JSON.stringify(stored)} -> ${key}`);
      }
    }
    assert.deepEqual(bare, []);
  });
  it('a hint is plain text, and the page escapes it like any other', () => {
    assert.ok(/\$\{esc\(s\.label\)\}/.test(readPage('mods.js'))
      && /sel\.title = active \? `\$\{active\.label\}/.test(readPage('mods.js')));
  });
  it('  and a key with no matching entry still leaves a tooltip rather than "undefined"', () => {
    assert.ok(/sel\.title = active \? .* : 'How to order the mod list'/.test(readPage('mods.js')));
  });
});
