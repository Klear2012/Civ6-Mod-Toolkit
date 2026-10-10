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
  it('boots plant the relative value the menu reads', async () => {
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
    assert.equal(seen.playNow, 'Single/auto/AutoSave_0001.Civ6Save');
    assert.equal(r.planted, 'Single/auto/AutoSave_0001.Civ6Save');
    assert.equal(r.restored, true);
    assert.equal(fs.readFileSync(APP, 'utf8'), APP_ORIGINAL);
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
    assert.equal(playSave.readPlayNowSave(APP), 'Single/auto/AutoSave_0001.Civ6Save');
    assert.ok(fs.existsSync(`${APP}.toolkit-boot`));
    const rec = playSave.reconcileUnrestoredBoot(APP);
    assert.equal(rec.reconciled, true);
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
  });
});
