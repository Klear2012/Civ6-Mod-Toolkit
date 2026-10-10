# Module `conflict-replay.js` — conflict-replay library

What it is: the extracted replay engine — temp-copy lifecycle, ordered replay
with per-file abort emulation, preprocessing stages, criteria gating,
provenance, `Database.log` differential, envelope, live-lock trial, assumed
gates, and text-table replay. Who calls it: `src/server.js` (the live report
path). See
`adr/ADR-009-extract-conflict-replay-library.md` and
`adr/ADR-001-disposable-copy-replay.md`.

## Reference (exported surface, grouped)

| Group | Functions | Role |
|---|---|---|
| Temp lifecycle | `createTempCopy`, `destroyTempCopy`, `assertTempPath` | Scratch copy under the OS temp dir; writes outside it refused |
| Decoding | `decodeModSql`, `readModFile` | UTF-16 via BOM plus null-byte heuristic; UTF-8 passes through |
| Splitting | `splitStatements`, `splitStatementsTriggerAware`, `splitterFlags` | Semicolon splitting outside strings/comments; trigger-aware edition |
| Gates | `normGateId`, `gateContextOf`, `gateSetupKeysFor`, `gateIsAsserted`, `gateAssumedMatch`, `evalGateCondition`, `evaluateGate` | Criteria gating and assumed setup |
| Provenance | `ensureProvenanceSchema`, `installProvenanceTriggers`, `setProvenanceWriter`, `readProvenanceWrites` | Winner/loser attribution per contested row and column |
| Collisions | `fileLimitationFlags`, `buildCollisions`, `formatCollision`, `leadingVerb`, `formatZeroRows` | Per-file collision report |
| Log differential | `parseDatabaseLog`, `resolveLogSourceMod`, `attributeLogSources`, `parseLogTimestampMs`, `parseModdingLog`, `normalizeDbMessage`, `dbMessagesMatch`, `collectReplayErrors`, `differentialValidate`, `formatDifferential`, `differentialFixtureLog`, `assertDifferential`, `buildCrashVicinity`, `isBenignLogError` | Where the replay and the game agree, and where each saw what the other missed |
| Envelope | `REPLAY_ENVELOPE_REF`, `buildReplayEnvelope`, `formatReplayEnvelope`, `envelopeFixtureModSet` | Bounded replay envelope plus fixture |
| Text tables | `TEXT_TABLE_NAMES`, `TEXT_TABLE_COLUMNS`, `cleanSqlIdent`, `isTextTableName`, `textTableMiss`, `textColumnMiss`, `uniqueMissTable`, `textColumnFallback`, `textSchemaSql`, `createTextSchemaCopy` | Localisation-table handling |
| Replay | `stmtTargets`, `routeStatementTargets`, `preprocessFile`, `collectStatements`, `replayOrdered`, `holdLiveExclusiveForCopy`, `lockedCopyTrial` | Ordered statement replay; live-lock trial |

## How-to: run a replay

1. Copy the game database into a scratch dir (`createTempCopy`).
2. Collect each mod's statements in load order (`collectStatements`).
3. Replay them (`replayOrdered`) and read back provenance and collisions.
4. Destroy the scratch dir (`destroyTempCopy`).

## Crash vicinity and benign rows

The differential response carries `crashVicinity` (trailing-window groups, newest first) for the Conflicts page "near the crash" section, and benign game-own rows are tagged so the page can leave them out of the tallies while still listing them. Both reuse the same attribution the differential already serves.

## What it does not do

Never writes the live game database: replay opens a database for writing only
under the OS temp dir (`assertTempPath` fails closed otherwise — see
`adr/ADR-006-readonly-diagnostics.md`). Never invents a winner: an undecidable
contest reports honestly.

## Tests

Covered by `tests/conflict-replay.test.js` (9 suites; run: `node --test
tests/conflict-replay.test.js`) and the live selfcheck (`npm run
phase9-selfcheck`, i.e. `node src/server.js --selfcheck` — see
`server-selfcheck.md`). Shared Temp pattern: `tests/helpers.js`.
