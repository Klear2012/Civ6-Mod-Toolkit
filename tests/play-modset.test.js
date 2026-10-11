'use strict';

// Mirror for src/play-modset.js: snapshot the active group's enabled set,
// switch to a save's required set, and put the previous set back after
// quit. Temp sidecar paths and injected state/apply fakes only; the live
// game database is never opened here (the live trial covers the real
// applyChanges path). Unknown or ungrouped ids refuse with names before
// anything is written.
//
// Run with `node --test tests/play-modset.test.js`.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp } = require('./helpers');
const playModset = require('../src/play-modset');

const TMP = makeTmp('civ6-play-modset-');
const DB = path.join(TMP, 'Mods.sqlite');
const sidecar = () => `${DB}.toolkit-modset`;
const cleanSidecar = () => { try { fs.unlinkSync(sidecar()); } catch (_) { /* absent */ } };

function fakeState() {
  return {
    ok: true,
    mods: [
      { modId: 'AA', idNorm: 'aa', name: 'Alpha', disabled: false },
      { modId: 'BB', idNorm: 'bb', name: 'Beta', disabled: true },
      { modId: 'CC', idNorm: 'cc', name: 'Gamma', disabled: null },
    ],
  };
}

const closedGame = () => Promise.resolve({ running: false });
const runningGame = () => Promise.resolve({ running: true });

before(() => {
  fs.mkdirSync(TMP, { recursive: true });
  cleanSidecar();
});

describe('snapshot', () => {
  it('records the enabled flags and leaves a sidecar behind', () => {
    cleanSidecar();
    const r = playModset.snapshotModSet(DB, { readStateFn: () => fakeState() });
    assert.equal(r.dbPath, DB);
    assert.deepEqual(r.previous, [
      { modId: 'AA', enabled: true },
      { modId: 'BB', enabled: false },
    ]);
    assert.ok(fs.statSync(sidecar()).isFile());
    assert.equal(playModset.modsSnapshotPending(DB), true);
    cleanSidecar();
  });
  it('a database that would not read throws instead of snapshotting air', () => {
    cleanSidecar();
    assert.throws(
      () => playModset.snapshotModSet(DB, { readStateFn: () => ({ ok: false, error: 'gone' }) }),
      /gone/);
    assert.equal(playModset.modsSnapshotPending(DB), false);
  });
});

describe('switch', () => {
  it('enables exactly the required set and reports the flip count', () => {
    cleanSidecar();
    const applied = [];
    const r = playModset.switchToSaveMods(DB, ['bb'], {
      saveMods: [{ id: 'bb', title: 'Beta' }],
      readStateFn: () => fakeState(),
      applyChangesFn: (db, changes) => { applied.push(...changes); return { changed: changes.length }; },
    });
    assert.equal(r.switched, true);
    assert.equal(r.changed, 2);
    assert.deepEqual(applied, [
      { modId: 'AA', enabled: false },
      { modId: 'BB', enabled: true },
    ]);
    assert.equal(playModset.modsSnapshotPending(DB), true);
    cleanSidecar();
  });
  it('an already-matching set switches nothing and leaves no sidecar', () => {
    cleanSidecar();
    let calls = 0;
    const r = playModset.switchToSaveMods(DB, ['AA'], {
      readStateFn: () => fakeState(),
      applyChangesFn: () => { calls += 1; return {}; },
    });
    assert.equal(r.switched, false);
    assert.equal(calls, 0);
    assert.equal(playModset.modsSnapshotPending(DB), false);
  });
  it('an unknown id refuses with names, writing nothing', () => {
    cleanSidecar();
    let calls = 0;
    const err = awaitThrows(() => playModset.switchToSaveMods(DB, ['AA', 'ZZ'], {
      saveMods: [{ id: 'ZZ', title: 'Zeta Mod' }],
      readStateFn: () => fakeState(),
      applyChangesFn: () => { calls += 1; return {}; },
    }));
    assert.equal(err.message, 'unswitchable');
    assert.deepEqual(err.unknown, [{ id: 'ZZ', title: 'Zeta Mod' }]);
    assert.equal(calls, 0);
    assert.equal(playModset.modsSnapshotPending(DB), false);
  });
  it('a mod with no row in the active group refuses the same way', () => {
    cleanSidecar();
    let calls = 0;
    const err = awaitThrows(() => playModset.switchToSaveMods(DB, ['CC'], {
      saveMods: [{ id: 'CC', title: 'Gamma' }],
      readStateFn: () => fakeState(),
      applyChangesFn: () => { calls += 1; return {}; },
    }));
    assert.equal(err.message, 'unswitchable');
    assert.equal(err.unknown[0].id, 'CC');
    assert.equal(calls, 0);
    assert.equal(playModset.modsSnapshotPending(DB), false);
  });
  it('the warning names the save and every unreachable mod', () => {
    const w = playModset.unswitchableWarning(
      [{ id: 'ZZ', title: 'Zeta Mod' }], 'Old.Civ6Save');
    assert.ok(w.includes('Old.Civ6Save'), w);
    assert.ok(w.includes('Zeta Mod') && w.includes('ZZ'), w);
    assert.ok(/nothing was changed/i.test(w), w);
  });
});

// The switch throws synchronously, so a tiny helper reads cleaner than
// assert.throws when the error object itself is asserted.
function awaitThrows(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the switch to refuse');
}

describe('restore', () => {
  it('puts the previous set back and clears the sidecar', async () => {
    cleanSidecar();
    playModset.snapshotModSet(DB, { readStateFn: () => fakeState() });
    const applied = [];
    const live = () => ({
      ok: true,
      mods: [
        { modId: 'AA', idNorm: 'aa', name: 'Alpha', disabled: true },
        { modId: 'BB', idNorm: 'bb', name: 'Beta', disabled: false },
        { modId: 'CC', idNorm: 'cc', name: 'Gamma', disabled: null },
      ],
    });
    const r = await playModset.restoreModSet(DB, {
      gameStatusFn: closedGame,
      readStateFn: live,
      applyChangesFn: (db, changes) => { applied.push(...changes); return { changed: changes.length }; },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(applied, [
      { modId: 'AA', enabled: true },
      { modId: 'BB', enabled: false },
    ]);
    assert.equal(playModset.modsSnapshotPending(DB), false);
  });
  it('ids that vanished since are skipped, never deleted', async () => {
    cleanSidecar();
    playModset.snapshotModSet(DB, { readStateFn: () => fakeState() });
    const applied = [];
    const r = await playModset.restoreModSet(DB, {
      gameStatusFn: closedGame,
      readStateFn: () => ({ ok: true, mods: [] }),
      applyChangesFn: (db, changes) => { applied.push(...changes); return {}; },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(applied, []);
    assert.deepEqual(r.skipped, ['AA', 'BB']);
    assert.equal(playModset.modsSnapshotPending(DB), false);
  });
  it('refuses while the game runs and keeps the sidecar', async () => {
    cleanSidecar();
    playModset.snapshotModSet(DB, { readStateFn: () => fakeState() });
    let calls = 0;
    const r = await playModset.restoreModSet(DB, {
      gameStatusFn: runningGame,
      readStateFn: () => fakeState(),
      applyChangesFn: () => { calls += 1; return {}; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'civ6-running');
    assert.equal(calls, 0);
    assert.equal(playModset.modsSnapshotPending(DB), true);
    cleanSidecar();
  });
  it('with no sidecar there is nothing to put back', async () => {
    cleanSidecar();
    const r = await playModset.restoreModSet(DB, { gameStatusFn: closedGame });
    assert.equal(r.ok, false);
  });
});
