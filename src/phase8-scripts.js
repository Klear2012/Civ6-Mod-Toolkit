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

const PUB = path.join(__dirname, '..', 'public');
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

console.log(`\n${'='.repeat(60)}`);
console.log(pass ? 'SCRIPTS: ALL CHECKS PASSED' : 'SCRIPTS: FAILURES PRESENT');
console.log('='.repeat(60));
process.exit(pass ? 0 : 1);
