'use strict';

// Suite for the browser page's scripts, checked the way a browser loads them
// (cut over from src/phase8-scripts.js, Tests 1-14).
//
// One it() per executed check(), labels and expectations verbatim
// (per-script and per-nav loops unroll to one it() per execution), so the
// executed-check count gate (140) proves 1:1 cover. Run the whole file with
// `node --test tests/browser-scripts.test.js`, or one slice with
// `node --test --test-name-pattern="<name>" tests/browser-scripts.test.js`
// (this Node rejects the `-t` shorthand — always spell it out).
//
// Cut over in cutover-gate-to-node-test: the phase script is deleted and
// this file is authoritative.
//
// Why the combination check exists: classic <script> tags share ONE global
// scope, so a top-level `const` in two files is a SyntaxError the browser
// punishes by discarding BOTH files (once unreachable-override-surfaced as a
// router bug). Per-file `node --check` cannot see this by construction — each
// file is valid alone — so this file checks the combination, like a browser.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = process.env.CIV6_PUBLIC_DIR || path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

describe('Test 1: every script index.html loads exists, and every one it ships is loaded', () => {
  const onDisk = fs.readdirSync(PUB).filter((f) => f.endsWith('.js')).sort();
  it('index.html loads at least the shared app and one page', () => {
    assert.ok(scriptSrcs.includes('app.js') && scriptSrcs.length >= 4, scriptSrcs.join(', '));
  });
  for (const s of scriptSrcs) {
    it(`  ${s} exists`, () => {
      assert.ok(fs.existsSync(path.join(PUB, s)));
    });
  }
  it('  and no script on disk is left unloaded', () => {
    const orphans = onDisk.filter((f) => !scriptSrcs.includes(f));
    assert.ok(orphans.length === 0, orphans.join(', '));
  });
});

describe('Test 2: every script parses on its own', () => {
  for (const s of scriptSrcs) {
    it(`  ${s}`, () => {
      let ok = true;
      let err = '';
      try { new vm.Script(fs.readFileSync(path.join(PUB, s), 'utf8'), { filename: s }); }
      catch (e) { ok = false; err = e.message; }
      assert.ok(ok, err);
    });
  }
});

describe('Test 3: they parse together, as one program - which is how a browser reads them', () => {
  it('the scripts index.html loads, concatenated, parse as one program', () => {
    const all = scriptSrcs
      .map((s) => `// ==== ${s} ====\n${fs.readFileSync(path.join(PUB, s), 'utf8').replace(/\r\n/g, '\n')}`)
      .join('\n');
    let ok = true;
    let err = '';
    let where = '';
    try {
      new vm.Script(all, { filename: 'public-concatenated.js' });
    } catch (e) {
      ok = false;
      err = e.message;
      const m = (e.stack || '').match(/public-concatenated\.js:(\d+)/);
      if (m) {
        const upto = all.split('\n').slice(0, Number(m[1])).join('\n');
        const at = upto.lastIndexOf('// ==== ');
        where = upto.slice(at + 8, upto.indexOf('\n', at));
      }
    }
    assert.ok(ok, ok ? `${scriptSrcs.length} files` : `${err}${where ? ` (in ${where})` : ''}`);
  });
});

describe('Test 4: no top-level name is declared twice across those scripts', () => {
  const DECL = [
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;\[]/,
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^class\s+([A-Za-z_$][\w$]*)\s*[({]/,
  ];
  const owners = new Map();
  for (const s of scriptSrcs) {
    fs.readFileSync(path.join(PUB, s), 'utf8').replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      for (const re of DECL) {
        const m = re.exec(line);
        if (!m) continue;
        if (!owners.has(m[1])) owners.set(m[1], []);
        owners.get(m[1]).push(`${s}:${i + 1}`);
      }
    });
  }
  const dupes = [...owners].filter(([, v]) => v.length > 1);
  it('no top-level name is declared in two of them', () => {
    assert.ok(dupes.length === 0,
      dupes.map(([n, v]) => `${n} in ${v.join(' and ')}`).join('; '));
  });
  it('  and the scan found the declarations to compare', () => {
    assert.ok(owners.size >= 20, `${owners.size} top-level names`);
  });
});

describe('Test 5: every route the navigation offers is registered by some script', () => {
  const navs = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);
  it('the navigation offers at least the four pages', () => {
    assert.ok(navs.length >= 4, navs.join(', '));
  });
  const all = scriptSrcs.map((s) => fs.readFileSync(path.join(PUB, s), 'utf8')).join('\n');
  for (const n of navs) {
    it(`  #/${n} is registered`, () => {
      const re = new RegExp(`pages\\s*(?:\\[['"]${n}['"]\\]|\\.${n}\\s*=|\\[['"]${n}['"]\\]\\s*=)`);
      assert.ok(re.test(all));
    });
  }
});

describe('Test 6: mod names render in page HTML and strip in dialogs/options', () => {
  const MODNAME = /\bmodName\b|(?:^|[^\w$])[moa]\.name\b/;
  const bad = [];
  for (const s of scriptSrcs) {
    fs.readFileSync(path.join(PUB, s), 'utf8').replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('*')) return;
      if (/esc\s*\(/.test(line) && MODNAME.test(line) && !/renderCivText|stripCivText/.test(line)) {
        bad.push(`${s}:${i + 1} esc() around a mod name: ${t}`);
      }
      if (/confirm\s*\(|prompt\s*\(|<option/.test(line) && /\$\{/.test(line)
        && MODNAME.test(line) && !/stripCivText/.test(line)) {
        bad.push(`${s}:${i + 1} raw mod name in a dialog/option string: ${t}`);
      }
    });
  }
  const lov = fs.readFileSync(path.join(PUB, 'looverrides.js'), 'utf8');
  const pro = fs.readFileSync(path.join(PUB, 'profiles.js'), 'utf8');
  const cfg = fs.readFileSync(path.join(PUB, 'config.js'), 'utf8');
  const mod = fs.readFileSync(path.join(PUB, 'mods.js'), 'utf8');
  const lord = fs.readFileSync(path.join(PUB, 'loadorder.js'), 'utf8');
  const uses = scriptSrcs.map((s) => fs.readFileSync(path.join(PUB, s), 'utf8'))
    .join('\n').match(/(?:render|strip)CivText\(/g) || [];
  it('no template escapes a mod name instead of rendering it', () => {
    assert.ok(bad.length === 0, bad.join('; '));
  });
  it('  the override prompt still strips the mod name', () => {
    assert.ok(/stripCivText\(o\.modName\)/.test(lov));
  });
  it('  the profile switch preview still strips mod names', () => {
    assert.ok(/stripCivText\(\(all\.get\(id\)/.test(pro) && /stripCivText\(m\.name\)/.test(pro));
  });
  it('  the config delete confirm still strips the name', () => {
    assert.ok(/stripCivText\(name\)/.test(cfg));
  });
  it('  the import-skipped toast detail still renders mod names', () => {
    assert.ok(/names\.slice\(0,\s*5\)\.map\(renderCivText\)/.test(pro));
  });
  it('  the remove-mod confirm still strips the mod name', () => {
    assert.ok(/stripCivText\(m\.name\)/.test(mod));
  });
  it('  condition reason/why text renders civ markup', () => {
    assert.ok(/renderCivText\(a\.reason\)/.test(lord) && /renderCivText\(a\.unknown\[0\]\.why\)/.test(lord));
  });
  it('  and the scan saw the helpers in use', () => {
    assert.ok(uses.length >= 10, `${uses.length} render/strip call sites`);
  });
});

describe('Test 7: differential attribution renders (log-pairing 3.1)', () => {
  const cfSrc = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub = (s) => escStub(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els = {};
  const dollarStub = (id) => {
    if (!els[id]) els[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', addEventListener() {} };
    return els[id];
  };
  let cx = null;
  let cxErr = '';
  try {
    cx = vm.createContext({ $: dollarStub, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub, renderCivText: renderStub,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc, cx, { filename: 'conflicts.js' });
  } catch (e) { cxErr = e.message; }
  it('the conflicts script loads headless under stubs', () => {
    assert.ok(cx !== null, cxErr);
  });
  if (cx) {
    const run = (expr) => vm.runInContext(expr, cx);
    const REPLAY7 = '{"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":true,"agreements":[{"responsibleModId":"m1","responsibleModName":"[COLOR_GREEN]Green Mod[ENDCOLOR]","fileLabel":"Data.xml","stmtIndex":0,"logLine":10,"logText":"boom","strength":"context-proven","approximate":false,"attribution":{}}],"replayOnly":[{"responsibleModId":"m2","responsibleModName":"Plain Mod","fileLabel":"B.sql","stmtIndex":1,"replayError":"fail","strength":"replay","approximate":false}],"logOnly":[{"responsibleModId":null,"fileLabel":"C.xml","stmtIndex":null,"logLine":20,"logText":"lost","strength":"hint-matched","approximate":false,"attribution":{}},{"responsibleModId":"m3","responsibleModName":"Bracket Mod","fileLabel":"D.xml","stmtIndex":null,"logLine":21,"logText":"b","strength":"bracket-approximate","approximate":true,"attribution":{}},{"responsibleModId":null,"fileLabel":"(no file hint)","stmtIndex":null,"logLine":22,"logText":"u","strength":"bracket-approximate","approximate":true,"attribution":{"kind":"bracket-ambiguous","candidates":[{"path":"a","attribution":{"modName":"Cand A"}},{"path":"b","attribution":{"modName":"Cand B"}}]}},{"responsibleModId":null,"fileLabel":"(no file hint)","stmtIndex":null,"logLine":23,"logText":"v","strength":"unattributed","approximate":true,"attribution":{"kind":"unattributed","reason":"no-loading-precedes"}}]}}';
    // Rendered per it (not once): the render is deterministic, and each it
    // must pass standalone under --test-name-pattern filtering.
    const renderReplay7 = () => { run(`cfState.replay = ${REPLAY7}`); run('cfRenderReplay()'); return els.cfReplayDiff.innerHTML; };
    it('an attributed row names the mod', () => {
      const named = run('cfResponsibleHtml({ responsibleModId: "m1", responsibleModName: "[COLOR_GREEN]Green Mod[ENDCOLOR]" })');
      assert.ok(/Green Mod/.test(named), named);
    });
    it('  with no literal bracket tags', () => {
      const named = run('cfResponsibleHtml({ responsibleModId: "m1", responsibleModName: "[COLOR_GREEN]Green Mod[ENDCOLOR]" })');
      assert.ok(!/\[COLOR/i.test(named) && !/ENDCOLOR/i.test(named), named);
    });
    it('attributed strength renders in plain words', () => {
      const tCtx = run('cfStrengthTag({ responsibleModId: "m1", strength: "context-proven", approximate: false })');
      assert.ok(/traced to this mod/.test(tCtx), tCtx);
    });
    it('hint strength renders in plain words', () => {
      const tHint = run('cfStrengthTag({ responsibleModId: "m1", strength: "hint-matched", approximate: false })');
      assert.ok(/matched by file name/.test(tHint), tHint);
    });
    it('best-guess renders with the approximate marker', () => {
      const tBra = run('cfStrengthTag({ responsibleModId: "m3", strength: "bracket-approximate", approximate: true })');
      assert.ok(/best guess/.test(tBra) && /approximate/.test(tBra), tBra);
    });
    it('replay strength renders in plain words', () => {
      assert.ok(/found by replay/.test(run('cfStrengthTag({ responsibleModId: "m2", strength: "replay" })')));
    });
    it('unattributed rows never carry an attributing label', () => {
      assert.ok(/no mod named/.test(run('cfStrengthTag({ strength: "context-proven" })'))
        && !/traced to this mod/.test(run('cfStrengthTag({ strength: "context-proven" })'))
        && !/matched by file name/.test(run('cfStrengthTag({ strength: "hint-matched" })')));
    });
    it('same-ms ambiguity lists candidates instead of picking', () => {
      const amb = run('cfAttributionNote({ responsibleModId: null, attribution: { kind: "bracket-ambiguous", candidates: [{ path: "a", attribution: { modName: "Cand A" } }, { path: "b", attribution: { modName: "Cand B" } }] } })');
      assert.ok(/Cand A/.test(amb) && /Cand B/.test(amb) && /could be/.test(amb), amb);
    });
    it('an unattributed row states so in plain words', () => {
      const unResp = run('cfResponsibleHtml({})');
      const unTag = run('cfStrengthTag({ strength: "unattributed" })');
      assert.ok(/Mod unknown/.test(unResp) && /no mod named/.test(unTag), `${unResp} / ${unTag}`);
    });
    it('  with the reason stated in plain words, never dropped', () => {
      const unNote = run('cfAttributionNote({ responsibleModId: null, attribution: { kind: "unattributed", reason: "no-loading-precedes" } })');
      assert.ok(/nothing was loading/.test(unNote), unNote);
    });
    it('the differential names the mod with no literal bracket tags', () => {
      const diffHtml = renderReplay7();
      assert.ok(/Green Mod/.test(diffHtml) && !/\[COLOR/i.test(diffHtml), diffHtml.slice(0, 200));
    });
    it('  plain-language strengths render in place, never raw backend labels', () => {
      const diffHtml = renderReplay7();
      assert.ok(/traced to this mod/.test(diffHtml) && /no mod named/.test(diffHtml) && /best guess/.test(diffHtml)
        && /found by replay/.test(diffHtml) && /several possible/.test(diffHtml)
        && !/context-proven|hint-matched|bracket-approximate|named by replay/.test(diffHtml));
    });
    it('  the approximate marker and candidate list render', () => {
      const diffHtml = renderReplay7();
      assert.ok(/approximate/.test(diffHtml) && /Cand A/.test(diffHtml) && /Cand B/.test(diffHtml));
    });
    it('  the unattributed row states so with its reason in plain words', () => {
      const diffHtml = renderReplay7();
      assert.ok(/Mod unknown/.test(diffHtml) && /nothing was loading/.test(diffHtml));
    });
  }
});

describe('Test 8: differential grouped by mod, searchable, hideable (log-pairing follow-up)', () => {
  const cfSrc8 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub8 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub8 = (s) => escStub8(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els8 = {};
  const dollarStub8 = (id) => {
    if (!els8[id]) els8[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els8[id];
  };
  let cx8 = null;
  let cxErr8 = '';
  try {
    cx8 = vm.createContext({ $: dollarStub8, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub8, renderCivText: renderStub8,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc8, cx8, { filename: 'conflicts.js' });
  } catch (e) { cxErr8 = e.message; }
  it('the conflicts script loads headless under stubs', () => {
    assert.ok(cx8 !== null, cxErr8);
  });
  if (cx8) {
    const run8 = (expr) => vm.runInContext(expr, cx8);
    const REPLAY8 = '{"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":1,"collisions":[],"gatedOut":[{"modId":"guid-gated-999","modName":"Gated Mod","fileLabel":"g.sql","statements":1,"reason":"needs some-mod to be on in this profile"}],"gatedUnknown":[],"perFile":[],"differential":{"available":true,"agreements":[{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"A.xml","stmtIndex":0,"logLine":10,"logText":"UNIQUE constraint failed: T.Id","replayError":"UNIQUE constraint failed: T.Id","strength":"context-proven","approximate":false,"attribution":{}}],"replayOnly":[{"responsibleModId":"guid-bbb-222","responsibleModName":"Plain Mod","fileLabel":"B.sql","stmtIndex":1,"replayError":"no such table: Nope","strength":"replay","approximate":false}],"logOnly":[{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L1.xml","stmtIndex":null,"logLine":20,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L2.xml","stmtIndex":null,"logLine":21,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L3.xml","stmtIndex":null,"logLine":22,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":null,"responsibleModName":null,"fileLabel":"C.xml","stmtIndex":null,"logLine":23,"logText":"lost","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint","fileHint":"C.xml","reason":"file-hint-only"}}]}}';
    // cfState is set per it (not once): each it must pass standalone
    // under --test-name-pattern filtering; the render is deterministic.
    const base8 = () => { run8(`cfState.replay = ${REPLAY8}`); };
    it('one group per responsible mod with per-mod counts', () => {
      base8();
      run8('cfState.diffFilter = ""; cfState.hideUnattributed = false');
      run8('cfRenderReplay()');
      const diffHtml8 = els8.cfReplayDiff.innerHTML;
      assert.ok(/Green Mod/.test(diffHtml8) && /2 findings/.test(diffHtml8) && /Plain Mod/.test(diffHtml8)
        && /Mod unknown/.test(diffHtml8), diffHtml8.slice(0, 300));
    });
    it('same failure across three files reads as one finding', () => {
      base8();
      run8('cfState.diffFilter = ""; cfState.hideUnattributed = false');
      run8('cfRenderReplay()');
      const diffHtml8 = els8.cfReplayDiff.innerHTML;
      assert.ok((diffHtml8.match(/no such table: Lang/g) || []).length === 1
        && /3 files, same error/.test(diffHtml8) && /L1\.xml/.test(diffHtml8) && /L3\.xml/.test(diffHtml8));
    });
    it('attributed groups order before unattributed', () => {
      base8();
      run8('cfState.diffFilter = ""; cfState.hideUnattributed = false');
      run8('cfRenderReplay()');
      const diffHtml8 = els8.cfReplayDiff.innerHTML;
      assert.ok(diffHtml8.indexOf('Green Mod') < diffHtml8.indexOf('Plain Mod')
        && diffHtml8.indexOf('Plain Mod') < diffHtml8.indexOf('Mod unknown'));
    });
    it('hide-unattributed drops the unnamed group with a hidden-count note', () => {
      base8();
      run8('cfState.hideUnattributed = true');
      run8('cfRenderDiff()');
      assert.ok(!/Mod unknown/.test(els8.cfReplayDiff.innerHTML) && /Green Mod/.test(els8.cfReplayDiff.innerHTML)
        && /1 unnamed finding hidden/.test(els8.cfDiffNote.textContent), els8.cfDiffNote.textContent);
    });
    it('exact-match search shows only the named mod group', () => {
      base8();
      run8('cfState.hideUnattributed = false; cfState.diffFilter = "green mod"');
      run8('cfRenderDiff()');
      assert.ok(/Green Mod/.test(els8.cfReplayDiff.innerHTML) && !/Plain Mod/.test(els8.cfReplayDiff.innerHTML)
        && !/Mod unknown/.test(els8.cfReplayDiff.innerHTML)
        && /matching the filter/.test(els8.cfDiffNote.textContent), els8.cfDiffNote.textContent);
    });
    it('search with no exact match is an explicit empty state', () => {
      base8();
      run8('cfState.diffFilter = "no such mod"');
      run8('cfRenderDiff()');
      assert.ok(/No mod is named exactly that/.test(els8.cfReplayDiff.innerHTML));
    });
    it('differential rows never show raw mod ids', () => {
      base8();
      run8('cfState.diffFilter = ""');
      run8('cfRenderDiff()');
      const fullHtml8 = els8.cfReplayDiff.innerHTML;
      assert.ok(!/guid-aaa-111|guid-bbb-222/.test(fullHtml8), fullHtml8.slice(0, 200));
    });
    it('gated-out rows name the mod display name, not the id', () => {
      base8();
      run8('cfState.diffFilter = ""');
      run8('cfRenderDiff()');
      const gatedHtml8 = els8.cfReplayGated.innerHTML;
      assert.ok(/Gated Mod/.test(gatedHtml8) && !/guid-gated-999/.test(gatedHtml8)
        && /not run/.test(gatedHtml8), gatedHtml8.slice(0, 200));
    });
    it('no contradictory labels on unattributed rows', () => {
      base8();
      run8('cfState.diffFilter = ""');
      run8('cfRenderDiff()');
      const fullHtml8 = els8.cfReplayDiff.innerHTML;
      const unSection8 = fullHtml8.slice(fullHtml8.indexOf('Mod unknown'));
      assert.ok(!/traced to this mod|best guess|found by replay/.test(unSection8)
        && /no mod named/.test(unSection8));
    });
    it('tooltips answer what-to-do-next', () => {
      base8();
      run8('cfState.diffFilter = ""');
      run8('cfRenderDiff()');
      const fullHtml8 = els8.cfReplayDiff.innerHTML;
      assert.ok(/title="/.test(fullHtml8) && /open the file/.test(fullHtml8));
    });
    it('attributed file-name matches render in plain words', () => {
      base8();
      run8('cfState.diffFilter = ""');
      run8('cfRenderDiff()');
      const fullHtml8 = els8.cfReplayDiff.innerHTML;
      assert.ok(/matched by file name/.test(fullHtml8));
    });
  }
});

describe('Test 9: conflicts readability (toggle layout, heading, stacked divergences, collision names)', () => {
  const cfSrc9 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub9 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub9 = (s) => escStub9(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els9 = {};
  const dollarStub9 = (id) => {
    if (!els9[id]) els9[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els9[id];
  };
  let cx9 = null;
  let cxErr9 = '';
  try {
    cx9 = vm.createContext({ $: dollarStub9, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub9, renderCivText: renderStub9,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc9, cx9, { filename: 'conflicts.js' });
  } catch (e) { cxErr9 = e.message; }
  it('the conflicts script loads headless under stubs', () => {
    assert.ok(cx9 !== null, cxErr9);
  });
  if (cx9) {
    const run9 = (expr) => vm.runInContext(expr, cx9);
    it('collision rows render the display name, never the mod id', () => {
      const whoNamed = run9('cfWhoHtml({ modId: "guid-winner-1", modName: "[COLOR_GREEN]Winner Mod[ENDCOLOR]", fileLabel: "w.sql", stmtIndex: 2 })');
      assert.ok(/Winner Mod/.test(whoNamed) && !/guid-winner-1/.test(whoNamed) && !/\[COLOR/i.test(whoNamed), whoNamed);
    });
    it('  with mod-id fallback only when unresolvable', () => {
      const whoFallback = run9('cfWhoHtml({ modId: "guid-unknown-9", fileLabel: "g.sql", stmtIndex: 0 })');
      assert.ok(/guid-unknown-9/.test(whoFallback), whoFallback);
    });
    it('same-mod pairs carry the same-mod tag', () => {
      const sameTag = run9('cfCollisionHtml({ table: "T", pk: "k", column: "V", writes: 2, sameMod: true, fidelityLimited: [], winner: { modId: "m", modName: "Same Mod", fileLabel: "a.sql", stmtIndex: 0 }, losers: [] })');
      assert.ok(/same mod/.test(sameTag), sameTag.slice(0, 200));
    });
    it('  and cross-mod pairs carry none', () => {
      const crossTag = run9('cfCollisionHtml({ table: "T", pk: "k", column: "V", writes: 2, sameMod: false, fidelityLimited: [], winner: { modId: "m", modName: "M", fileLabel: "a.sql", stmtIndex: 0 }, losers: [] })');
      assert.ok(!/same mod/.test(crossTag));
    });
    const REPLAY9 = '{"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[{"table":"CrossT","pk":"k","column":"V","writes":2,"sameMod":false,"fidelityLimited":[],"winner":{"modId":"guid-cross-w","modName":"Cross Winner","fileLabel":"w.sql","stmtIndex":0},"losers":[{"modId":"guid-cross-l","modName":"Cross Loser","fileLabel":"l.sql","stmtIndex":0}]},{"table":"SameT","pk":"k","column":"V","writes":2,"sameMod":true,"fidelityLimited":[],"winner":{"modId":"guid-same-w","modName":"Same Winner","fileLabel":"w2.sql","stmtIndex":1},"losers":[{"modId":"guid-same-w","modName":"Same Winner","fileLabel":"w1.sql","stmtIndex":0}]}],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":false,"reason":"no log"}}';
    const renderCollisions9 = () => { run9(`cfState.replay = ${REPLAY9}`); run9('cfRenderReplay()'); return els9.cfReplayCollisions.innerHTML; };
    it('replay rows name mods, never raw ids', () => {
      const colHtml9 = renderCollisions9();
      assert.ok(/Cross Winner/.test(colHtml9) && /Same Winner/.test(colHtml9) && /Cross Loser/.test(colHtml9)
        && !/guid-cross-w|guid-cross-l|guid-same-w/.test(colHtml9), colHtml9.slice(0, 200));
    });
    it('the client keeps server order: same-mod rows render after cross-mod rows', () => {
      const colHtml9 = renderCollisions9();
      assert.ok(colHtml9.indexOf('CrossT') >= 0 && colHtml9.indexOf('CrossT') < colHtml9.indexOf('SameT')
        && /same mod/.test(colHtml9.slice(colHtml9.indexOf('SameT'))));
    });
    it('divergence keeps the same content', () => {
      const divHtml9 = run9('cfCalibrationHtml({ available: true, divergences: [{ assumedFirst: "m/a.sql", assumedSecond: "m/b.sql", assumedOrder: "m/a.sql before m/b.sql (assumed replay order)", observedOrder: "m/b.sql before m/a.sql (game-observed order)" }] })');
      assert.ok(/m\/a\.sql/.test(divHtml9) && /m\/b\.sql/.test(divHtml9)
        && /assumed replay order/.test(divHtml9) && /game-observed order/.test(divHtml9), divHtml9.slice(0, 200));
    });
    it('divergence rows stack: pair on its own line, no side-by-side columns', () => {
      const divHtml9 = run9('cfCalibrationHtml({ available: true, divergences: [{ assumedFirst: "m/a.sql", assumedSecond: "m/b.sql", assumedOrder: "m/a.sql before m/b.sql (assumed replay order)", observedOrder: "m/b.sql before m/a.sql (game-observed order)" }] })');
      assert.ok(/lo-bandhead/.test(divHtml9) && !/<span class="lo-mod">order differs/.test(divHtml9));
    });
    it('the differential section is headed Log pairing report', () => {
      const html9 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
      assert.ok(/<h3>Log pairing report<\/h3>/.test(html9) && !/Game log vs replay/.test(html9));
    });
    it('the hidden-count note sits under the toggle row, not beside it', () => {
      const html9 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
      const hideAt9 = html9.indexOf('id="cfHideUnattributed"');
      const noteAt9 = html9.indexOf('id="cfDiffNote"');
      assert.ok(hideAt9 >= 0 && noteAt9 > hideAt9 && /<\/div>/.test(html9.slice(hideAt9, noteAt9)));
    });
    it('toggle and note keep their styling classes', () => {
      const html9 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
      assert.ok(/<label class="toggle"[^>]*><input[^>]*id="cfHideUnattributed"/.test(html9)
        && /<div class="meta" id="cfDiffNote"><\/div>/.test(html9));
    });
  }
});

describe('Test 10: conflicts polish batch (FK placement, divergence mods, heading sizes)', () => {
  const html10 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const css10 = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  it('the FK control is labelled how-to-handle in plain words', () => {
    assert.ok(/<label class="meta" for="cfFkMode">How to handle missing references<\/label>/.test(html10));
  });
  it('the FK select sits in the panel-head row beside Run replay', () => {
    const headAt10 = html10.indexOf('DB collision replay');
    const fkAt10 = html10.indexOf('id="cfFkMode"');
    const runAt10 = html10.indexOf('id="cfRunReplay"');
    assert.ok(headAt10 >= 0 && fkAt10 > headAt10 && runAt10 > fkAt10
      && /<\/div>\s*<\/div>\s*<div class="panel-body">/.test(html10.slice(runAt10, runAt10 + 400)));
  });
  it('Off stays the game-like default, On the strict comparison', () => {
    const fkAt10 = html10.indexOf('id="cfFkMode"');
    const fkSel10 = html10.slice(fkAt10, html10.indexOf('</select>', fkAt10));
    assert.ok(/<option value="off">Off — game-like: skip past missing references<\/option>/.test(fkSel10)
      && /<option value="on">On — strict: stop each file at the first missing reference<\/option>/.test(fkSel10));
  });
  it('the FK tooltip answers what-to-do-next', () => {
    const fkAt10 = html10.indexOf('id="cfFkMode"');
    const fkSel10 = html10.slice(fkAt10, html10.indexOf('</select>', fkAt10));
    assert.ok(/Leave Off to replay like the game/.test(fkSel10) && /Switch On for a strict comparison/.test(fkSel10));
  });
  it('the replay head row centres and wraps instead of floating detached', () => {
    assert.ok(/#page-conflicts \.panel-actions \{[^}]*align-items:\s*center[^}]*flex-wrap:\s*wrap/.test(css10));
  });
});

describe('Test 10 (divergence mods): each divergence file names its owning mod(s)', () => {
  const cfSrc10 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub10 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub10 = (s) => escStub10(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els10 = {};
  const dollarStub10 = (id) => {
    if (!els10[id]) els10[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els10[id];
  };
  let cx10 = null;
  let cxErr10 = '';
  try {
    cx10 = vm.createContext({ $: dollarStub10, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub10, renderCivText: renderStub10,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc10, cx10, { filename: 'conflicts.js' });
  } catch (e) { cxErr10 = e.message; }
  it('the conflicts script loads headless under stubs', () => {
    assert.ok(cx10 !== null, cxErr10);
  });
  if (cx10) {
    const run10 = (expr) => vm.runInContext(expr, cx10);
    const DIVERGENCE10 = '{ available: true, divergences: [{ assumedFirst: "data/a.sql", assumedSecond: "data/b.sql", assumedOrder: "data/a.sql before data/b.sql (assumed replay order)", observedOrder: "data/b.sql before data/a.sql (game-observed order)", assumedFirstMods: [{ modId: "guid-a", modName: "[COLOR_GREEN]Alpha Mod[ENDCOLOR]" }], assumedSecondMods: [{ modId: "guid-b", modName: "Beta Mod" }, { modId: "guid-c", modName: "Gamma Mod" }] }] }';
    const divHtml10 = () => run10(`cfCalibrationHtml(${DIVERGENCE10})`);
    it('each divergence file names its owning mod(s) with no bracket tags', () => {
      const h = divHtml10();
      assert.ok(/Alpha Mod/.test(h) && /Beta Mod/.test(h) && /Gamma Mod/.test(h)
        && !/\[COLOR/i.test(h) && !/ENDCOLOR/i.test(h), h.slice(0, 300));
    });
    it('multi-claimant files list every claimant, never a raw mod id', () => {
      const h = divHtml10();
      assert.ok(/Beta Mod, Gamma Mod/.test(h) && !/guid-a|guid-b|guid-c/.test(h));
    });
    it('unowned files state so in plain words', () => {
      assert.ok(/owning mod unknown/.test(run10('cfCalibrationFileHtml("x.sql", [])')));
    });
    it('ownership tooltips answer what-to-do-next', () => {
      assert.ok(/open it there/.test(divHtml10()));
    });
    it('divergence mods resolve server-side and additively', () => {
      const srv10 = fs.readFileSync(path.join(PUB, '..', 'src', 'server.js'), 'utf8');
      assert.ok(/assumedFirstMods/.test(srv10) && /assumedSecondMods/.test(srv10)
        && /ComponentFiles/.test(srv10) && /fileClaimants/.test(srv10));
    });
  }
});

describe('Test 10 (headings): panel sub-heads sit one step below the 16px h2', () => {
  const css10b = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const html10b = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  it('a .panel h3 rule exists, smaller than the 16px h2', () => {
    const h3rule = /\.panel h3 \{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/.exec(css10b);
    assert.ok(!!h3rule && Number(h3rule[1]) < 16, h3rule ? `${h3rule[1]}px` : 'no rule');
  });
  it('the replay sub-heads stay h3 under the panel h2', () => {
    assert.ok(/<h2>DB collision replay/.test(html10b)
      && /<h3>Files the replay skipped or stopped on<\/h3>/.test(html10b)
      && /<h3>Log pairing report<\/h3>/.test(html10b));
  });
  it('the audited override sub-head stays h3 under the same rule', () => {
    assert.ok(/<h3>Where to put it<\/h3>/.test(html10b));
  });
});

describe('Test 11: assumed-setup verdicts read distinctly in the load-order list (game-setup 3.1)', () => {
  const loSrc11 = fs.readFileSync(path.join(PUB, 'loadorder.js'), 'utf8');
  const escStub11 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub11 = (s) => escStub11(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const dollarStub11 = () => ({ addEventListener() {} });
  let cx11 = null;
  let cxErr11 = '';
  try {
    cx11 = vm.createContext({ $: dollarStub11, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub11, renderCivText: renderStub11,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(loSrc11, cx11, { filename: 'loadorder.js' });
  } catch (e) { cxErr11 = e.message; }
  it('the load-order script loads headless under stubs', () => {
    assert.ok(cx11 !== null, cxErr11);
  });
  if (cx11) {
    const run11 = (expr) => vm.runInContext(expr, cx11);
    const measured11 = (over) => Object.assign({
      modId: null, modName: 'M', componentRowId: null, type: 'UpdateDatabase',
      override: null, state: 'author default', misspelled: false, protected: true,
      willRun: true, reason: null, unknown: [], assumed: false, inCompare: null,
    }, over);
    it('an assumed will-run row carries the marker', () => {
      const runHtml11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: true, assumed: true }))})`);
      assert.ok(/assumed setup/.test(runHtml11) && /lo-assumed/.test(runHtml11), runHtml11.slice(0, 200));
    });
    it('  with what-to-do-next wording, never a bare label', () => {
      const runHtml11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: true, assumed: true }))})`);
      assert.ok(/title="/.test(runHtml11) && /game-setup/.test(runHtml11), runHtml11.slice(0, 300));
    });
    it('an assumed not-run row carries the marker on its verdict line', () => {
      const offHtml11 = run11(`conditionLine(${JSON.stringify({ willRun: false, reason: 'needs X', assumed: true, unknown: [] })})`);
      assert.ok(/not run/.test(offHtml11) && /assumed setup/.test(offHtml11), offHtml11.slice(0, 200));
    });
    it('  exactly once per row', () => {
      const offRow11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: false, reason: 'needs X', assumed: true }))})`);
      assert.ok((offRow11.match(/assumed setup/g) || []).length === 1, offRow11.slice(0, 300));
    });
    it('measured rows carry no marker', () => {
      const measRun11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: true }))})`);
      const measOff11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: false, reason: 'needs X' }))})`);
      const measUnknown11 = run11(`conditionLine(${JSON.stringify({ willRun: null, reason: null, assumed: false, unknown: [{ why: 'needs X - undecidable here' }] })})`);
      assert.ok(!/assum/i.test(measRun11) && !/assum/i.test(measOff11) && !/assum/i.test(measUnknown11),
        `${measRun11.slice(0, 120)} / ${measOff11.slice(0, 120)}`);
    });
    it('  and the measured not-run wording is unchanged', () => {
      const measOff11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: false, reason: 'needs X' }))})`);
      assert.ok(/not run &mdash; needs X/.test(measOff11), measOff11.slice(0, 200));
    });
  }
});

describe('Test 12: packaging findings and zero-rows display wiring', () => {
  const cfSrc12 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub12 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub12 = (s) => escStub12(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els12 = {};
  const dollarStub12 = (id) => {
    if (!els12[id]) els12[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els12[id];
  };
  let cx12 = null;
  let cxErr12 = '';
  try {
    cx12 = vm.createContext({ $: dollarStub12, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub12, renderCivText: renderStub12,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc12, cx12, { filename: 'conflicts.js' });
  } catch (e) { cxErr12 = e.message; }
  it('the conflicts script loads headless under stubs', () => {
    assert.ok(cx12 !== null, cxErr12);
  });
  if (cx12) {
    const run12 = (expr) => vm.runInContext(expr, cx12);
    it('files no action loads name the mod display name, never the id', () => {
      const unreg = run12('cfPackagingUnregHtml({ kind: "unregistered-file", modId: "guid-unreg-1", name: "[COLOR_GREEN]Green Mod[ENDCOLOR]", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it, so it never reaches the game" })');
      assert.ok(/Green Mod/.test(unreg) && !/guid-unreg-1/.test(unreg) && !/\[COLOR/i.test(unreg), unreg.slice(0, 200));
    });
    it('  with the plain-words reason and a what-to-do-next hint', () => {
      const unreg = run12('cfPackagingUnregHtml({ kind: "unregistered-file", modId: "guid-unreg-1", name: "[COLOR_GREEN]Green Mod[ENDCOLOR]", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it, so it never reaches the game" })');
      assert.ok(/never reaches the game/.test(unreg) && /title="/.test(unreg) && /Add it to an action/.test(unreg));
    });
    it('  the unlisted variant points at the mod listing, not an action', () => {
      const unlisted = run12('cfPackagingUnregHtml({ kind: "unregistered-file", modId: "guid-unreg-2", name: "Disk Mod", file: "Data/Orphan.sql", reason: "sits in the mod folder but the mod does not list it, so no action can load it" })');
      assert.ok(/List it in the mod/.test(unlisted) && !/Add it to an action/.test(unlisted));
    });
    it('shared-id rows name every claimant folder with no raw ids or markup', () => {
      const dup = run12('cfPackagingDupHtml({ kind: "duplicate-mod-id", modId: "guid-dup-1", key: "guid-dup-1", claimants: [{ modId: "guid-dup-1", name: "[COLOR_BLUE]Dupe One[ENDCOLOR]", folder: "/mods/Alpha" }, { modId: "guid-dup-1", name: "Dupe Two", folder: "/mods/Beta" }], reason: "is claimed by more than one mod folder, so the game cannot tell them apart" })');
      assert.ok(/Dupe One/.test(dup) && /Dupe Two/.test(dup) && /\/mods\/Alpha/.test(dup) && /\/mods\/Beta/.test(dup)
        && !/guid-dup-1/.test(dup) && !/\[COLOR/i.test(dup));
    });
    it('  with a give-one-a-different-id hint', () => {
      const dup = run12('cfPackagingDupHtml({ kind: "duplicate-mod-id", modId: "guid-dup-1", key: "guid-dup-1", claimants: [{ modId: "guid-dup-1", name: "[COLOR_BLUE]Dupe One[ENDCOLOR]", folder: "/mods/Alpha" }, { modId: "guid-dup-1", name: "Dupe Two", folder: "/mods/Beta" }], reason: "is claimed by more than one mod folder, so the game cannot tell them apart" })');
      assert.ok(/different ModId/.test(dup));
    });
    it('tables in the wrong database name the mod, file, table and expected database', () => {
      const schema = run12('cfPackagingSchemaHtml({ kind: "schema-mismatch", modId: "guid-schema-1", name: "[COLOR_GREEN]Green Mod[ENDCOLOR]", file: "Data/Units.sql", table: "Units", side: "gameplay", expectedDb: "front-end", reason: "touches table Units, which lives in the front-end database, but the file loads in a gameplay action" })');
      assert.ok(/Green Mod/.test(schema) && /Data\/Units\.sql/.test(schema) && /table Units/.test(schema) && /front-end database/.test(schema)
        && !/guid-schema-1/.test(schema) && !/\[COLOR/i.test(schema), schema.slice(0, 220));
    });
    it('  with the plain-words reason and a what-to-do-next hint', () => {
      const schema = run12('cfPackagingSchemaHtml({ kind: "schema-mismatch", modId: "guid-schema-1", name: "[COLOR_GREEN]Green Mod[ENDCOLOR]", file: "Data/Units.sql", table: "Units", side: "gameplay", expectedDb: "front-end", reason: "touches table Units, which lives in the front-end database, but the file loads in a gameplay action" })');
      assert.ok(/lives in the front-end database/.test(schema) && /title="/.test(schema) && /Move the file into a front-end action/.test(schema));
    });
    it('zero-rows rows name the mod and file with the statement number', () => {
      const zero = run12('cfZeroRowsHtml({ modId: "guid-zero-1", modName: "[COLOR_GREEN]Zero Mod[ENDCOLOR]", fileLabel: "Data/T.sql", stmtIndex: 3, verb: "UPDATE" })');
      assert.ok(/Zero Mod/.test(zero) && /Data\/T\.sql/.test(zero) && /#3/.test(zero)
        && !/guid-zero-1/.test(zero) && !/\[COLOR/i.test(zero), zero.slice(0, 200));
    });
    it('  in plain words with a what-to-do-next hint, never backend jargon', () => {
      const zero = run12('cfZeroRowsHtml({ modId: "guid-zero-1", modName: "[COLOR_GREEN]Zero Mod[ENDCOLOR]", fileLabel: "Data/T.sql", stmtIndex: 3, verb: "UPDATE" })');
      assert.ok(/matched no rows/.test(zero) && /open the file/.test(zero) && /title="/.test(zero)
        && !/replay-relative/.test(zero));
    });
    // Panel renders are set per it (not once): each it must pass standalone
    // under --test-name-pattern filtering; the render is deterministic.
    const PACK2 = '{ ok: true, warnings: ['
      + '{ kind: "unregistered-file", modId: "guid-u", name: "Green Mod", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it" },'
      + '{ kind: "duplicate-mod-id", modId: "guid-d", key: "k", claimants: [{ modId: "guid-d", name: "Dupe One", folder: "A" }, { modId: "guid-d", name: "Dupe Two", folder: "B" }], reason: "claimed by more than one" }'
      + '] }';
    const renderPackaging12 = (payload) => { run12(`cfState.packaging = ${payload}`); run12('cfRenderPackaging()'); return els12.cfPackagingList.innerHTML; };
    it('both groups render with their rows', () => {
      const packHtml = renderPackaging12(PACK2);
      assert.ok(/Files no action loads/.test(packHtml)
        && /Mods sharing one id/.test(packHtml) && /Green Mod/.test(packHtml) && /Dupe Two/.test(packHtml),
        packHtml.slice(0, 200));
    });
    it('  and no raw mod ids leak anywhere in the panel', () => {
      const packHtml = renderPackaging12(PACK2);
      assert.ok(!/guid-u|guid-d/.test(packHtml));
    });
    const PACK3 = '{ ok: true, warnings: ['
      + '{ kind: "unregistered-file", modId: "guid-u", name: "Green Mod", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it" },'
      + '{ kind: "schema-mismatch", modId: "guid-s", name: "Schema Mod", file: "Data/X.sql", table: "T", side: "gameplay", expectedDb: "front-end", reason: "touches table T, which lives in the front-end database" },'
      + '{ kind: "duplicate-mod-id", modId: "guid-d", key: "k", claimants: [{ modId: "guid-d", name: "Dupe One", folder: "A" }, { modId: "guid-d", name: "Dupe Two", folder: "B" }], reason: "claimed by more than one" }'
      + '] }';
    it('the schema-mismatch group renders with its rows and no raw ids', () => {
      const packSchemaHtml = renderPackaging12(PACK3);
      assert.ok(/Tables in the wrong database/.test(packSchemaHtml)
        && /Schema Mod/.test(packSchemaHtml) && /Data\/X\.sql/.test(packSchemaHtml)
        && /front-end database/.test(packSchemaHtml) && !/guid-s/.test(packSchemaHtml),
        packSchemaHtml.slice(0, 220));
    });
    it('  and the header count includes the schema rows', () => {
      renderPackaging12(PACK3);
      assert.equal(els12.cfPackagingCount.textContent, '3', els12.cfPackagingCount.textContent);
    });
    it('quiet groups keep their empty state beside a firing one', () => {
      run12('cfState.packaging = { ok: true, warnings: [{ kind: "unregistered-file", modId: "guid-u", name: "Green Mod", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it" }] }');
      run12('cfRenderPackaging()');
      assert.ok(/Green Mod/.test(els12.cfPackagingList.innerHTML)
        && /Every database file loads on one side only/.test(els12.cfPackagingList.innerHTML)
        && /Every mod id belongs to exactly one mod folder/.test(els12.cfPackagingList.innerHTML)
        && /Every table lives where its file loads/.test(els12.cfPackagingList.innerHTML));
    });
    it('a clean library states so, never a blank hole', () => {
      run12('cfState.packaging = { ok: true, warnings: [] }');
      run12('cfRenderPackaging()');
      assert.ok(/Packaging looks clean/.test(els12.cfPackagingList.innerHTML), els12.cfPackagingList.innerHTML.slice(0, 160));
    });
    it('replay rows carry the zero-rows section with display names', () => {
      run12('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"zeroRows":[{"modId":"guid-zero-9","modName":"[COLOR_GREEN]Zero Nine[ENDCOLOR]","fileLabel":"Data/Z.sql","stmtIndex":7,"verb":"DELETE"}],"differential":{"available":false,"reason":"no log"}}');
      run12('cfRenderReplay()');
      assert.ok(/Zero Nine/.test(els12.cfReplayZeroRows.innerHTML) && /Data\/Z\.sql/.test(els12.cfReplayZeroRows.innerHTML)
        && !/guid-zero-9/.test(els12.cfReplayZeroRows.innerHTML) && !/\[COLOR/i.test(els12.cfReplayZeroRows.innerHTML),
        els12.cfReplayZeroRows.innerHTML.slice(0, 200));
    });
    it('a replay with no zero-rows states so, never a blank hole', () => {
      run12('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":false,"reason":"no log"}}');
      run12('cfRenderReplay()');
      assert.ok(/matched at least one row/.test(els12.cfReplayZeroRows.innerHTML));
    });
    it('the packaging route is a read-only GET reusing the backend', () => {
      const srv12 = fs.readFileSync(path.join(PUB, '..', 'src', 'server.js'), 'utf8');
      assert.ok(/req\.method === 'GET' && url\.pathname === '\/api\/conflicts\/packaging'/.test(srv12)
        && /packaging\.collectPackagingWarnings/.test(srv12)
        && /loOrder\.openDb/.test(srv12));
    });
    it('zeroRows rides the replay response additively with display names', () => {
      const srv12 = fs.readFileSync(path.join(PUB, '..', 'src', 'server.js'), 'utf8');
      assert.ok(/zeroRows: withModDisplayNames\(report\.zeroRows/.test(srv12));
    });
    it('the conflicts page gains a packaging panel with its controls', () => {
      const html12 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
      assert.ok(/id="cfRunPackaging"/.test(html12) && /id="cfPackagingList"/.test(html12) && /id="cfPackagingCount"/.test(html12));
    });
    it('zero-rows rows live inside the replay panel, never a new tab', () => {
      const html12 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
      assert.ok(/id="cfReplayZeroRows"/.test(html12) && /Statements that changed nothing/.test(html12)
        && !/data-nav="packaging"/.test(html12));
    });
  }
});

describe('Test 13: packaging groups window large result sets', () => {
  const cfSrc13 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub13 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub13 = (s) => escStub13(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els13 = {};
  const dollarStub13 = (id) => {
    if (!els13[id]) els13[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els13[id];
  };
  let cx13 = null;
  let cxErr13 = '';
  try {
    cx13 = vm.createContext({ $: dollarStub13, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub13, renderCivText: renderStub13,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc13, cx13, { filename: 'conflicts.js' });
  } catch (e) { cxErr13 = e.message; }
  it('the conflicts script loads headless under stubs', () => {
    assert.ok(cx13 !== null, cxErr13);
  });
  if (cx13) {
    const run13 = (expr) => vm.runInContext(expr, cx13);
    const PACK250 = '{ ok: true, warnings: Array.from({ length: 250 }, function (_, i) { return { kind: "unregistered-file", modId: "guid-u" + i, name: "Mod " + i, file: "Data/Extra" + i + ".sql", reason: "listed by the mod but no action loads it" }; }) }';
    // Full toggle sequences run per it (not once): each it must pass
    // standalone under --test-name-pattern filtering.
    const capped13 = () => {
      run13('cfState.packagingExpanded = {}');
      run13(`cfState.packaging = ${PACK250}`);
      run13('cfRenderPackaging()');
      return els13.cfPackagingList.innerHTML;
    };
    it('one group renders at most a hundred rows', () => {
      assert.equal(run13('cfPackagingWindow'), 100, String(run13('cfPackagingWindow')));
    });
    it('a 250-row group renders capped with the full count in its header', () => {
      const html = capped13();
      const rows13 = (html.match(/Data\/Extra\d+\.sql/g) || []).length;
      assert.ok(rows13 === 100 && />250</.test(html) && /Files no action loads/.test(html),
        rows13 + ' rows, header ' + (/>250</.test(html) ? 'exact' : 'wrong'));
    });
    it('  with an expand control naming the hidden remainder', () => {
      const html = capped13();
      assert.ok(/and 150 more/.test(html) && /show all/.test(html));
    });
    it('expanding shows every row with a way back', () => {
      capped13();
      run13('cfTogglePackagingGroup("unreg")');
      const open13 = els13.cfPackagingList.innerHTML;
      assert.ok((open13.match(/Data\/Extra\d+\.sql/g) || []).length === 250 && /show less/.test(open13));
    });
    it('collapsing caps the rows again with the count intact', () => {
      capped13();
      run13('cfTogglePackagingGroup("unreg")');
      run13('cfTogglePackagingGroup("unreg")');
      const shut13 = els13.cfPackagingList.innerHTML;
      assert.ok((shut13.match(/Data\/Extra\d+\.sql/g) || []).length === 100 && />250</.test(shut13));
    });
  }
});

describe('Test 14: conflicts copy triage (words only, no behavior change)', () => {
  const cfSrc14 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const html14 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  it('no never-on-page-load reassurance remains in conflicts strings', () => {
    assert.ok(!/never on page load/.test(cfSrc14) && !/never on page load/.test(html14));
  });
  it('no switched-off-cannot restatement remains in conflicts strings', () => {
    assert.ok(!/switched off, they cannot/.test(cfSrc14) && !/switched off, they cannot/.test(html14));
  });
  it('page hint triages cross-mod collisions and game-logged errors first', () => {
    assert.ok(/Start with cross-mod collisions and game-logged errors/.test(html14));
  });
  it('  and names shadowing no-winner rows as choices, not crashes', () => {
    assert.ok(/shadowing rows with no winner are choices to pin down, not crashes/.test(html14));
  });
  it('shadowing env names settled winners and choices that do not crash', () => {
    assert.ok(/rows with a winner are settled/.test(cfSrc14) && /choices to pin down or accept/.test(cfSrc14)
      && /nothing here crashes/.test(cfSrc14));
  });
  it('replay env triages cross-mod first with a coverage note', () => {
    assert.ok(/cross-mod pairs first/.test(cfSrc14) && /same-mod pairs are one author/.test(cfSrc14)
      && /did not cover/.test(cfSrc14));
  });
  it('packaging env and button triage never-loaded files and shared ids', () => {
    assert.ok(/never loads and mods sharing one id first/.test(cfSrc14)
      && /Find files the game never loads, tables in the wrong database, and ids two mods share/.test(html14)
      && /run this after adding or updating mods/.test(html14));
  });
});

describe('Test 14 (pairing guidance): the pairing section renders headless with next-step markup', () => {
  const cfSrc14b = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub14 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub14 = (s) => escStub14(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els14 = {};
  const dollarStub14 = (id) => {
    if (!els14[id]) els14[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els14[id];
  };
  let cx14 = null;
  let cxErr14 = '';
  try {
    cx14 = vm.createContext({ $: dollarStub14, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub14, renderCivText: renderStub14,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc14b, cx14, { filename: 'conflicts.js' });
  } catch (e) { cxErr14 = e.message; }
  it('the conflicts script loads headless under stubs', () => {
    assert.ok(cx14 !== null, cxErr14);
  });
  if (cx14) {
    const run14 = (expr) => vm.runInContext(expr, cx14);
    const REPLAY14 = '{"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":true,"agreements":[{"responsibleModId":"m1","responsibleModName":"Green Mod","fileLabel":"A.xml","stmtIndex":0,"logLine":10,"logText":"boom","replayError":"boom","strength":"context-proven","approximate":false,"attribution":{}}],"replayOnly":[{"responsibleModId":"m2","responsibleModName":"Plain Mod","fileLabel":"B.sql","stmtIndex":1,"replayError":"no such table: Nope","strength":"replay","approximate":false}],"logOnly":[{"responsibleModId":null,"responsibleModName":null,"fileLabel":"C.xml","stmtIndex":null,"logLine":20,"logText":"lost","strength":"hint-matched","approximate":false,"attribution":{}}]},"calibration":{"available":true,"divergences":[{"assumedFirst":"m/a.sql","assumedSecond":"m/b.sql","assumedOrder":"m/a.sql before m/b.sql (assumed replay order)","observedOrder":"m/b.sql before m/a.sql (game-observed order)","assumedFirstMods":[],"assumedSecondMods":[]}]}}';
    const rendered14 = () => {
      run14('cfState.diffFilter = ""; cfState.hideUnattributed = false');
      run14(`cfState.replay = ${REPLAY14}`);
      run14('cfRenderReplay()');
      return { diffHtml14: els14.cfReplayDiff.innerHTML, envHtml14: els14.cfReplayEnv.innerHTML };
    };
    it('pairing section opens with game-log-first guidance and a next-step title', () => {
      const { diffHtml14 } = rendered14();
      assert.ok(/Start with game-logged errors/.test(diffHtml14) && /actually broke something/.test(diffHtml14)
        && /title="[^"]*Fix game-log rows/.test(diffHtml14), diffHtml14.slice(0, 200));
    });
    it('  where both sides agree reads as fix-first', () => {
      const { diffHtml14 } = rendered14();
      assert.ok(/Where both sides agree, fix first/.test(diffHtml14));
    });
    it('agree rows say start here, single-side rows read as leads vs breakage', () => {
      const { diffHtml14 } = rendered14();
      assert.ok(/Both sides report this — start here/.test(diffHtml14) && /a lead to check/.test(diffHtml14)
        && /it actually broke something/.test(diffHtml14));
    });
    it('calibration divergences carry what-to-do-next guidance', () => {
      const { diffHtml14 } = rendered14();
      assert.ok(/title="[^"]*open the named files/.test(diffHtml14) && /Open the named files and check the order/.test(diffHtml14));
    });
    it('replay env triages cross-mod first with the coverage note', () => {
      const { envHtml14 } = rendered14();
      assert.ok(/cross-mod pairs first/.test(envHtml14) && /did not cover/.test(envHtml14), envHtml14.slice(0, 200));
    });
  }
});
