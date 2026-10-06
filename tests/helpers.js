'use strict';

// Shared seam for node:test mirrors.
//
// Later waves (phase5 labels, phase4 profiles, phase7/9 DB suites) extend
// this file with synthetic-DB DDL; this pilot needs only the Temp pattern
// and thin assert wrappers. Zero dependencies beyond the Node standard
// library, CommonJS like the rest of the repo.
//
// The Temp pattern is deliberate: on Windows a runner's TEMP can sit under
// an 8.3 short name (e.g. RUNNER~1), so the scratch root is canonicalised
// once via realpathSync.native — the same lesson that blocked v1.5.0
// (see adr/ADR-007-use-node-test-for-phase-mirror.md). Every path below is then already in the
// canonical form by construction.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync.native(dir);
}

module.exports = { makeTmp, assert };
