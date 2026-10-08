'use strict';

// Architecture guard: the src/ module graph must stay acyclic.
//
// Every server split (gates, loadorder-fit, loadorder-store, conflict-replay,
// server-selfcheck) moves code OUT of a facade into a new leaf. The failure
// mode is a back-edge (leaf requiring its facade, directly or transitively),
// which turns a load-time require into a half-initialized-exports bug. This
// test fails on any require cycle among src/*.js, including lazily deferred
// require() calls inside functions (they still cycle at runtime).

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function localDepsOf(file, knownFiles) {
  const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  const deps = new Set();
  let m;
  while ((m = REQUIRE_RE.exec(src)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
    let base = path.basename(spec);
    if (!base.endsWith('.js')) base += '.js';
    if (knownFiles.has(base) && base !== file) deps.add(base);
  }
  return [...deps].sort();
}

function findCycle(files, edges) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(files.map((f) => [f, WHITE]));
  let cycle = null;
  function visit(node, stack) {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of edges.get(node) || []) {
      if (cycle) return true;
      if (color.get(dep) === GRAY) {
        cycle = stack.slice(stack.indexOf(dep)).concat(dep);
        return true;
      }
      if (color.get(dep) === WHITE && visit(dep, stack)) return true;
    }
    stack.pop();
    color.set(node, BLACK);
    return false;
  }
  for (const f of files) {
    if (color.get(f) === WHITE && visit(f, [])) break;
  }
  return cycle;
}

describe('architecture', () => {
  it('has no require cycles among src/*.js', () => {
    const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0, 'expected src/*.js files to exist');
    const known = new Set(files);
    const edges = new Map(files.map((f) => [f, localDepsOf(f, known)]));
    const cycle = findCycle(files, edges);
    assert.strictEqual(cycle, null, `require cycle: ${(cycle || []).join(' -> ')}`);
  });
});
