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

console.log(`\n${'='.repeat(60)}`);
console.log(pass ? 'SCRIPTS: ALL CHECKS PASSED' : 'SCRIPTS: FAILURES PRESENT');
console.log('='.repeat(60));
process.exit(pass ? 0 : 1);
