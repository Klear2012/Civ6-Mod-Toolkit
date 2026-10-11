'use strict';

// Mirror for play-from-save: the newest-autosave pick, the picker list, the
// required-mod preflight, the AppOptions backup/restore roundtrip (including
// a simulated crash reconciled at startup), and the refuse-while-running
// branch. Synthetic Temp saves and a Temp AppOptions only; the live game,
// the real AppOptions and the real saves folder are never touched, and the
// game exe is never launched (stub launchers observe the PlayNowSave value
// instead). Live boot into the right save needs a real machine (see the
// live-boot note at the bottom of the report, not this file).
//
// Run with `node --test tests/play-save.test.js`.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp } = require('./helpers');
const playSave = require('../src/play-save');

const TMP = makeTmp('civ6-play-save-');
const APP = path.join(TMP, 'AppOptions.txt');
const APP_ORIGINAL = [
  ';Enable assertions.',
  'EnableAsserts 1',
  '',
  ';Forces the game to load only that save file.',
  'PlayNowSave ',
  '',
  ';Log all game core events.',
  'EnableGameCoreEventLog 0',
  '',
].join('\n');

function putSave(p, mtimeSec) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `save-bytes-${path.basename(p)}`);
  const t = new Date(mtimeSec * 1000);
  fs.utimesSync(p, t, t);
}

// A stub parser shaped like the real one's simple output.
function stubParseTurnDispenser() {
  return () => ({
    GAME_TURN: 203,
    MOD_BLOCK_1: [
      { MOD_ID: '02a8bdde-67ea-4d38-9540-26e685e3156e', MOD_TITLE: '{"LOC_AZTEC_MONTEZUMA_MOD_TITLE":[]}' },
      { MOD_ID: '11111111-1111-1111-1111-111111111111', MOD_TITLE: 'Terra Mirabilis' },
    ],
  });
}

const INSTALLED_ALL = [
  { id: '02a8bdde-67ea-4d38-9540-26e685e3156e', name: 'Aztec' },
  { id: '11111111-1111-1111-1111-111111111111', name: 'Terra Mirabilis' },
];
const INSTALLED_ONE_MISSING = [{ id: '11111111-1111-1111-1111-111111111111', name: 'Terra Mirabilis' }];

const closedGame = () => Promise.resolve({ running: false, known: true, processes: [] });
const runningGame = () => Promise.resolve({ running: true, known: true, processes: ['CivilizationVI.exe'] });

// Env this suite borrows, restored afterwards so no other mirror sees it.
const savedEnv = {};
for (const k of ['CIV6_SAVES', 'CIV6_APPOPTIONS', 'CIV6_EXE', 'CIV6_NO_BOOT']) savedEnv[k] = process.env[k];
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

before(() => {
  fs.writeFileSync(APP, APP_ORIGINAL);
});

describe('latest autosave pick', () => {
  const root = path.join(TMP, 'saves-pick', 'Single');
  before(() => {
    putSave(path.join(root, 'auto', 'AutoSave_0001.Civ6Save'), 1000);
    putSave(path.join(root, 'auto', 'AutoSave_0002.Civ6Save'), 2000);
    putSave(path.join(root, 'GORGO 225 2024 AD.Civ6Save'), 3000);
  });
  it('picks the newest file with auto in the name, not the newest file', () => {
    const latest = playSave.findLatestAutosave(root);
    assert.equal(latest.name, 'AutoSave_0002.Civ6Save');
  });
  it('reports no autosave when only manual saves exist', () => {
    const manual = path.join(TMP, 'saves-manual');
    putSave(path.join(manual, 'Manual.Civ6Save'), 5000);
    assert.equal(playSave.findLatestAutosave(manual), null);
  });
  it('a missing folder picks nothing, never throws', () => {
    assert.equal(playSave.findLatestAutosave(path.join(TMP, 'no-such-dir')), null);
  });
});

describe('picker list', () => {
  const root = path.join(TMP, 'saves-list');
  before(() => {
    putSave(path.join(root, 'Older.Civ6Save'), 1000);
    putSave(path.join(root, 'Newer.Civ6Save'), 2000);
    putSave(path.join(root, 'notes.txt'), 3000);
  });
  it('lists saves newest-first with turn and required mods from parsing', () => {
    const rows = playSave.listSaves(root, { parseFn: stubParseTurnDispenser() });
    assert.equal(rows.map((r) => r.name).join(','), 'Newer.Civ6Save,Older.Civ6Save');
    assert.equal(rows[0].turn, 203);
    assert.equal(rows[0].mods.length, 2);
    assert.ok(rows[0].mods.some((m) => m.id === '02a8bdde-67ea-4d38-9540-26e685e3156e'));
  });
  it('an unparseable save still lists, carrying its parse error', () => {
    const rows = playSave.listSaves(root);
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('Older.Civ6Save'));
    const older = rows.find((r) => r.name === 'Older.Civ6Save');
    assert.ok(older.parseError, 'expected a parse error on garbage bytes');
    assert.equal(older.turn, null);
    assert.deepEqual(older.mods, []);
  });
});

describe('save info shapes', () => {
  it('reads the raw (non-simple) parser shape too', () => {
    const info = playSave.saveInfoOf({
      GAME_TURN: { marker: {}, type: 2, data: 47 },
      MOD_BLOCK_1: { data: [{ MOD_ID: { data: 'AA' }, MOD_TITLE: { data: 'Plain Name' } }] },
    });
    assert.equal(info.turn, 47);
    assert.deepEqual(info.mods, [{ id: 'AA', title: 'Plain Name' }]);
  });
  it('dedupes a mod repeated across MOD_BLOCK keys', () => {
    const info = playSave.saveInfoOf({
      MOD_BLOCK_1: [{ MOD_ID: 'AA', MOD_TITLE: 'Plain Name' }],
      MOD_BLOCK_2_2: [{ MOD_ID: 'aa', MOD_TITLE: 'Plain Name' }],
    });
    assert.equal(info.mods.length, 1);
  });
  it('prefers the en_US title inside localization blobs', () => {
    const blob = '{"LOC_PACK":[]}';
    assert.equal(playSave.modDisplayTitle('Terra Mirabilis'), 'Terra Mirabilis');
    assert.equal(playSave.modDisplayTitle(blob), null);
    const localized = '{"LOC_TEDDY":[{"locale":"de_DE","text":"DE"},{"locale":"en_US","text":"Teddy Pack"}]}';
    assert.equal(playSave.modDisplayTitle(localized), 'Teddy Pack');
  });
});

describe('required-mod preflight', () => {
  const save = path.join(TMP, 'saves-list', 'Newer.Civ6Save');
  it('is silent when every required mod is installed', () => {
    const pre = playSave.preflight(save, INSTALLED_ALL, { parseFn: stubParseTurnDispenser() });
    assert.deepEqual(pre.missing, []);
    assert.equal(pre.warning, null);
  });
  it('warns before booting, naming the missing mod', () => {
    const pre = playSave.preflight(save, INSTALLED_ONE_MISSING, { parseFn: stubParseTurnDispenser() });
    assert.equal(pre.missing.length, 1);
    assert.equal(pre.missing[0].id, '02a8bdde-67ea-4d38-9540-26e685e3156e');
    assert.ok(pre.warning.includes('Newer.Civ6Save'), pre.warning);
    assert.ok(pre.warning.includes('02a8bdde-67ea-4d38-9540-26e685e3156e'), pre.warning);
    assert.ok(/install/i.test(pre.warning), pre.warning);
  });
});

describe('AppOptions backup and restore', () => {
  it('roundtrips byte-identical with flag and backup cleared', () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    playSave.backupAppOptions(APP);
    playSave.writePlayNowSave(APP, 'C:\\saves\\Newer.Civ6Save');
    assert.equal(playSave.readPlayNowSave(APP), 'C:\\saves\\Newer.Civ6Save');
    const r = playSave.restoreAppOptions(APP);
    assert.equal(r.restored, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    assert.ok(!fs.existsSync(`${APP}.toolkit-boot`));
    assert.ok(!fs.existsSync(`${APP}.toolkit-backup`));
  });
  it('a simulated crash reconciles at startup with a log line', () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    playSave.backupAppOptions(APP);
    playSave.writePlayNowSave(APP, 'C:\\saves\\Newer.Civ6Save');
    // Crash here: no restore call. The next start must put it back.
    const lines = [];
    const log = console.log;
    console.log = (m) => lines.push(String(m));
    let rec;
    try {
      rec = playSave.reconcileUnrestoredBoot(APP);
    } finally {
      console.log = log;
    }
    assert.equal(rec.reconciled, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    assert.ok(!fs.existsSync(`${APP}.toolkit-boot`));
    assert.ok(lines.some((l) => /restored AppOptions/i.test(l)), lines.join('\n'));
  });
  it('reconcile is a no-op without a leftover flag', () => {
    assert.deepEqual(playSave.reconcileUnrestoredBoot(APP), { reconciled: false });
  });
  it('only the PlayNowSave line changes, the rest of the file is untouched', () => {
    const before = APP_ORIGINAL.split('\n').filter((l) => !/^PlayNowSave/.test(l));
    const after = playSave.setPlayNowSave(APP_ORIGINAL, 'X').split('\n').filter((l) => !/^PlayNowSave/.test(l));
    assert.deepEqual(after, before);
    assert.ok(/^PlayNowSave X$/m.test(playSave.setPlayNowSave(APP_ORIGINAL, 'X')));
    assert.ok(/^PlayNowSave$/m.test(playSave.setPlayNowSave(APP_ORIGINAL, '')));
    assert.ok(/PlayNowSave X/.test(playSave.setPlayNowSave('EnableAsserts 1\n', 'X')));
  });
});

describe('refuse while the game runs', () => {
  it('refuses in plain words, launches nothing, writes nothing', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    let launched = 0;
    const r = await playSave.bootSave(path.join(TMP, 'saves-list', 'Newer.Civ6Save'), {
      appOptions: APP,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      gameStatusFn: runningGame,
      launcherFn: () => { launched += 1; return Promise.resolve(); },
      exePath: path.join(TMP, 'fake.exe'),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'civ6-running');
    assert.ok(/quit the game first/i.test(r.error), r.error);
    assert.equal(launched, 0);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    assert.ok(!fs.existsSync(`${APP}.toolkit-boot`));
  });
});

describe('missing mods gate the boot', () => {
  const save = path.join(TMP, 'saves-list', 'Newer.Civ6Save');
  it('warns without writing anything until the user plays anyway', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    let launched = 0;
    const r = await playSave.bootSave(save, {
      appOptions: APP,
      installed: INSTALLED_ONE_MISSING,
      parseFn: stubParseTurnDispenser(),
      gameStatusFn: closedGame,
      launcherFn: () => { launched += 1; return Promise.resolve(); },
      exePath: path.join(TMP, 'fake.exe'),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing-mods');
    assert.ok(r.warning.includes('02a8bdde-67ea-4d38-9540-26e685e3156e'), r.warning);
    assert.equal(launched, 0);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
  it('boots into the right save once the user plays anyway', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const fakeExe = path.join(TMP, 'fake-game.exe');
    fs.writeFileSync(fakeExe, 'exe');
    const seen = {};
    let calls = 0;
    const r = await playSave.bootSave(save, {
      appOptions: APP,
      installed: INSTALLED_ONE_MISSING,
      parseFn: stubParseTurnDispenser(),
      proceedWithoutMods: true,
      exePath: fakeExe,
      gameStatusFn: () => Promise.resolve({ running: ++calls > 1, known: true, processes: [] }),
      launcherFn: (exe) => {
        seen.exe = exe;
        seen.playNow = playSave.readPlayNowSave(APP);
        return Promise.resolve();
      },
      pollIntervalMs: 5,
      loadConfirmedFn: () => Promise.resolve(true),
      loadTimeoutMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(seen.exe, fakeExe);
    assert.equal(seen.playNow, 'Newer.Civ6Save');
    assert.equal(r.planted, 'Newer.Civ6Save');
    assert.equal(r.restored, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
});

describe('planted PlayNowSave shape', () => {
  const savesRoot = path.join(TMP, 'plant', 'Saves');
  const autoSave = path.join(savesRoot, 'Single', 'auto', 'AutoSave_0001.Civ6Save');
  const rootSave = path.join(savesRoot, 'Single', 'Root.Civ6Save');
  const multiSave = path.join(savesRoot, 'Multi', 'MultiSave.Civ6Save');
  before(() => {
    putSave(autoSave, 1000);
    putSave(rootSave, 2000);
    putSave(multiSave, 3000);
  });
  it('plants an auto-nested save as Single/auto/... with no ./ prefix', () => {
    assert.equal(playSave.toPlayNowSaveValue(autoSave), 'Single/auto/AutoSave_0001.Civ6Save');
  });
  it('plants a Single-root save as Single/...', () => {
    assert.equal(playSave.toPlayNowSaveValue(rootSave), 'Single/Root.Civ6Save');
  });
  it('plants a Multi save as Multi/...', () => {
    assert.equal(playSave.toPlayNowSaveValue(multiSave), 'Multi/MultiSave.Civ6Save');
  });
  it('boots stage a deep save as a copy and plant the copy the menu reads', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const fakeExe = path.join(TMP, 'fake-game.exe');
    fs.writeFileSync(fakeExe, 'exe');
    const seen = {};
    let calls = 0;
    const r = await playSave.bootSave(autoSave, {
      appOptions: APP,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      exePath: fakeExe,
      gameStatusFn: () => Promise.resolve({ running: ++calls > 1, known: true, processes: [] }),
      launcherFn: () => {
        seen.playNow = playSave.readPlayNowSave(APP);
        return Promise.resolve();
      },
      pollIntervalMs: 5,
      loadConfirmedFn: () => Promise.resolve(true),
      loadTimeoutMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(seen.playNow, 'Single/ToolkitBoot_AutoSave_0001.Civ6Save');
    assert.equal(r.planted, 'Single/ToolkitBoot_AutoSave_0001.Civ6Save');
    assert.equal(r.restored, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    assert.ok(!fs.existsSync(path.join(savesRoot, 'Single', 'ToolkitBoot_AutoSave_0001.Civ6Save')));
  });
});

describe('no early restore', () => {
  it('leaves the plant for reconcile when the load is not yet confirmed', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const fakeExe = path.join(TMP, 'fake-game.exe');
    fs.writeFileSync(fakeExe, 'exe');
    const save = path.join(TMP, 'plant', 'Saves', 'Single', 'auto', 'AutoSave_0001.Civ6Save');
    putSave(save, 1000);
    let calls = 0;
    const r = await playSave.bootSave(save, {
      appOptions: APP,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      exePath: fakeExe,
      gameStatusFn: () => Promise.resolve({ running: ++calls > 1, known: true, processes: [] }),
      launcherFn: () => Promise.resolve(),
      pollIntervalMs: 5,
      pollTimeoutMs: 100,
      loadConfirmedFn: () => Promise.resolve(false),
      loadTimeoutMs: 30,
    });
    assert.equal(r.ok, true);
    assert.equal(r.restored, false);
    assert.equal(r.deferred, true);
    assert.equal(playSave.readPlayNowSave(APP), 'Single/ToolkitBoot_AutoSave_0001.Civ6Save');
    assert.ok(fs.existsSync(`${APP}.toolkit-boot`));
    const rec = playSave.reconcileUnrestoredBoot(APP);
    assert.equal(rec.reconciled, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    assert.ok(!fs.existsSync(path.join(TMP, 'plant', 'Saves', 'Single', 'ToolkitBoot_AutoSave_0001.Civ6Save')));
  });
});

describe('staging-copy boot', () => {
  // A save nested deeper than one level boots through a byte copy staged
  // beside it. No live boot is needed here: the launch, the log markers and
  // the single-level load are proven live separately, and these mirrors
  // cover only the staging mechanism (plan, copy bytes, plant shape,
  // deletion, refusal, sweep).
  const savesRoot = path.join(TMP, 'stage', 'Saves');
  const deepSave = path.join(savesRoot, 'Single', 'auto', 'AutoSave_0002.Civ6Save');
  const rootSave = path.join(savesRoot, 'Single', 'RootStage.Civ6Save');
  const stagedDest = (name) => path.join(savesRoot, 'Single', `${playSave.STAGING_PREFIX}${name}`);
  before(() => {
    putSave(deepSave, 1000);
    putSave(rootSave, 2000);
  });
  it('plans staging only for saves deeper than one level', () => {
    const deep = playSave.stagingPlanFor(deepSave, { savesRoot });
    assert.equal(deep.needsStaging, true);
    assert.equal(deep.plantedCopy, 'Single/ToolkitBoot_AutoSave_0002.Civ6Save');
    assert.equal(deep.dest, stagedDest('AutoSave_0002.Civ6Save'));
    assert.equal(playSave.stagingPlanFor(rootSave, { savesRoot }).needsStaging, false);
    assert.equal(playSave.stagingPlanFor(path.join(TMP, 'elsewhere.Civ6Save'), { savesRoot }).needsStaging, false);
  });
  it('stages the exact bytes, plants the copy, then deletes it with the restore', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const fakeExe = path.join(TMP, 'fake-game.exe');
    fs.writeFileSync(fakeExe, 'exe');
    const beforeBytes = fs.readFileSync(deepSave);
    const seen = {};
    let calls = 0;
    const r = await playSave.bootSave(deepSave, {
      appOptions: APP,
      savesRoot,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      exePath: fakeExe,
      gameStatusFn: () => Promise.resolve({ running: ++calls > 1, known: true, processes: [] }),
      launcherFn: () => {
        seen.playNow = playSave.readPlayNowSave(APP);
        seen.stagedBytes = fs.readFileSync(stagedDest('AutoSave_0002.Civ6Save'));
        return Promise.resolve();
      },
      pollIntervalMs: 5,
      loadConfirmedFn: () => Promise.resolve(true),
      loadTimeoutMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(seen.playNow, 'Single/ToolkitBoot_AutoSave_0002.Civ6Save');
    assert.equal(r.planted, 'Single/ToolkitBoot_AutoSave_0002.Civ6Save');
    assert.ok(seen.stagedBytes.equals(beforeBytes), 'staged copy must carry the exact save bytes');
    assert.ok(!fs.existsSync(stagedDest('AutoSave_0002.Civ6Save')), 'staged copy deleted after the confirmed load');
    assert.equal(r.restored, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    assert.ok(fs.readFileSync(deepSave).equals(beforeBytes), 'original save never modified');
  });
  it('refuses in plain words when the staged name is taken, changing nothing', async () => {
    // No savesRoot here on purpose: with it the startup sweep would heal the
    // leftover first, and this mirror covers the refusal branch instead.
    fs.writeFileSync(APP, APP_ORIGINAL);
    const dest = stagedDest('AutoSave_0002.Civ6Save');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'someone-elses-file');
    const beforeBytes = fs.readFileSync(deepSave);
    try {
      const fakeExe = path.join(TMP, 'fake-game.exe');
      fs.writeFileSync(fakeExe, 'exe');
      let launched = 0;
      const r = await playSave.bootSave(deepSave, {
        appOptions: APP,
        installed: INSTALLED_ALL,
        parseFn: stubParseTurnDispenser(),
        exePath: fakeExe,
        gameStatusFn: closedGame,
        launcherFn: () => { launched += 1; return Promise.resolve(); },
      });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'staging-collision');
      assert.ok(/try again/i.test(r.error), r.error);
      assert.ok(/nothing was changed/i.test(r.error), r.error);
      assert.equal(launched, 0);
      assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
      assert.ok(!fs.existsSync(`${APP}.toolkit-boot`));
      assert.equal(fs.readFileSync(dest, 'utf8'), 'someone-elses-file');
      assert.ok(fs.readFileSync(deepSave).equals(beforeBytes), 'original save never modified');
    } finally {
      fs.unlinkSync(dest);
    }
  });
  it('a crashed staged boot reconciles the plant and the leftover copy', () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const dest = stagedDest('AutoSave_0002.Civ6Save');
    playSave.backupAppOptions(APP, { savesRoot });
    fs.copyFileSync(deepSave, dest);
    playSave.noteStagedCopy(APP, dest);
    playSave.writePlayNowSave(APP, 'Single/ToolkitBoot_AutoSave_0002.Civ6Save');
    // Crash here: no restore call. The next start must put it back.
    const rec = playSave.reconcileUnrestoredBoot(APP, { savesRoot });
    assert.equal(rec.reconciled, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    assert.ok(!fs.existsSync(dest), 'leftover staged copy deleted');
    assert.ok(!fs.existsSync(`${APP}.toolkit-boot`));
  });
  it('sweeps a stale staged copy even with no boot flag', () => {
    const dest = stagedDest('Orphan.Civ6Save');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'orphan-bytes');
    const before = fs.readdirSync(path.join(savesRoot, 'Single'));
    const rec = playSave.reconcileUnrestoredBoot(APP, { savesRoot });
    assert.ok(!fs.existsSync(dest), 'stale staged copy swept');
    assert.ok((rec.stagedRemoved || []).includes(dest));
    assert.ok(before.includes('RootStage.Civ6Save'), 'real saves are never swept');
    assert.ok(fs.existsSync(rootSave));
  });
  it('a root-level save plants directly with zero staging', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const fakeExe = path.join(TMP, 'fake-game.exe');
    fs.writeFileSync(fakeExe, 'exe');
    const seen = {};
    let calls = 0;
    const r = await playSave.bootSave(rootSave, {
      appOptions: APP,
      savesRoot,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      exePath: fakeExe,
      gameStatusFn: () => Promise.resolve({ running: ++calls > 1, known: true, processes: [] }),
      launcherFn: () => {
        seen.playNow = playSave.readPlayNowSave(APP);
        seen.staged = fs.readdirSync(path.join(savesRoot, 'Single')).filter((n) => n.startsWith(playSave.STAGING_PREFIX));
        return Promise.resolve();
      },
      pollIntervalMs: 5,
      loadConfirmedFn: () => Promise.resolve(true),
      loadTimeoutMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(seen.playNow, 'Single/RootStage.Civ6Save');
    assert.equal(r.planted, 'Single/RootStage.Civ6Save');
    assert.deepEqual(seen.staged, [], 'no staging copy for a root-level save');
    assert.equal(r.restored, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
});

describe('boot failures', () => {
  it('an unknown save path fails without touching AppOptions', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const r = await playSave.bootSave(path.join(TMP, 'missing.Civ6Save'), {
      appOptions: APP, gameStatusFn: closedGame, installed: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-save');
    assert.ok(!fs.existsSync(`${APP}.toolkit-boot`));
  });
  it('a failed launch restores AppOptions in its finally', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const fakeExe = path.join(TMP, 'fake-game.exe');
    fs.writeFileSync(fakeExe, 'exe');
    const r = await playSave.bootSave(path.join(TMP, 'saves-list', 'Newer.Civ6Save'), {
      appOptions: APP,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      gameStatusFn: closedGame,
      exePath: fakeExe,
      launcherFn: () => Promise.reject(new Error('spawn failed')),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'launch-failed');
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    assert.ok(!fs.existsSync(`${APP}.toolkit-boot`));
  });
  it('a missing exe fails before anything is written', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const r = await playSave.bootSave(path.join(TMP, 'saves-list', 'Newer.Civ6Save'), {
      appOptions: APP,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      gameStatusFn: closedGame,
      exePath: path.join(TMP, 'no-such-exe.exe'),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-exe');
    assert.ok(!fs.existsSync(`${APP}.toolkit-boot`));
  });
});

describe('play-latest entry point', () => {
  it('boots the newest autosave with no picker (dry run)', async () => {
    const single = path.join(TMP, 'latest', 'Saves', 'Single');
    putSave(path.join(single, 'auto', 'AutoSave_0001.Civ6Save'), 1000);
    putSave(path.join(single, 'auto', 'AutoSave_0009.Civ6Save'), 9000);
    process.env.CIV6_SAVES = path.join(TMP, 'latest', 'Saves');
    fs.writeFileSync(APP, APP_ORIGINAL);
    try {
      const r = await playSave.playLatest({
        mode: 'single',
        dryRun: true,
        appOptions: APP,
        installed: [],
        gameStatusFn: closedGame,
        parseFn: () => ({ GAME_TURN: 9, MOD_BLOCK_1: [] }),
      });
      assert.equal(r.ok, true);
      assert.equal(r.dryRun, true);
      assert.ok(r.save.endsWith('AutoSave_0009.Civ6Save'), r.save);
      assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
    } finally {
      delete process.env.CIV6_SAVES;
    }
  });
  it('says plainly when there is no autosave to play', async () => {
    process.env.CIV6_SAVES = path.join(TMP, 'saves-manual');
    try {
      const r = await playSave.playLatest({ mode: 'custom' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'no-saves');
    } finally {
      delete process.env.CIV6_SAVES;
    }
  });
});

describe('database-known content is not missing', () => {
  const { DatabaseSync } = require('node:sqlite');
  const save = path.join(TMP, 'saves-list', 'Newer.Civ6Save');
  it('reads mod ids from a database with only a Mods table', () => {
    const dbPath = path.join(TMP, 'mini-Mods.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('CREATE TABLE Mods (ModId TEXT)').run();
      db.prepare("INSERT INTO Mods (ModId) VALUES ('02a8bdde-67ea-4d38-9540-26e685e3156e')").run();
    } finally {
      db.close();
    }
    assert.deepEqual(playSave.dbModIds(dbPath), ['02a8bdde-67ea-4d38-9540-26e685e3156e']);
    assert.deepEqual(playSave.dbModIds(path.join(TMP, 'no-such-db.sqlite')), []);
  });
  it('a save needing only database-known content preflights silent', () => {
    const pre = playSave.preflight(save, INSTALLED_ONE_MISSING, {
      parseFn: stubParseTurnDispenser(),
      knownIds: ['02a8bdde-67ea-4d38-9540-26e685e3156e'],
    });
    assert.deepEqual(pre.missing, []);
    assert.equal(pre.warning, null);
  });
});

describe('exe lookup and hard rules', () => {
  it('a pinned exe resolves when present, misses when absent', () => {
    const fakeExe = path.join(TMP, 'fake-game.exe');
    fs.writeFileSync(fakeExe, 'exe');
    assert.equal(playSave.findGameExe('dx12', { exePath: fakeExe }), fakeExe);
    assert.equal(playSave.findGameExe('dx12', { exePath: path.join(TMP, 'gone.exe') }), null);
  });
  it('the unpinned lookup answers with the dx12 exe or nothing, never throws', () => {
    const found = playSave.findGameExe('dx12');
    assert.ok(found === null || found.endsWith('CivilizationVI_DX12.exe'), String(found));
    assert.ok(playSave.findGameExe('bogus') === null || playSave.findGameExe('bogus').endsWith('.exe'));
  });
  it('the boot pipeline never kills a process', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'play-save.js'), 'utf8');
    assert.ok(!/taskkill/i.test(src), 'taskkill has no place in the boot pipeline');
    assert.ok(!/\.kill\s*\(/.test(src), 'process killing has no place in the boot pipeline');
    assert.ok(/finally/.test(src), 'restore must sit in a finally');
    assert.ok(/reconcileUnrestoredBoot/.test(src), 'startup reconcile must be wired');
  });
  it('the server reconciles an interrupted boot at startup', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(/reconcileUnrestoredBoot\(\)/.test(src));
    assert.ok(/\/api\/play-save\/saves/.test(src));
    assert.ok(/\/api\/play-save\/latest/.test(src));
    assert.ok(/\/api\/play-save\/boot/.test(src));
    assert.ok(/\/api\/play-save\/restore-mods/.test(src));
  });
});

describe('skip-intro opt-in', () => {
  const INTRO_APP = path.join(TMP, 'AppOptions-intro.txt');
  const WITH_KEY = ['EnableAsserts 1', 'PlayIntroVideo 1', ''].join('\n');
  it('sets an existing key to skipped, nothing else moves', () => {
    const after = playSave.setPlayIntroVideo(WITH_KEY, true);
    assert.ok(/^PlayIntroVideo 0$/m.test(after));
    assert.deepEqual(
      after.split('\n').filter((l) => !/^PlayIntroVideo/.test(l)),
      WITH_KEY.split('\n').filter((l) => !/^PlayIntroVideo/.test(l)));
  });
  it('appends the key when absent, and a false never writes', () => {
    const noKey = 'EnableAsserts 1\n';
    assert.ok(/^PlayIntroVideo 0$/m.test(playSave.setPlayIntroVideo(noKey, true)));
    assert.equal(playSave.setPlayIntroVideo(WITH_KEY, false), WITH_KEY);
  });
  it('the probe answers whether this install has the key', () => {
    fs.writeFileSync(INTRO_APP, WITH_KEY);
    assert.equal(playSave.hasPlayIntroVideo(INTRO_APP), true);
    fs.writeFileSync(INTRO_APP, 'EnableAsserts 1\n');
    assert.equal(playSave.hasPlayIntroVideo(INTRO_APP), false);
  });
  it('a ticked boot plants the skip and restores it afterwards', async () => {
    fs.writeFileSync(INTRO_APP, WITH_KEY);
    const fakeExe = path.join(TMP, 'fake-game.exe');
    fs.writeFileSync(fakeExe, 'exe');
    const seen = {};
    let calls = 0;
    const save = path.join(TMP, 'saves-list', 'Newer.Civ6Save');
    const r = await playSave.bootSave(save, {
      appOptions: INTRO_APP,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      skipIntro: true,
      exePath: fakeExe,
      gameStatusFn: () => Promise.resolve({ running: ++calls > 1, known: true, processes: [] }),
      launcherFn: () => {
        seen.intro = fs.readFileSync(INTRO_APP, 'utf8').match(/^PlayIntroVideo.*$/m)[0];
        return Promise.resolve();
      },
      pollIntervalMs: 5,
      loadConfirmedFn: () => Promise.resolve(true),
      loadTimeoutMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(seen.intro, 'PlayIntroVideo 0');
    assert.equal(fs.readFileSync(INTRO_APP, 'utf8'), WITH_KEY);
  });
});

describe('save-mods switch inside the boot', () => {
  const playModset = require('../src/play-modset');
  const SWDB = path.join(TMP, 'switch', 'Mods.sqlite');
  before(() => { fs.mkdirSync(path.dirname(SWDB), { recursive: true }); });
  const swSidecar = () => `${SWDB}.toolkit-modset`;
  const swState = () => ({
    ok: true,
    mods: [
      { modId: '02a8bdde-67ea-4d38-9540-26e685e3156e', idNorm: '02a8bdde-67ea-4d38-9540-26e685e3156e', name: 'Aztec', disabled: true },
      { modId: '11111111-1111-1111-1111-111111111111', idNorm: '11111111-1111-1111-1111-111111111111', name: 'Terra', disabled: true },
    ],
  });
  const bootOpts = (over = {}) => {
    let polls = 0;
    const flip = () => Promise.resolve({ running: ++polls > 1, known: true, processes: [] });
    return {
      appOptions: APP,
      dbPath: SWDB,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      readStateFn: swState,
      applyChangesFn: (db, changes) => { (over.seen || {}).applied = changes; return { changed: changes.length }; },
      gameStatusFn: over.gameStatusFn || flip,
      exePath: path.join(TMP, 'fake-game.exe'),
      launcherFn: () => Promise.resolve(),
      pollIntervalMs: 5,
      loadConfirmedFn: () => Promise.resolve(true),
      loadTimeoutMs: 1000,
      ...over,
    };
  };
  it('switches to the save set and leaves the snapshot for after quit', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    try { fs.unlinkSync(swSidecar()); } catch (_) { /* absent */ }
    const seen = {};
    const r = await playSave.bootSave(path.join(TMP, 'saves-list', 'Newer.Civ6Save'), bootOpts({ seen, syncMods: true }));
    assert.equal(r.ok, true);
    assert.deepEqual(seen.applied, [
      { modId: '02a8bdde-67ea-4d38-9540-26e685e3156e', enabled: true },
      { modId: '11111111-1111-1111-1111-111111111111', enabled: true },
    ]);
    assert.equal(r.modsSwitched.changed, 2);
    assert.equal(playModset.modsSnapshotPending(SWDB), true);
    try { fs.unlinkSync(swSidecar()); } catch (_) { /* absent */ }
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
  it('an unreachable required mod refuses with names, changing nothing', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    try { fs.unlinkSync(swSidecar()); } catch (_) { /* absent */ }
    const seen = {};
    const r = await playSave.bootSave(path.join(TMP, 'saves-list', 'Newer.Civ6Save'), bootOpts({
      seen,
      syncMods: true,
      readStateFn: () => ({ ok: true, mods: [] }),
    }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing-mods');
    assert.ok(r.warning.includes('02a8bdde-67ea-4d38-9540-26e685e3156e'), r.warning);
    assert.equal(seen.applied, undefined);
    assert.equal(playModset.modsSnapshotPending(SWDB), false);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
  it('a failed launch undoes the switch it just made', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    try { fs.unlinkSync(swSidecar()); } catch (_) { /* absent */ }
    const calls = [];
    const flipped = () => ({
      ok: true,
      mods: [
        { modId: '02a8bdde-67ea-4d38-9540-26e685e3156e', idNorm: '02a8bdde-67ea-4d38-9540-26e685e3156e', name: 'Aztec', disabled: false },
        { modId: '11111111-1111-1111-1111-111111111111', idNorm: '11111111-1111-1111-1111-111111111111', name: 'Terra', disabled: false },
      ],
    });
    const r = await playSave.bootSave(path.join(TMP, 'saves-list', 'Newer.Civ6Save'), bootOpts({
      syncMods: true,
      gameStatusFn: closedGame,
      readStateFn: () => (calls.length ? flipped() : swState()),
      applyChangesFn: (db, changes) => { calls.push(changes); return { changed: changes.length }; },
      launcherFn: () => Promise.reject(new Error('spawn failed')),
    }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'launch-failed');
    assert.equal(calls.length, 2);
    assert.equal(playModset.modsSnapshotPending(SWDB), false);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
});

describe('dx variant naming', () => {
  it('the dx11 boot names the dx11 exe when none is found', async () => {
    fs.writeFileSync(APP, APP_ORIGINAL);
    const r = await playSave.bootSave(path.join(TMP, 'saves-list', 'Newer.Civ6Save'), {
      appOptions: APP,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      gameStatusFn: closedGame,
      variant: 'dx11',
      exePath: path.join(TMP, 'no-such-exe.exe'),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-exe');
    assert.ok(r.error.includes('CivilizationVI.exe'), r.error);
    assert.ok(!r.error.includes('DX12'), r.error);
  });
});

describe('load verdict: confirmed, refused, or unknown', () => {
  const LOGS = path.join(TMP, 'logs-verify');
  const SILENT = path.join(TMP, 'logs-silent');
  const REJECT = 'LoadGameViewState leaving the network session due to an early exit of the game state.';
  before(() => {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.mkdirSync(SILENT, { recursive: true });
  });
  function clearLogs() {
    for (const f of fs.readdirSync(LOGS)) fs.unlinkSync(path.join(LOGS, f));
  }
  it('a fresh join marker reads as loaded', () => {
    clearLogs();
    fs.writeFileSync(path.join(LOGS, 'Lua.log'), 'setup\nOnLoadGameViewStateDone\n');
    assert.deepEqual(
      playSave.checkLoadState({ logsDirs: [LOGS], loadSinceMs: Date.now() - 60000 }),
      { state: 'loaded' });
  });
  it('the early-exit line reads as refused with the reason quoted', () => {
    clearLogs();
    fs.writeFileSync(path.join(LOGS, 'net_message_debug.log'), `setup\n${REJECT}\n`);
    const r = playSave.checkLoadState({ logsDirs: [LOGS], loadSinceMs: Date.now() - 60000 });
    assert.equal(r.state, 'failed');
    assert.equal(r.reason, REJECT);
  });
  it('a stale marker from an earlier session reads as unknown', () => {
    clearLogs();
    const fp = path.join(LOGS, 'Lua.log');
    fs.writeFileSync(fp, 'OnLoadGameViewStateDone\n');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(fp, old, old);
    assert.deepEqual(
      playSave.checkLoadState({ logsDirs: [LOGS], loadSinceMs: Date.now() - 60000 }),
      { state: 'unknown' });
  });
  it('silent logs read as unknown', () => {
    assert.deepEqual(
      playSave.checkLoadState({ logsDirs: [SILENT], loadSinceMs: Date.now() - 60000 }),
      { state: 'unknown' });
  });
  it('silent logs time out as unknown through the shared loop', async () => {
    const r = await playSave.waitForGameThenRestore(APP, {
      gameStatusFn: () => Promise.resolve({ running: true, known: true, processes: [] }),
      logsDirs: [SILENT],
      pollIntervalMs: 5,
      loadTimeoutMs: 40,
    });
    assert.equal(r.restored, false);
    assert.equal(r.deferred, true);
    assert.equal(r.loadState, 'unknown');
  });
  it('the early-exit line fails fast through the shared loop, quoting the reason', async () => {
    clearLogs();
    const fp = path.join(LOGS, 'net_message_debug.log');
    fs.writeFileSync(fp, `setup\n${REJECT}\n`);
    // Dated ahead: bootMs is captured when the loop starts, so a fixture
    // written just before must still read as this-boot's, like a live log
    // the game keeps open.
    const ahead = new Date(Date.now() + 60000);
    fs.utimesSync(fp, ahead, ahead);
    const start = Date.now();
    const r = await playSave.waitForGameThenRestore(APP, {
      gameStatusFn: () => Promise.resolve({ running: true, known: true, processes: [] }),
      logsDirs: [LOGS],
      pollIntervalMs: 5,
      loadTimeoutMs: 5000,
    });
    assert.equal(r.loadState, 'failed');
    assert.equal(r.loadReason, REJECT);
    assert.ok(Date.now() - start < 5000, 'a refused load must not wait out the timeout');
  });
});

describe('tuner click in the boot', () => {
  // No live boot is needed here: the plant plus launch plus single menu
  // call loading the save is proven live separately, and these mirrors
  // cover only the toolkit side (one call fired when the menu is ready, a
  // manual fallback with zero calls when it never is, and the refused-load
  // report). The real log path is used throughout (no loadConfirmedFn
  // stub), so the click step runs exactly as in production, with short
  // timeouts instead of the production defaults.
  const save = path.join(TMP, 'saves-list', 'Newer.Civ6Save');
  const fakeExe = path.join(TMP, 'fake-game.exe');
  const SILENT = path.join(TMP, 'logs-silent');
  function flipStatus() {
    let calls = 0;
    return () => Promise.resolve({ running: ++calls > 1, known: true, processes: [] });
  }
  function bootOpts(over = {}) {
    return {
      appOptions: APP,
      installed: INSTALLED_ALL,
      parseFn: stubParseTurnDispenser(),
      exePath: fakeExe,
      gameStatusFn: flipStatus(),
      launcherFn: () => Promise.resolve(),
      closeBridgeFn: () => {},
      logsDirs: [SILENT],
      pollIntervalMs: 5,
      loadTimeoutMs: 60,
      ...over,
    };
  }
  function reset() {
    fs.writeFileSync(APP, APP_ORIGINAL);
    fs.writeFileSync(fakeExe, 'exe');
  }
  it('fires the single menu-transition call when the menu is ready', async () => {
    reset();
    const calls = [];
    const menu = { states: [{ index: 24, name: 'MainMenu' }], gamecoreIndex: null, ingameIndex: null };
    const r = await playSave.bootSave(save, bootOpts({
      openBridgeFn: () => Promise.resolve(menu),
      executeFn: (handle, index, lua) => {
        calls.push([index, lua]);
        return Promise.resolve({ lines: [], sawAck: true, ended: 'ack-quiet' });
      },
    }));
    assert.deepEqual(calls, [[24, 'OnStateTransition("MainMenu")']]);
    assert.equal(r.ok, true);
    assert.equal(r.needsManualClick, undefined);
    assert.equal(r.deferred, true);
    playSave.reconcileUnrestoredBoot(APP);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
  it('menu-never-ready falls back to a manual click, issuing zero calls', async () => {
    reset();
    let executions = 0;
    const r = await playSave.bootSave(save, bootOpts({
      openBridgeFn: () => Promise.reject(new Error('refused')),
      executeFn: () => { executions += 1; return Promise.resolve(); },
      menuPollIntervalMs: 5,
      menuTimeoutMs: 40,
    }));
    assert.equal(executions, 0);
    assert.ok(r.needsManualClick, 'expected a manual-click reason');
    assert.ok(/click Play/i.test(r.needsManualClick), r.needsManualClick);
    assert.equal(r.ok, true);
    assert.equal(r.deferred, true);
    playSave.reconcileUnrestoredBoot(APP);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
  it('a refused load reports the log line instead of waiting out the timeout', async () => {
    reset();
    const dir = path.join(TMP, 'logs-reject');
    fs.mkdirSync(dir, { recursive: true });
    const line = 'LoadGameViewState leaving the network session due to an early exit of the game state.';
    const fp = path.join(dir, 'net_message_debug.log');
    fs.writeFileSync(fp, `setup\n${line}\n`);
    // Dated ahead, as above: the boot captures bootMs after the tuner
    // phase, and only this-boot logs count.
    const ahead = new Date(Date.now() + 60000);
    fs.utimesSync(fp, ahead, ahead);
    const start = Date.now();
    const r = await playSave.bootSave(save, bootOpts({
      logsDirs: [dir],
      openBridgeFn: () => Promise.reject(new Error('refused')),
      executeFn: () => Promise.resolve(),
      menuPollIntervalMs: 5,
      menuTimeoutMs: 40,
      loadTimeoutMs: 5000,
    }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'load-rejected');
    assert.ok(r.error.includes(line), r.error);
    assert.equal(r.loadReason, line);
    assert.equal(r.needsManualClick, undefined);
    assert.ok(Date.now() - start < 5000, 'a refused load must not wait out the timeout');
    playSave.reconcileUnrestoredBoot(APP);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
  });
});
