'use strict';

// Phase 9 automated proof wrapper (conflict-replay): the library lives in
// ./conflict-replay (required by both this wrapper and src/server.js); this
// file keeps the 9-flag CLI dispatch. See src/conflict-replay.js.
const conflictReplay = require('./conflict-replay');

module.exports = conflictReplay;


if (require.main === module) {
  const arg = process.argv[2];
  if (!arg || arg === '--check') {
    const ok = conflictReplay.runCheck();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--fidelity') {
    const ok = conflictReplay.runFidelity();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--gates') {
    const ok = conflictReplay.runGates();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--provenance') {
    const ok = conflictReplay.runProvenance();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--differential') {
    const ok = conflictReplay.runDifferential();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--envelope') {
    const ok = conflictReplay.runEnvelope();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--live-lock') {
    const ok = conflictReplay.runLiveLock();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--assumed-gates') {
    const ok = conflictReplay.runAssumedGates();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--text-tables') {
    const ok = conflictReplay.runTextTables();
    process.exit(ok ? 0 : 1);
  }
  console.error(`unknown flag ${arg}; usage: node src/phase9-conflict-replay.js [--check|--fidelity|--gates|--provenance|--differential|--envelope|--live-lock|--assumed-gates|--text-tables]`);
  process.exit(2);
}
