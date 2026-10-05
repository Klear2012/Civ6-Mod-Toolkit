'use strict';

// Cleanliness gate: a release run must not litter the repo root with shell
// redirect accidents (C...opencode*.log, 0, nul, console.log(... fragments)
// or default-path store files (game-setup.json et al. belong to Temp overrides
// during tests, never to the repo). Fails loudly instead of silently piling up.

const { execFileSync } = require('child_process');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!cond) failures += 1;
};

let lines = [];
try {
  const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  lines = out.split(/\r?\n/).filter((l) => l);
} catch (e) {
  console.log(`  [FAIL] git status readable :: ${e.message}`);
  process.exit(1);
}

const junkName = (f) =>
  f === '0' || f === '0))' || f === '{' || f === 'nul' || f === 'NUL'
  || f.indexOf('opencodecheck') !== -1 || f.indexOf('opencodep7') !== -1
  || f.indexOf('opencodeverify') !== -1
  || /^console\.log/.test(f) || /^l\.includes/.test(f);
const storeName = (f) =>
  f === 'game-setup.json' || f === 'load-order-overrides.json' || f === 'mod-labels.json';

const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());
const junk = untracked.filter(junkName);
const stores = untracked.filter(storeName);
check('no redirect-accident files in repo root', junk.length === 0, JSON.stringify(junk));
check('no default-path store files in repo root', stores.length === 0, JSON.stringify(stores));

if (failures > 0) {
  console.log('\nCLEANLINESS: FAILURES PRESENT');
  process.exit(1);
}
console.log('\nCLEANLINESS: ALL CHECKS PASSED');
