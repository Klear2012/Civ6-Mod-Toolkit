'use strict';

// Mirror for the recursive config scan: the game nests AutoConfig .Civ6Cfg
// files under Single/auto/ and auto/prev/, which the old top-level
// readdirSync never saw. Synthetic Temp tree only; the live saves folder,
// the game database and Civ6 itself are never touched.
//
// Run with `node --test tests/config-scan.test.js`.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp } = require('./helpers');
const configscan = require('../src/configscan');

const TMP = makeTmp('civ6-config-scan-');
const SINGLE = path.join(TMP, 'Saves', 'Single');
const MULTI = path.join(TMP, 'Saves', 'Multi');

function put(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content == null ? 'cfg-bytes' : content);
}

before(() => {
  put(path.join(SINGLE, 'Game1.Civ6Cfg'));
  put(path.join(SINGLE, 'auto', 'AutoConfig_Game_01.Civ6Cfg'));
  put(path.join(SINGLE, 'auto', 'prev', 'AutoConfig_Game_01.Civ6Cfg'));
  // Big blobs the listing must never open: the sail-by-name rule skips them.
  put(path.join(SINGLE, 'auto', 'bigblob.Civ6Save'), Buffer.alloc(2 * 1024 * 1024));
  put(path.join(SINGLE, 'readme.txt'), 'not a config');
  // A folder wearing a save extension holds saves, never configs.
  put(path.join(SINGLE, 'sneaky.Civ6Save', 'Hidden.Civ6Cfg'));
  // Depth ladder: a/b/c is depth 3 (listed), a/b/c/d is depth 4 (not).
  put(path.join(SINGLE, 'a', 'b', 'c', 'L3.Civ6Cfg'));
  put(path.join(SINGLE, 'a', 'b', 'c', 'd', 'Deep.Civ6Cfg'));
  put(path.join(MULTI, 'MPGame.Civ6Cfg'));
  put(path.join(MULTI, 'auto', 'MPAuto.Civ6Cfg'));
});

describe('recursion finds nested configs', () => {
  it('sees the top-level, auto/ and auto/prev/ configs', () => {
    const names = configscan.scanConfigDir(SINGLE).map((c) => c.rel);
    assert.ok(names.includes('Game1.Civ6Cfg'), names.join(', '));
    assert.ok(names.includes(path.join('auto', 'AutoConfig_Game_01.Civ6Cfg')), names.join(', '));
    assert.ok(names.includes(path.join('auto', 'prev', 'AutoConfig_Game_01.Civ6Cfg')), names.join(', '));
  });
  it('lists exactly the four real configs, nothing else', () => {
    assert.equal(configscan.scanConfigDir(SINGLE).length, 4);
  });
  it('scans each saves side on its own', () => {
    const multi = configscan.scanConfigDir(MULTI).map((c) => c.name).sort();
    assert.deepEqual(multi, ['MPAuto.Civ6Cfg', 'MPGame.Civ6Cfg']);
    assert.ok(!configscan.scanConfigDir(SINGLE).some((c) => c.name === 'MPGame.Civ6Cfg'));
  });
  it('a missing folder lists as empty, never throws', () => {
    assert.deepEqual(configscan.scanConfigDir(path.join(TMP, 'no-such-dir')), []);
  });
});

describe('duplicate basenames carry distinct relative paths', () => {
  it('both auto/ copies are listed with different rels', () => {
    const dups = configscan.scanConfigDir(SINGLE).filter((c) => c.name === 'AutoConfig_Game_01.Civ6Cfg');
    assert.equal(dups.length, 2);
    assert.notEqual(dups[0].rel, dups[1].rel);
    assert.deepEqual(
      dups.map((c) => c.rel).sort(),
      [path.join('auto', 'AutoConfig_Game_01.Civ6Cfg'), path.join('auto', 'prev', 'AutoConfig_Game_01.Civ6Cfg')].sort()
    );
  });
  it('duplicates sort adjacently so the picker can label them once', () => {
    const rows = configscan.scanConfigDir(SINGLE);
    const at = rows.map((c) => c.name).lastIndexOf('AutoConfig_Game_01.Civ6Cfg')
      - rows.map((c) => c.name).indexOf('AutoConfig_Game_01.Civ6Cfg');
    assert.equal(at, 1);
  });
});

describe('listing never reads file contents', () => {
  const bomb = () => { throw new Error('content read during listing'); };
  let saved;
  before(() => {
    saved = { read: fs.readFileSync, async: fs.readFile, stream: fs.createReadStream };
    fs.readFileSync = bomb;
    fs.readFile = bomb;
    fs.createReadStream = bomb;
  });
  after(() => {
    fs.readFileSync = saved.read;
    fs.readFile = saved.async;
    fs.createReadStream = saved.stream;
  });
  it('the full Single tree still lists with every read entry point armed', () => {
    assert.equal(configscan.scanConfigDir(SINGLE).length, 4);
  });
  it('the server list builds on the name scan, not on read+parse', () => {
    const norm = saved.read(path.join(__dirname, '..', 'src', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
    const at = norm.indexOf('function listConfigs(');
    const body = norm.slice(at, norm.indexOf('\n}\n', at));
    assert.ok(/scanConfigDir\(saves\.root\)/.test(body), body);
    assert.ok(!/readFileSync\s*\(/.test(body), body);
    assert.ok(!/cfg\.listMods\s*\(/.test(body), body);
  });
});

describe('save blobs and depth cap', () => {
  it('the big .Civ6Save blob is never listed', () => {
    assert.ok(!configscan.scanConfigDir(SINGLE).some((c) => /\.Civ6Save$/i.test(c.name)));
  });
  it('a folder named *.Civ6Save is never descended into', () => {
    assert.ok(!configscan.scanConfigDir(SINGLE).some((c) => c.name === 'Hidden.Civ6Cfg'));
  });
  it('depth 3 is listed, depth 4 is not', () => {
    const names = configscan.scanConfigDir(SINGLE).map((c) => c.name);
    assert.ok(names.includes('L3.Civ6Cfg'), names.join(', '));
    assert.ok(!names.includes('Deep.Civ6Cfg'), names.join(', '));
  });
  it('the cap is three', () => {
    assert.equal(configscan.MAX_SCAN_DEPTH, 3);
  });
});

describe('50-config tree timing budget', () => {
  it('lists without content reads well inside budget (measured ms printed)', () => {
    const perf = path.join(TMP, 'perf', 'Single');
    for (let i = 0; i < 50; i++) {
      put(path.join(perf, `sub${i % 5}`, `Cfg${i}.Civ6Cfg`));
    }
    for (let i = 0; i < 5; i++) {
      put(path.join(perf, `Save${i}.Civ6Save`), Buffer.alloc(1024 * 1024));
    }
    const t0 = Date.now();
    const rows = configscan.scanConfigDir(perf);
    const ms = Date.now() - t0;
    console.log(`    50-config scan measured: ${ms}ms`);
    assert.equal(rows.length, 50);
    assert.ok(ms < 3000, `${ms}ms over the 3000ms budget`);
  });
});

// Fresh paths module per scenario: loadOverrides memoises, so a shared
// instance would carry one scenario's verdict into the next.
const wasPathsFile = process.env.CIV6_PATHS_FILE;
const wasSaves = process.env.CIV6_SAVES;
const scratchPaths = path.join(TMP, 'paths-overrides.json');

function withPaths(text) {
  delete require.cache[require.resolve('../src/paths')];
  if (text === undefined) {
    delete process.env.CIV6_PATHS_FILE;
    try {
      fs.unlinkSync(scratchPaths);
    } catch (_) {
      /* absent */
    }
  } else {
    process.env.CIV6_PATHS_FILE = scratchPaths;
    fs.writeFileSync(scratchPaths, text);
  }
  delete process.env.CIV6_SAVES;
  return require('../src/paths');
}

after(() => {
  if (wasPathsFile === undefined) delete process.env.CIV6_PATHS_FILE;
  else process.env.CIV6_PATHS_FILE = wasPathsFile;
  if (wasSaves === undefined) delete process.env.CIV6_SAVES;
  else process.env.CIV6_SAVES = wasSaves;
  delete require.cache[require.resolve('../src/paths')];
});

describe('Single/Multi roots come from the same game root', () => {
  it('Single and Multi are siblings, Single the default', () => {
    const p = withPaths(undefined);
    const single = p.getSavesDir('single');
    const multi = p.getSavesDir('multi');
    assert.ok(single.root.endsWith('Single'), single.root);
    assert.ok(multi.root.endsWith('Multi'), multi.root);
    assert.equal(path.dirname(multi.root), path.dirname(single.root));
    assert.equal(p.getSavesDir().root, single.root);
    assert.equal(single.custom, false);
    assert.equal(single.mode, 'single');
    assert.equal(multi.mode, 'multi');
  });
  it('a custom saves override replaces both sides and says so', () => {
    const custom = path.join(TMP, 'custom-saves');
    fs.mkdirSync(custom, { recursive: true });
    const p = withPaths(JSON.stringify({ saves: custom }));
    const single = p.getSavesDir('single');
    const multi = p.getSavesDir('multi');
    assert.equal(single.root, custom);
    assert.equal(multi.root, custom);
    assert.equal(single.custom, true);
    assert.equal(single.mode, 'custom');
  });
});

describe('server and picker wiring', () => {
  const srv = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const cfgJs = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8');
  const html = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  it('the state route passes the Single/Multi choice into the scan', () => {
    assert.ok(/url\.searchParams\.get\('saves'\)/.test(srv()));
    assert.ok(/paths\.getSavesDir\(savesMode\)/.test(srv()));
    assert.ok(/listConfigs\(savesMode\)/.test(srv()));
  });
  it('open/save/delete resolve the client path inside the saves roots', () => {
    const text = srv();
    for (const fn of ['handleGetConfig', 'handlePostSave', 'handlePostDelete']) {
      assert.ok(new RegExp(`function ${fn}[\\s\\S]{0,400}resolveConfigPath`).test(text), fn);
    }
    assert.ok(/allowedConfigRoots\(\)\.some/.test(text));
  });
  it('the dropdown drops the per-file mod count and labels duplicates by location', () => {
    const text = cfgJs();
    assert.ok(!/c\.mods/.test(text), 'mod count still in the picker');
    assert.ok(/dupes\.has\(c\.name\)/.test(text));
    assert.ok(/\$\{c\.name\} — \$\{c\.rel\}/.test(text));
  });
  it('the empty message names the folder scanned, per side', () => {
    const text = cfgJs();
    assert.ok(/No configurations found in the \$\{folderWord\} saves folder/.test(text));
    assert.ok(/Single-player/.test(text) && /Multiplayer/.test(text));
  });
  it('a custom folder disables the toggle with a plain-words why', () => {
    const text = cfgJs();
    assert.ok(/s\.savesCustom/.test(text));
    assert.ok(/\.disabled = custom/.test(text));
    assert.ok(/no Single\/Multiplayer choice/.test(text));
    assert.ok(/savesSingle/.test(html()) && /savesMulti/.test(html()) && /savesNote/.test(html()));
  });
});
