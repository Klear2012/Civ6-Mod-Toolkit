'use strict';

// Phase 8 automated proof: the browser page's scripts, checked the way a browser
// loads them.
//
// The bug this exists for: clicking the fourth tab returned to the first. The
// router was fine. The cause was in the console -
//
//   Uncaught SyntaxError: Identifier 'esc' has already been declared
//     loadorder.js:1
//   Uncaught SyntaxError: Identifier 'esc' has already been declared
//     looverrides.js:1
//
// Classic <script> tags share ONE global scope, so `const esc` at the top level of
// two files is a SyntaxError, and the browser discards BOTH files rather than the
// second one. Neither `pages['load-order']` nor `pages['load-overrides']` was ever
// registered, so parseRoute's fallback sent the user to the dashboard - and the
// whole override-management surface was unreachable, not merely misrouted.
//
// The existing per-file `node --check` in the release workflow cannot see this by
// construction: each file is valid on its own, and the error only exists in the
// combination. So this checks the combination, which is what a browser does.
//
// It also checks the other half, which is what turned a syntax error into a dead
// feature: every route the navigation offers must be registered by some script.
// A nav link to a page nothing registers fails silently and looks like a router
// bug.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// CIV6_PUBLIC_DIR points the suite at a scratch copy of public/, so the mod-name
// gate below can be shown failing on a planted leak without touching the tree.
const PUB = process.env.CIV6_PUBLIC_DIR || path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};

const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

console.log('Test 1: every script index.html loads exists, and every one it ships is loaded');
{
  const onDisk = fs.readdirSync(PUB).filter((f) => f.endsWith('.js')).sort();
  check('index.html loads at least the shared app and one page',
    scriptSrcs.includes('app.js') && scriptSrcs.length >= 4, scriptSrcs.join(', '));
  for (const s of scriptSrcs) {
    check(`  ${s} exists`, fs.existsSync(path.join(PUB, s)));
  }
  // A file on disk that nothing loads is dead weight, and the usual way a helper
  // ends up duplicated into a file that IS loaded.
  const orphans = onDisk.filter((f) => !scriptSrcs.includes(f));
  check('  and no script on disk is left unloaded', orphans.length === 0, orphans.join(', '));
}

console.log('\nTest 2: every script parses on its own');
{
  for (const s of scriptSrcs) {
    let ok = true;
    let err = '';
    try { new vm.Script(fs.readFileSync(path.join(PUB, s), 'utf8'), { filename: s }); }
    catch (e) { ok = false; err = e.message; }
    check(`  ${s}`, ok, err);
  }
}

console.log('\nTest 3: they parse together, as one program - which is how a browser reads them');
{
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
    // Say which file, so a failure names a file rather than an offset.
    const m = (e.stack || '').match(/public-concatenated\.js:(\d+)/);
    if (m) {
      const upto = all.split('\n').slice(0, Number(m[1])).join('\n');
      const at = upto.lastIndexOf('// ==== ');
      where = upto.slice(at + 8, upto.indexOf('\n', at));
    }
  }
  check('the scripts index.html loads, concatenated, parse as one program', ok, ok ? `${scriptSrcs.length} files` : `${err}${where ? ` (in ${where})` : ''}`);
}

console.log('\nTest 4: no top-level name is declared twice across those scripts');
{
  // Column 0 is a sound test for "top level" in this codebase's style: a
  // declaration inside a function or block is always indented.
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
  check('no top-level name is declared in two of them', dupes.length === 0,
    dupes.map(([n, v]) => `${n} in ${v.join(' and ')}`).join('; '));
  // Worth saying how many were found, so a pass is not mistaken for "found none
  // because the scan matched nothing".
  check('  and the scan found the declarations to compare', owners.size >= 20, `${owners.size} top-level names`);
}

console.log('\nTest 5: every route the navigation offers is registered by some script');
{
  // This is the half that turned a syntax error into a dead feature. The router
  // falls back to the dashboard for an unknown name, so a nav link to a page
  // nothing registers looks exactly like a router bug - which is how this was
  // misdiagnosed before the console was read.
  const navs = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);
  check('the navigation offers at least the four pages', navs.length >= 4, navs.join(', '));
  const all = scriptSrcs.map((s) => fs.readFileSync(path.join(PUB, s), 'utf8')).join('\n');
  for (const n of navs) {
    const re = new RegExp(`pages\\s*(?:\\[['"]${n}['"]\\]|\\.${n}\\s*=|\\[['"]${n}['"]\\]\\s*=)`);
    check(`  #/${n} is registered`, re.test(all));
  }
  // And the reverse: a page registered but not reachable from the navigation is
  // not a bug - the override management screen is deliberately not a nav item, and
  // the plan says so. Recorded as an observation, not a requirement.
  const registered = [...all.matchAll(/pages\s*(?:\[['"]([a-z-]+)['"]\]|\.([A-Za-z_$][\w$]*))\s*=/g)]
    .map((m) => m[1] || m[2]);
  const unreachable = [...new Set(registered)].filter((n) => !navs.includes(n));
  console.log(`  note: ${[...new Set(registered)].length} pages registered, ${navs.length} in the navigation`);
  console.log(`        reachable only by link: ${unreachable.join(', ') || 'none'}`);
}

console.log('\nTest 6: mod names render in page HTML and strip in dialogs/options');
{
  // Convention (mod-name-display): a mod name can carry Civ markup
  // ([COLOR_...]...[ENDCOLOR]) that only renders through renderCivText. Page
  // HTML must render it; <option> text and native confirm()/prompt() dialogs
  // must strip it with stripCivText. A bare esc() leaks literal bracket tags.
  // A mod-name-shaped expression is the modName property or .name on a
  // mod-ish receiver (m/o/a). Group, config, label and file names (g.name,
  // c.name, file.name) are not mod names and keep using esc(). A line that
  // already renders or strips is fine (config.js renders the name and escapes
  // the id on one line).
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
  check('no template escapes a mod name instead of rendering it', bad.length === 0, bad.join('; '));
  // The fixed dialog sites build their strings away from the confirm()/prompt()
  // call, so the line scan above cannot see them: assert they still strip.
  const lov = fs.readFileSync(path.join(PUB, 'looverrides.js'), 'utf8');
  const pro = fs.readFileSync(path.join(PUB, 'profiles.js'), 'utf8');
  const cfg = fs.readFileSync(path.join(PUB, 'config.js'), 'utf8');
  const mod = fs.readFileSync(path.join(PUB, 'mods.js'), 'utf8');
  const lord = fs.readFileSync(path.join(PUB, 'loadorder.js'), 'utf8');
  check('  the override prompt still strips the mod name', /stripCivText\(o\.modName\)/.test(lov));
  check('  the profile switch preview still strips mod names',
    /stripCivText\(\(all\.get\(id\)/.test(pro) && /stripCivText\(m\.name\)/.test(pro));
  check('  the config delete confirm still strips the name', /stripCivText\(name\)/.test(cfg));
  // Both build their strings away from the toast()/confirm() call, so the
  // line scan above cannot see them either: the import-skipped names travel
  // as the `names`/`shown` aliases into the toast detail (innerHTML), and
  // the remove-mod `what` travels into confirm(). A generic alias pattern
  // is disproportionate - `names` also holds label names that keep esc()
  // (mods.js label chips, label-edit dialog) - so pin the fixed sites.
  check('  the import-skipped toast detail still renders mod names',
    /names\.slice\(0,\s*5\)\.map\(renderCivText\)/.test(pro));
  check('  the remove-mod confirm still strips the mod name', /stripCivText\(m\.name\)/.test(mod));
  check('  condition reason/why text renders civ markup',
    /renderCivText\(a\.reason\)/.test(lord) && /renderCivText\(a\.unknown\[0\]\.why\)/.test(lord));
  // And the scan is not vacuous: the convention helpers are actually in use.
  const uses = scriptSrcs.map((s) => fs.readFileSync(path.join(PUB, s), 'utf8'))
    .join('\n').match(/(?:render|strip)CivText\(/g) || [];
  check('  and the scan saw the helpers in use', uses.length >= 10, `${uses.length} render/strip call sites`);
}

console.log('\nTest 7: differential attribution renders (log-pairing 3.1)');
{
  // Whole-file load like phase7 Tests 16b/18: the real conflicts.js render
  // path under stubs. Stubs mirror the app.js contract (esc escapes HTML,
  // renderCivText drops [...] markup), so a bare esc() around a mod name
  // would leak literal bracket tags and fail the naming check below.
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
  check('the conflicts script loads headless under stubs', cx !== null, cxErr);
  if (cx) {
    const run = (expr) => vm.runInContext(expr, cx);
    const named = run('cfResponsibleHtml({ responsibleModId: "m1", responsibleModName: "[COLOR_GREEN]Green Mod[ENDCOLOR]" })');
    check('an attributed row names the mod', /Green Mod/.test(named), named);
    check('  with no literal bracket tags', !/\[COLOR/i.test(named) && !/ENDCOLOR/i.test(named), named);
    const tCtx = run('cfStrengthTag({ responsibleModId: "m1", strength: "context-proven", approximate: false })');
    const tHint = run('cfStrengthTag({ responsibleModId: "m1", strength: "hint-matched", approximate: false })');
    const tBra = run('cfStrengthTag({ responsibleModId: "m3", strength: "bracket-approximate", approximate: true })');
    check('attributed strength renders in plain words', /traced to this mod/.test(tCtx), tCtx);
    check('hint strength renders in plain words', /matched by file name/.test(tHint), tHint);
    check('best-guess renders with the approximate marker',
      /best guess/.test(tBra) && /approximate/.test(tBra), tBra);
    check('replay strength renders in plain words',
      /found by replay/.test(run('cfStrengthTag({ responsibleModId: "m2", strength: "replay" })')));
    check('unattributed rows never carry an attributing label',
      /no mod named/.test(run('cfStrengthTag({ strength: "context-proven" })'))
      && !/traced to this mod/.test(run('cfStrengthTag({ strength: "context-proven" })'))
      && !/matched by file name/.test(run('cfStrengthTag({ strength: "hint-matched" })')));
    const amb = run('cfAttributionNote({ responsibleModId: null, attribution: { kind: "bracket-ambiguous", candidates: [{ path: "a", attribution: { modName: "Cand A" } }, { path: "b", attribution: { modName: "Cand B" } }] } })');
    check('same-ms ambiguity lists candidates instead of picking',
      /Cand A/.test(amb) && /Cand B/.test(amb) && /could be/.test(amb), amb);
    const unResp = run('cfResponsibleHtml({})');
    const unTag = run('cfStrengthTag({ strength: "unattributed" })');
    const unNote = run('cfAttributionNote({ responsibleModId: null, attribution: { kind: "unattributed", reason: "no-loading-precedes" } })');
    check('an unattributed row states so in plain words', /Mod unknown/.test(unResp) && /no mod named/.test(unTag), `${unResp} / ${unTag}`);
    check('  with the reason stated in plain words, never dropped', /nothing was loading/.test(unNote), unNote);
    run('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":true,"agreements":[{"responsibleModId":"m1","responsibleModName":"[COLOR_GREEN]Green Mod[ENDCOLOR]","fileLabel":"Data.xml","stmtIndex":0,"logLine":10,"logText":"boom","strength":"context-proven","approximate":false,"attribution":{}}],"replayOnly":[{"responsibleModId":"m2","responsibleModName":"Plain Mod","fileLabel":"B.sql","stmtIndex":1,"replayError":"fail","strength":"replay","approximate":false}],"logOnly":[{"responsibleModId":null,"fileLabel":"C.xml","stmtIndex":null,"logLine":20,"logText":"lost","strength":"hint-matched","approximate":false,"attribution":{}},{"responsibleModId":"m3","responsibleModName":"Bracket Mod","fileLabel":"D.xml","stmtIndex":null,"logLine":21,"logText":"b","strength":"bracket-approximate","approximate":true,"attribution":{}},{"responsibleModId":null,"fileLabel":"(no file hint)","stmtIndex":null,"logLine":22,"logText":"u","strength":"bracket-approximate","approximate":true,"attribution":{"kind":"bracket-ambiguous","candidates":[{"path":"a","attribution":{"modName":"Cand A"}},{"path":"b","attribution":{"modName":"Cand B"}}]}},{"responsibleModId":null,"fileLabel":"(no file hint)","stmtIndex":null,"logLine":23,"logText":"v","strength":"unattributed","approximate":true,"attribution":{"kind":"unattributed","reason":"no-loading-precedes"}}]}}');
    run('cfRenderReplay()');
    const diffHtml = els.cfReplayDiff.innerHTML;
    check('the differential names the mod with no literal bracket tags',
      /Green Mod/.test(diffHtml) && !/\[COLOR/i.test(diffHtml), diffHtml.slice(0, 200));
    check('  plain-language strengths render in place, never raw backend labels',
      /traced to this mod/.test(diffHtml) && /no mod named/.test(diffHtml) && /best guess/.test(diffHtml)
      && /found by replay/.test(diffHtml) && /several possible/.test(diffHtml)
      && !/context-proven|hint-matched|bracket-approximate|named by replay/.test(diffHtml));
    check('  the approximate marker and candidate list render',
      /approximate/.test(diffHtml) && /Cand A/.test(diffHtml) && /Cand B/.test(diffHtml));
    check('  the unattributed row states so with its reason in plain words',
      /Mod unknown/.test(diffHtml) && /nothing was loading/.test(diffHtml));
  }
}

console.log('\nTest 8: differential grouped by mod, searchable, hideable (log-pairing follow-up)');
{
  // Same stubbed-DOM harness as Test 7: the grouping, search, and toggle
  // helpers run headless against the real conflicts.js render path.
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
  check('the conflicts script loads headless under stubs', cx8 !== null, cxErr8);
  if (cx8) {
    const run8 = (expr) => vm.runInContext(expr, cx8);
    run8('cfState.diffFilter = ""; cfState.hideUnattributed = false');
    run8('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":1,"collisions":[],"gatedOut":[{"modId":"guid-gated-999","modName":"Gated Mod","fileLabel":"g.sql","statements":1,"reason":"needs some-mod to be on in this profile"}],"gatedUnknown":[],"perFile":[],"differential":{"available":true,"agreements":[{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"A.xml","stmtIndex":0,"logLine":10,"logText":"UNIQUE constraint failed: T.Id","replayError":"UNIQUE constraint failed: T.Id","strength":"context-proven","approximate":false,"attribution":{}}],"replayOnly":[{"responsibleModId":"guid-bbb-222","responsibleModName":"Plain Mod","fileLabel":"B.sql","stmtIndex":1,"replayError":"no such table: Nope","strength":"replay","approximate":false}],"logOnly":[{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L1.xml","stmtIndex":null,"logLine":20,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L2.xml","stmtIndex":null,"logLine":21,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L3.xml","stmtIndex":null,"logLine":22,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":null,"responsibleModName":null,"fileLabel":"C.xml","stmtIndex":null,"logLine":23,"logText":"lost","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint","fileHint":"C.xml","reason":"file-hint-only"}}]}}');
    run8('cfRenderReplay()');
    const diffHtml8 = els8.cfReplayDiff.innerHTML;
    check('one group per responsible mod with per-mod counts',
      /Green Mod/.test(diffHtml8) && /2 findings/.test(diffHtml8) && /Plain Mod/.test(diffHtml8)
      && /Mod unknown/.test(diffHtml8), diffHtml8.slice(0, 300));
    check('same failure across three files reads as one finding',
      (diffHtml8.match(/no such table: Lang/g) || []).length === 1
      && /3 files, same error/.test(diffHtml8) && /L1\.xml/.test(diffHtml8) && /L3\.xml/.test(diffHtml8));
    check('attributed groups order before unattributed',
      diffHtml8.indexOf('Green Mod') < diffHtml8.indexOf('Plain Mod')
      && diffHtml8.indexOf('Plain Mod') < diffHtml8.indexOf('Mod unknown'));
    run8('cfState.hideUnattributed = true');
    run8('cfRenderDiff()');
    check('hide-unattributed drops the unnamed group with a hidden-count note',
      !/Mod unknown/.test(els8.cfReplayDiff.innerHTML) && /Green Mod/.test(els8.cfReplayDiff.innerHTML)
      && /1 unnamed finding hidden/.test(els8.cfDiffNote.textContent), els8.cfDiffNote.textContent);
    run8('cfState.hideUnattributed = false; cfState.diffFilter = "green mod"');
    run8('cfRenderDiff()');
    check('exact-match search shows only the named mod group',
      /Green Mod/.test(els8.cfReplayDiff.innerHTML) && !/Plain Mod/.test(els8.cfReplayDiff.innerHTML)
      && !/Mod unknown/.test(els8.cfReplayDiff.innerHTML)
      && /matching the filter/.test(els8.cfDiffNote.textContent), els8.cfDiffNote.textContent);
    run8('cfState.diffFilter = "no such mod"');
    run8('cfRenderDiff()');
    check('search with no exact match is an explicit empty state',
      /No mod is named exactly that/.test(els8.cfReplayDiff.innerHTML));
    run8('cfState.diffFilter = ""');
    run8('cfRenderDiff()');
    const fullHtml8 = els8.cfReplayDiff.innerHTML;
    const gatedHtml8 = els8.cfReplayGated.innerHTML;
    check('differential rows never show raw mod ids',
      !/guid-aaa-111|guid-bbb-222/.test(fullHtml8), fullHtml8.slice(0, 200));
    check('gated-out rows name the mod display name, not the id',
      /Gated Mod/.test(gatedHtml8) && !/guid-gated-999/.test(gatedHtml8)
      && /not run/.test(gatedHtml8), gatedHtml8.slice(0, 200));
    const unSection8 = fullHtml8.slice(fullHtml8.indexOf('Mod unknown'));
    check('no contradictory labels on unattributed rows',
      !/traced to this mod|best guess|found by replay/.test(unSection8)
      && /no mod named/.test(unSection8));
    check('tooltips answer what-to-do-next',
      /title="/.test(fullHtml8) && /open the file/.test(fullHtml8));
    check('attributed file-name matches render in plain words',
      /matched by file name/.test(fullHtml8));
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(pass ? 'SCRIPTS: ALL CHECKS PASSED' : 'SCRIPTS: FAILURES PRESENT');
console.log('='.repeat(60));
process.exit(pass ? 0 : 1);
