'use strict';

// tests/conflict-replay.test.js — node:test mirror of the conflict-replay
// library (src/conflict-replay.js; 10 suites, 267 executed checks).
//
// Record-then-replay (Wave 3 phase4 pattern): node:test runs every describe
// body before any it(), so the scratch-DB flows CANNOT live in describe
// bodies. All 9 suites are synchronous, so they run here at file top level in
// exact source order with check() recording (label, truthiness, diagnostic);
// the describe/it tree at the bottom only replays the recordings and mutates
// nothing, so every --test-name-pattern slice passes standalone. Library
// calls go through the extracted src/conflict-replay.js (also proving the
// wave4 lib split); only each suite's flow + locals are transcribed verbatim.
//
// Scratch discipline: every suite builds its own scratch dir via
// fs.realpathSync.native + os.tmpdir(); the live game DB is never named.
// Cut over in cutover-gate-to-node-test: the wrapper is deleted and this file
// (via src/conflict-replay.js) is authoritative.

const { describe, it } = require('node:test');
const { assert } = require('./helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const iconv = require('iconv-lite');
const cr = require('../src/conflict-replay');

const suites = [];
let current = null;
const check = (label, cond, extra = '') => {
  current.recs.push({ label, cond: !!cond, extra: String(extra == null ? '' : extra) });
};
const suite = (name, fn) => {
  const s = { name, recs: [] };
  suites.push(s);
  const prev = current;
  current = s;
  try { fn(); } finally { current = prev; }
};
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

// ---- suite: --check (task 1.1) ----

suite('--check', () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-check-')));

  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec(`CREATE TABLE ReplayCheck(Id TEXT PRIMARY KEY, Value INTEGER);
        INSERT INTO ReplayCheck VALUES('base', 0);`);
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);
  const beforeMtime = fs.statSync(sourceDbPath).mtimeMs;

  const utf16 = (text, be = false) => {
    const body = be ? iconv.encode(text, 'utf16-be') : iconv.encode(text, 'utf16-le');
    return Buffer.concat([Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]), body]);
  };
  const file1 = path.join(scratch, 'mod-a-part1.sql');
  const file2 = path.join(scratch, 'mod-a-part2.sql');
  const file3 = path.join(scratch, 'mod-b-part1.sql');
  fs.writeFileSync(file1, utf16(`UPDATE ReplayCheck SET Value = 1 WHERE Id = 'base';\nINSERT INTO ReplayCheck VALUES('a1', 11);\n`));
  fs.writeFileSync(file2, utf16(`INSERT INTO ReplayCheck VALUES('a2', 22);\nINSERT INTO NoSuchTable VALUES(1);\n`));
  fs.writeFileSync(file3, utf16(`INSERT INTO ReplayCheck VALUES('b1', 33);\n`, true));

  const { tmpDir, tempDbPath } = cr.createTempCopy(sourceDbPath);

  const collected = cr.collectStatements([
    { modId: 'mod-a', files: [{ label: 'part1.sql', filePath: file1 }, { label: 'part2.sql', filePath: file2 }] },
    { modId: 'mod-b', files: [{ label: 'part1.sql', filePath: file3 }] },
  ]);
  check('5 statements collected across 3 files in order', collected.total === 5, `got ${collected.total}`);
  check('per-file counts are 2/2/1', collected.files.map((f) => f.statements.length).join('/') === '2/2/1',
    collected.files.map((f) => `${f.fileLabel}:${f.statements.length}`).join(', '));
  check('UTF-16LE files decoded as utf16', collected.files[0].encoding.startsWith('utf16') && collected.files[1].encoding.startsWith('utf16'),
    `${collected.files[0].encoding}, ${collected.files[1].encoding}`);
  check('UTF-16BE file decoded as utf16', collected.files[2].encoding.startsWith('utf16'),
    collected.files[2].encoding);
  check('global order follows mod -> file -> statement',
    collected.ordered.map((s) => `${s.modId}/${s.fileLabel}#${s.stmtIndex}`).join(' ') ===
    'mod-a/part1.sql#0 mod-a/part1.sql#1 mod-a/part2.sql#0 mod-a/part2.sql#1 mod-b/part1.sql#0');

  const report = cr.replayOrdered(tempDbPath, collected);
  check('failing file aborted', report.perFile[1].status === 'aborted');
  check('abort names the failing statement index', report.perFile[1].failedAt === 3, `got ${report.perFile[1].failedAt}`);
  check('healthy files committed', report.perFile[0].status === 'committed' && report.perFile[2].status === 'committed');

  const readTemp = (sql, ...args) => {
    const db = new DatabaseSync(tempDbPath, { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  };
  const rows = Object.fromEntries(readTemp('SELECT Id, Value FROM ReplayCheck').map((r) => [r.Id, r.Value]));
  check('earlier file persists (base updated, a1 present)', rows.base === 1 && rows.a1 === 11, JSON.stringify(rows));
  check('failing file rolled back (a2 absent)', !('a2' in rows), JSON.stringify(rows));
  check('later file still applied (b1 present)', rows.b1 === 33, JSON.stringify(rows));

  check('temp copy lives under the OS temp dir', tempDbPath.startsWith(fs.realpathSync.native(os.tmpdir())));
  check('temp copy is not the source path', tempDbPath !== sourceDbPath);
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);
  check('source mtime unchanged', fs.statSync(sourceDbPath).mtimeMs === beforeMtime);
  const liveRows = (() => {
    const db = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id, Value FROM ReplayCheck').all(); } finally { db.close(); }
  })();
  check('source holds only its seed row', liveRows.length === 1 && liveRows[0].Value === 0, JSON.stringify(liveRows));
  const probePath = path.join(__dirname, '..', 'conflict-replay-refuse-probe.sqlite');
  let refused = false;
  try {
    cr.replayOrdered(probePath, { ordered: [], files: [], total: 0 });
  } catch (_) { refused = true; }
  check('replay refuses a database outside the temp dir', refused && !fs.existsSync(probePath));

  const lockSource = path.join(scratch, 'DebugGameplayLock.sqlite');
  {
    const seed = new DatabaseSync(lockSource);
    try {
      seed.exec('CREATE TABLE LockCheck(Id TEXT PRIMARY KEY, Value INTEGER);'
        + "INSERT INTO LockCheck VALUES('base', 0);");
    } finally {
      seed.close();
    }
  }
  const lockSet = [
    { modId: 'mod-a', files: [{ label: 'ok.sql', text: "INSERT INTO LockCheck VALUES('ok', 1);" }] },
    { modId: 'mod-b', files: [{ label: 'bad.sql', text: 'INSERT INTO NoSuchLock VALUES(1);' }] },
  ];
  const trial = cr.lockedCopyTrial(lockSource, lockSet);
  check('temp copy + replay succeed while the live DB is locked',
    !trial.copyError && !!trial.locked,
    trial.copyError ? String((trial.copyError && trial.copyError.message) || trial.copyError)
      : `executed=${trial.locked && trial.locked.executed}`);
  check('locked report matches the unlocked baseline',
    !!trial.locked && JSON.stringify(trial.locked) === JSON.stringify(trial.baseline),
    trial.locked ? `locked=${trial.locked.statuses.join(' ')} baseline=${trial.baseline.statuses.join(' ')}`
      : 'no locked report');
  check('live file byte-identical afterwards', trial.liveAfter === trial.liveBefore);
  const lockLiveRows = (() => {
    const db = new DatabaseSync(lockSource, { readOnly: true });
    try { return db.prepare('SELECT Id FROM LockCheck').all(); } finally { db.close(); }
  })();
  check('live DB holds only its seed row', lockLiveRows.length === 1 && lockLiveRows[0].Id === 'base',
    JSON.stringify(lockLiveRows));

  cr.destroyTempCopy(tmpDir);
  check('temp copy cleaned up', !fs.existsSync(tempDbPath));
  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});

// ---- suite: --fidelity (task 1.2) ----

suite('--fidelity', () => {
  const flagLine = (s) => `  [${s.stage}] outcome=${s.outcome}` + Object.entries(s)
    .filter(([k]) => k !== 'stage' && k !== 'outcome')
    .map(([k, v]) => ` ${k}=${Array.isArray(v) ? v.join(',') : (v && typeof v === 'object' ? JSON.stringify(v) : v)}`)
    .join('');

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-fidelity-')));
  const makeSource = (name, seedSql) => {
    const p = path.join(scratch, name);
    const db = new DatabaseSync(p);
    try { db.exec(seedSql); } finally { db.close(); }
    return p;
  };
  const readOne = (dbPath, sql) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(sql).get(); } finally { db.close(); }
  };
  const readAll = (dbPath, sql) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  const asCollected = (statements, label = 'fixture.sql') => ({
    ordered: [],
    files: [{ modId: 'm', fileLabel: label, statements, baseGlobalIndex: 0 }],
    total: statements.length,
  });

  const trigSql = [
    'CREATE TABLE TrigT(Id INTEGER PRIMARY KEY, V INTEGER);',
    'CREATE TRIGGER trg_after AFTER INSERT ON TrigT BEGIN',
    '  UPDATE TrigT SET V = 1 WHERE Id = NEW.Id;',
    '  DELETE FROM TrigT WHERE V = 0;',
    'END;',
    "INSERT INTO TrigT VALUES(10, 0);",
  ].join('\n');
  const sf = cr.splitterFlags(trigSql);
  check('naive splitter fractures the trigger body', sf.naive === 5, `got naive=${sf.naive}`);
  check('trigger-aware splitter keeps the trigger whole', sf.aware === 3, `got aware=${sf.aware}`);
  check('splitter flag reports transformed', sf.outcome === 'transformed');
  const plainSf = cr.splitterFlags("INSERT INTO T VALUES(1);\nINSERT INTO T VALUES(2);");
  check('plain SQL reports skipped:identical', plainSf.outcome === 'skipped:identical');
  const src1 = makeSource('t1.sqlite', 'CREATE TABLE _Seed(Id INTEGER);');
  const aware = cr.splitStatementsTriggerAware(trigSql);
  const c1 = cr.createTempCopy(src1);
  const rep1 = cr.replayOrdered(c1.tempDbPath, asCollected(aware, 'trig.sql'));
  check('kept-whole trigger file commits', rep1.perFile[0].status === 'committed', rep1.perFile[0].status);
  const fired = (() => {
    const db = new DatabaseSync(c1.tempDbPath);
    try {
      db.exec('INSERT INTO TrigT VALUES(20, 0);');
      return db.prepare('SELECT V FROM TrigT WHERE Id = 20').get().V;
    } finally { db.close(); }
  })();
  check('replayed trigger fires (V set to 1)', fired === 1, `got ${fired}`);
  cr.destroyTempCopy(c1.tmpDir);

  const dqVal = cr.rewriteDoubleQuotes('INSERT INTO DQ2 VALUES("lit1", "lit2");');
  check('value-position literals rewritten', dqVal.outcome === 'transformed' && dqVal.rewritten === 2,
    `rewritten=${dqVal.rewritten}`);
  check('rewrite emits single-quoted SQL', dqVal.text === "INSERT INTO DQ2 VALUES('lit1', 'lit2');", dqVal.text);
  const dqDdl = cr.rewriteDoubleQuotes('CREATE TABLE "Hmm"("C" TEXT);');
  check('quoted identifiers kept verbatim', dqDdl.outcome === 'skipped' && dqDdl.kept === 2,
    `rewritten=${dqDdl.rewritten} kept=${dqDdl.kept}`);
  check('DDL text untouched', dqDdl.text === 'CREATE TABLE "Hmm"("C" TEXT);', dqDdl.text);
  const src2 = makeSource('t2.sqlite', 'CREATE TABLE DQ2(A TEXT, B TEXT);');
  const c2 = cr.createTempCopy(src2);
  const rep2 = cr.replayOrdered(c2.tempDbPath, asCollected([dqVal.text], 'dq.sql'));
  check('rewritten statement executes', rep2.perFile[0].status === 'committed');
  check('rewritten row lands', readOne(c2.tempDbPath, "SELECT A FROM DQ2 WHERE B = 'lit2'").A === 'lit1');
  cr.destroyTempCopy(c2.tmpDir);

  const mhStmts = [
    'CREATE TABLE MH(Id TEXT PRIMARY KEY, H INTEGER);',
    "INSERT INTO MH VALUES('a', Make_Hash('abc'));",
  ];
  check('Make_Hash call detected', cr.needsMakeHash(mhStmts) === true);
  check('plain SQL needs no stub', cr.needsMakeHash(['SELECT 1;']) === false);
  const src3 = makeSource('t3.sqlite', 'CREATE TABLE _Seed(Id INTEGER);');
  const c3a = cr.createTempCopy(src3);
  const repNo = cr.replayOrdered(c3a.tempDbPath, asCollected(mhStmts, 'mh.sql'), { installStubs: false });
  check('without stub the file aborts', repNo.perFile[0].status === 'aborted' && repNo.makeHashStub === 'skipped');
  cr.destroyTempCopy(c3a.tmpDir);
  const c3b = cr.createTempCopy(src3);
  const repYes = cr.replayOrdered(c3b.tempDbPath, asCollected(mhStmts, 'mh.sql'), { installStubs: true });
  check('with stub the file commits', repYes.perFile[0].status === 'committed' && repYes.makeHashStub === 'installed');
  const hVal = readOne(c3b.tempDbPath, "SELECT H FROM MH WHERE Id = 'a'").H;
  check('stub value is the declared deterministic placeholder', hVal === cr.fnv1a32('abc'), `got ${hVal}`);
  cr.destroyTempCopy(c3b.tmpDir);

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<GameData>',
    '  <Traits>',
    '    <Row TraitType="TRAIT_A" Name="Alpha" Cost="100"/>',
    '    <Replace TraitType="TRAIT_B" Name="Beta"/>',
    '    <InsertOrIgnore TraitType="TRAIT_C" Name="Gamma"/>',
    '    <Update><Where TraitType="TRAIT_A"/><Set Name="Alpha2"/></Update>',
    '    <Delete TraitType="TRAIT_B"/>',
    '  </Traits>',
    "  <Sql>UPDATE Traits SET Cost = 0 WHERE TraitType = 'TRAIT_C';</Sql>",
    '</GameData>',
  ].join('\n');
  const conv = cr.convertXmlToSql(xml);
  check('five ops converted plus one raw chunk', conv.statements.length === 5 && conv.rawChunks.length === 1,
    `statements=${conv.statements.length} raw=${conv.rawChunks.length}`);
  check('op counts cover all five forms',
    conv.flags.opCounts.Row === 1 && conv.flags.opCounts.Replace === 1
    && conv.flags.opCounts.InsertOrIgnore === 1 && conv.flags.opCounts.Update === 1
    && conv.flags.opCounts.Delete === 1,
    JSON.stringify(conv.flags.opCounts));
  check('table named', conv.flags.tables.join(',') === 'Traits', conv.flags.tables.join(','));
  const notXml = cr.convertXmlToSql('INSERT INTO T VALUES(1);');
  check('non-XML input skipped as not-xml', notXml.flags.outcome === 'skipped' && notXml.flags.reason === 'not-xml');
  const src4 = makeSource('t4.sqlite',
    'CREATE TABLE Traits(TraitType TEXT PRIMARY KEY, Name TEXT, Cost INTEGER);' +
    "INSERT INTO Traits VALUES('TRAIT_B', 'Old', 5);");
  const c4 = cr.createTempCopy(src4);
  const rep4 = cr.replayOrdered(c4.tempDbPath, asCollected(cr.splitStatementsTriggerAware(conv.sqlText), 'data.xml'));
  check('converted statements all commit', rep4.perFile[0].status === 'committed', rep4.perFile[0].status);
  const traits = Object.fromEntries(readAll(c4.tempDbPath, 'SELECT TraitType, Name, Cost FROM Traits')
    .map((r) => [r.TraitType, [r.Name, r.Cost]]));
  check('Row + Update applied (TRAIT_A renamed)', traits.TRAIT_A && traits.TRAIT_A[0] === 'Alpha2', JSON.stringify(traits));
  check('Delete applied (TRAIT_B gone)', !('TRAIT_B' in traits), JSON.stringify(traits));
  check('raw SQL applied (TRAIT_C cost zeroed)', traits.TRAIT_C && traits.TRAIT_C[1] === 0, JSON.stringify(traits));
  cr.destroyTempCopy(c4.tmpDir);

  const fkFile = ["INSERT INTO Child VALUES('c1', 'missing');"];
  const fkSeed = 'CREATE TABLE Parent(Id TEXT PRIMARY KEY);' +
    'CREATE TABLE Child(Id TEXT PRIMARY KEY, PId TEXT REFERENCES Parent(Id));' +
    "INSERT INTO Parent VALUES('p1');";
  const src5 = makeSource('t5.sqlite', fkSeed);
  const c5a = cr.createTempCopy(src5);
  const repOff = cr.replayOrdered(c5a.tempDbPath, asCollected(fkFile, 'fk.sql'), { foreignKeys: false });
  check('FK-OFF commits the orphan row', repOff.perFile[0].status === 'committed' && repOff.fkMode === 'OFF');
  cr.destroyTempCopy(c5a.tmpDir);
  const c5b = cr.createTempCopy(src5);
  const repOn = cr.replayOrdered(c5b.tempDbPath, asCollected(fkFile, 'fk.sql'), { foreignKeys: true });
  check('FK-ON aborts the orphan row', repOn.perFile[0].status === 'aborted' && repOn.fkMode === 'ON');
  cr.destroyTempCopy(c5b.tmpDir);

  const pipeSet = [
    {
      modId: 'mod-pipe',
      files: [
        {
          label: 'schema.sql',
          text: 'CREATE TABLE XOps(K TEXT PRIMARY KEY, V TEXT);\n'
            + 'CREATE TABLE DQ(Id INTEGER PRIMARY KEY, V TEXT);\n'
            + 'CREATE TABLE MH(Id TEXT PRIMARY KEY, H INTEGER);\n'
            + 'CREATE TABLE TrigT(Id INTEGER PRIMARY KEY, V INTEGER);',
        },
        {
          label: 'trig.sql',
          text: 'CREATE TRIGGER trg_after AFTER INSERT ON TrigT BEGIN\n'
            + '  UPDATE TrigT SET V = 1 WHERE Id = NEW.Id;\n'
            + 'END;\n'
            + 'INSERT INTO TrigT VALUES(1, 0);',
        },
        { label: 'dq.sql', text: 'INSERT INTO DQ VALUES(1, "hello");' },
        {
          label: 'data.xml',
          text: '<GameData><XOps><Row K="k1" V="v1"/></XOps>'
            + "<Sql>INSERT INTO XOps VALUES('raw', 'R');</Sql></GameData>",
        },
        { label: 'mh.sql', text: "INSERT INTO MH VALUES('a', Make_Hash('abc'));" },
      ],
    },
  ];
  const piped = cr.collectStatements(pipeSet, { preprocess: true });
  check('pipeline collects 10 statements', piped.total === 10, `got ${piped.total}`);
  const byLabel = Object.fromEntries(piped.files.map((f) => [f.fileLabel, f]));
  const stageOf = (label, stage) => byLabel[label].stages.find((s) => s.stage === stage).outcome;
  check('trig.sql splitter transformed', stageOf('trig.sql', 'splitter') === 'transformed');
  check('dq.sql rewrite transformed', stageOf('dq.sql', 'double-quote-rewrite') === 'transformed');
  check('data.xml converted', stageOf('data.xml', 'xml-to-sql') === 'transformed');
  check('mh.sql stub installed-at-replay', stageOf('mh.sql', 'make-hash-stub') === 'installed-at-replay');
  check('schema.sql all stages skipped',
    byLabel['schema.sql'].stages.every((s) => s.outcome.startsWith('skipped')));
  const src6 = makeSource('t6.sqlite', 'CREATE TABLE _Seed(Id INTEGER);');
  const c6 = cr.createTempCopy(src6);
  const rep6 = cr.replayOrdered(c6.tempDbPath, piped);
  check('pipeline replay commits every file',
    rep6.perFile.every((f) => f.status === 'committed'),
    rep6.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  check('pipeline replay executed all 10', rep6.executed === 10, `got ${rep6.executed}`);
  const fired6 = (() => {
    const db = new DatabaseSync(c6.tempDbPath);
    try {
      db.exec('INSERT INTO TrigT VALUES(99, 0);');
      return db.prepare('SELECT V FROM TrigT WHERE Id = 99').get().V;
    } finally { db.close(); }
  })();
  check('pipeline trigger fires', fired6 === 1, `got ${fired6}`);
  check('pipeline double-quoted row lands', readOne(c6.tempDbPath, 'SELECT V FROM DQ WHERE Id = 1').V === 'hello');
  check('pipeline XML rows land',
    readAll(c6.tempDbPath, 'SELECT K FROM XOps ORDER BY K').map((r) => r.K).join(',') === 'k1,raw');
  check('pipeline stub hash lands', readOne(c6.tempDbPath, "SELECT H FROM MH WHERE Id = 'a'").H === cr.fnv1a32('abc'));
  cr.destroyTempCopy(c6.tmpDir);

  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});

// ---- suite: --gates (task 1.3) ----

suite('--gates', () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-gates-')));
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec('CREATE TABLE GateCheck(Id TEXT PRIMARY KEY, Value INTEGER);'
        + "INSERT INTO GateCheck VALUES('base', 0);");
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);
  const beforeMtime = fs.statSync(sourceDbPath).mtimeMs;

  const ON_ID = 'mod-on-1111';
  const OFF_ID = 'mod-off-2222';
  const gatesCtx = { enabled: [ON_ID], installed: [ON_ID, OFF_ID] };
  const gateOn = { any: false, conditions: [{ type: 'ModInUse', value: ON_ID, inverse: false }] };
  const gateOff = { any: false, conditions: [{ type: 'ModInUse', value: OFF_ID, inverse: false }] };
  const modSet = [
    { modId: 'mod-on', files: [{ label: 'on.sql', text: "INSERT INTO GateCheck VALUES('on', 1);", gate: gateOn }] },
    { modId: 'mod-off', files: [{ label: 'off.sql', text: "INSERT INTO GateCheck VALUES('off', 2);", gate: gateOff }] },
  ];

  const vOn = cr.evaluateGate(gateOn, gatesCtx);
  const vOff = cr.evaluateGate(gateOff, gatesCtx);
  check('gated-in action will run', vOn.willRun === true, JSON.stringify(vOn));
  check('gated-out action will not run', vOff.willRun === false, JSON.stringify(vOff));
  check('gated-out reason names the missing mod state', /mod-off-2222 to be on in this profile/.test(vOff.reason || ''), vOff.reason);
  check('absent gate is ungated', cr.evaluateGate(null, gatesCtx).willRun === true);
  check('empty conditions are ungated', cr.evaluateGate({ any: false, conditions: [] }, gatesCtx).willRun === true);
  const vUnknown = cr.evaluateGate({ any: false, conditions: [{ type: 'RuleSetInUse', value: 'RULESET_EXPANSION_1' }] }, gatesCtx);
  check('unreadable type stays undecided with its reason',
    vUnknown.willRun === null && vUnknown.unknown.length === 1, JSON.stringify(vUnknown.unknown));
  check('inverted absence is satisfied',
    cr.evaluateGate({ conditions: [{ type: 'ModInUse', value: 'never-installed', inverse: true }] }, gatesCtx).willRun === true);
  check('ANY with one met condition runs',
    cr.evaluateGate({ any: true, conditions: [{ type: 'ModInUse', value: OFF_ID }, { type: 'ModInUse', value: ON_ID }] }, gatesCtx).willRun === true);
  check('AND with one unmet condition does not run',
    cr.evaluateGate({ conditions: [{ type: 'ModInUse', value: ON_ID }, { type: 'ModInUse', value: OFF_ID }] }, gatesCtx).willRun === false);

  const collected = cr.collectStatements(modSet);
  check('both files collected with one statement each',
    collected.total === 2 && collected.files.map((f) => f.statements.length).join('/') === '1/1',
    `total=${collected.total}`);
  check('gates ride along on the file entries',
    JSON.stringify(collected.files[0].gate) === JSON.stringify(gateOn)
    && JSON.stringify(collected.files[1].gate) === JSON.stringify(gateOff));

  const c1 = cr.createTempCopy(sourceDbPath);
  const report = cr.replayOrdered(c1.tempDbPath, collected, { gates: gatesCtx });
  check('gated-in file committed', report.perFile[0].status === 'committed');
  check('gated-out file skipped-gated, never replayed', report.perFile[1].status === 'skipped-gated');
  check('skipped file carries its reason',
    /mod-off-2222 to be on in this profile/.test((report.perFile[1].gate && report.perFile[1].gate.reason) || ''));
  check('report lists the gated-out write with reason',
    report.gatedOut.length === 1 && report.gatedOut[0].fileLabel === 'off.sql'
    && /mod-off-2222 to be on in this profile/.test(report.gatedOut[0].reason),
    JSON.stringify(report.gatedOut));
  check('executed counts only the gated-in statement', report.executed === 1 && report.skippedGated === 1,
    `executed=${report.executed} skippedGated=${report.skippedGated}`);
  const rows = (() => {
    const db = new DatabaseSync(c1.tempDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id FROM GateCheck').all().map((r) => r.Id).sort(); } finally { db.close(); }
  })();
  check('gated-in row landed', rows.includes('on'), rows.join(','));
  check('gated-out row never landed', !rows.includes('off'), rows.join(','));
  cr.destroyTempCopy(c1.tmpDir);

  const c2 = cr.createTempCopy(sourceDbPath);
  const plain = cr.replayOrdered(c2.tempDbPath, collected);
  check('both files commit without a gates context',
    plain.perFile.every((f) => f.status === 'committed') && plain.executed === 2,
    plain.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  cr.destroyTempCopy(c2.tmpDir);

  check('source content unchanged', sha256(sourceDbPath) === beforeHash);
  check('source mtime unchanged', fs.statSync(sourceDbPath).mtimeMs === beforeMtime);
  const liveRows = (() => {
    const db = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id FROM GateCheck').all(); } finally { db.close(); }
  })();
  check('source holds only its seed row', liveRows.length === 1 && liveRows[0].Id === 'base', JSON.stringify(liveRows));

  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});

// ---- suite: --provenance (task 2.1) ----

suite('--provenance', () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-prov-')));
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec('CREATE TABLE ProvCheck(Id TEXT PRIMARY KEY, Value INTEGER, Note TEXT);'
        + "INSERT INTO ProvCheck VALUES('hero', 0, 'seed');"
        + "INSERT INTO ProvCheck VALUES('twin', 0, 'seed');"
        + "INSERT INTO ProvCheck VALUES('solo', 0, 'seed');");
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);

  const modSet = [
    { modId: 'mod-a', files: [{ label: 'a.sql', text: "UPDATE ProvCheck SET Value = 1 WHERE Id = 'hero';" }] },
    {
      modId: 'mod-b',
      files: [{ label: 'b.sql', text: "UPDATE ProvCheck SET Value = 2 WHERE Id = 'hero';" }],
    },
  ];
  const twinSet = [
    { modId: 'mod-a', files: [{ label: 'a.sql', text: "UPDATE ProvCheck SET Value = 5 WHERE Id = 'twin';" }] },
    {
      modId: 'mod-b',
      files: [{ label: 'b.sql', text: "UPDATE ProvCheck SET Value = 5 WHERE Id = 'twin';" }],
    },
  ];
  const soloSet = [
    { modId: 'mod-a', files: [{ label: 'a.sql', text: "UPDATE ProvCheck SET Note = 'one' WHERE Id = 'solo';" }] },
    { modId: 'mod-b', files: [{ label: 'b.sql', text: "UPDATE ProvCheck SET Value = 9 WHERE Id = 'solo';" }] },
  ];

  const c1 = cr.createTempCopy(sourceDbPath);
  const collected = cr.collectStatements(modSet);
  const report = cr.replayOrdered(c1.tempDbPath, collected, { provenance: true });
  check('provenance recorded', !!report.provenance && report.provenance.writes.length >= 2,
    `writes=${report.provenance && report.provenance.writes.length}`);
  check('exactly one collision', report.provenance.collisions.length === 1,
    JSON.stringify(report.provenance.collisions.map(cr.formatCollision)));
  const col = report.provenance.collisions[0];
  check('collision names table, key, column',
    !!col && col.table === 'ProvCheck' && col.pk === 'hero' && col.column === 'Value',
    col ? `${col.table} pk=${col.pk} col=${col.column}` : 'no collision');
  check('winner is the later file in replay order',
    !!col && col.winner.modId === 'mod-b' && col.winner.fileLabel === 'b.sql'
    && col.winner.stmtIndex === 0 && col.winner.globalIndex === 1,
    col ? JSON.stringify(col.winner) : 'no collision');
  check('loser is the earlier file in replay order',
    !!col && col.losers.length === 1 && col.losers[0].modId === 'mod-a'
    && col.losers[0].fileLabel === 'a.sql' && col.losers[0].stmtIndex === 0
    && col.losers[0].globalIndex === 0,
    col ? JSON.stringify(col.losers) : 'no collision');
  check('loser precedes winner', !!col && col.losers[0].globalIndex < col.winner.globalIndex);
  const heroVal = (() => {
    const db = new DatabaseSync(c1.tempDbPath, { readOnly: true });
    try { return db.prepare("SELECT Value FROM ProvCheck WHERE Id = 'hero'").get().Value; }
    finally { db.close(); }
  })();
  check('replayed value matches the winner (last-writer-wins)', heroVal === 2, `got ${heroVal}`);
  cr.destroyTempCopy(c1.tmpDir);

  const c2 = cr.createTempCopy(sourceDbPath);
  const twinRep = cr.replayOrdered(c2.tempDbPath, cr.collectStatements(twinSet), { provenance: true });
  check('identical-value cell still collides', twinRep.provenance.collisions.length === 1,
    JSON.stringify(twinRep.provenance.collisions.map(cr.formatCollision)));
  const twin = twinRep.provenance.collisions[0];
  check('identical-value winner is still the later writer',
    !!twin && twin.winner.modId === 'mod-b' && twin.losers.length === 1
    && twin.losers[0].modId === 'mod-a');
  cr.destroyTempCopy(c2.tmpDir);

  const c3 = cr.createTempCopy(sourceDbPath);
  const soloRep = cr.replayOrdered(c3.tempDbPath, cr.collectStatements(soloSet), { provenance: true });
  check('disjoint cells produce no collisions', soloRep.provenance.collisions.length === 0,
    JSON.stringify(soloRep.provenance.collisions.map(cr.formatCollision)));
  cr.destroyTempCopy(c3.tmpDir);

  const c4 = cr.createTempCopy(sourceDbPath);
  const plain = cr.replayOrdered(c4.tempDbPath, collected);
  check('provenance off by default', plain.provenance === null);
  cr.destroyTempCopy(c4.tmpDir);
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);

  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});

/// Shared with the --differential suite (source assertDifferential, verbatim).
function assertDifferential(diff, check) {
  check('one agreement', diff.agreements.length === 1, `got ${diff.agreements.length}`);
  const agree = diff.agreements[0];
  check('agreement names file and statement',
    !!agree && agree.fileLabel === 'bad-a.sql' && agree.stmtIndex === 0,
    agree ? `${agree.fileLabel}#${agree.stmtIndex}` : 'no agreement');
  check('agreement names the matched log line',
    !!agree && agree.logLine === 1, agree ? `logLine=${agree && agree.logLine}` : 'no agreement');
  check('one replay-only divergence', diff.replayOnly.length === 1, `got ${diff.replayOnly.length}`);
  const ro = diff.replayOnly[0];
  check('replay-only names file, statement, and side',
    !!ro && ro.fileLabel === 'bad-b.sql' && ro.stmtIndex === 0 && ro.side === 'replay-only',
    ro ? `${ro.fileLabel}#${ro.stmtIndex} ${ro.side}` : 'none');
  check('one log-only divergence', diff.logOnly.length === 1, `got ${diff.logOnly.length}`);
  const lo = diff.logOnly[0];
  check('log-only names file, statement, and side',
    !!lo && lo.fileLabel === 'ghost.sql' && lo.stmtIndex === 3 && lo.side === 'log-only',
    lo ? `${lo.fileLabel}#${lo.stmtIndex} ${lo.side}` : 'none');
}

// ---- suite: --differential (task 2.2 + log-pairing 1.1/1.2/2.1/2.2) ----

suite('--differential', () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-diff-')));
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec("CREATE TABLE DiffCheck(Id TEXT PRIMARY KEY, V INTEGER);"
        + "INSERT INTO DiffCheck VALUES('seed', 0);");
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);

  const modSet = [
    {
      modId: 'mod-a',
      files: [
        { label: 'good.sql', text: "INSERT INTO DiffCheck VALUES('ok', 1);" },
        { label: 'bad-a.sql', text: 'INSERT INTO NoSuchAlpha VALUES(1);' },
      ],
    },
    { modId: 'mod-b', files: [{ label: 'bad-b.sql', text: 'INSERT INTO NoSuchBeta VALUES(1);' }] },
  ];
  const collected = cr.collectStatements(modSet);
  const c1 = cr.createTempCopy(sourceDbPath);
  const report = cr.replayOrdered(c1.tempDbPath, collected);
  check('both bad files aborted', report.perFile[1].status === 'aborted'
    && report.perFile[2].status === 'aborted',
  report.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));

  const logText = cr.differentialFixtureLog(report.perFile[1].error);
  const entries = cr.parseDatabaseLog(logText);
  check('parser keeps only ERROR lines', entries.length === 2, `got ${entries.length}`);

  const diff = cr.differentialValidate(report, entries, collected);
  assertDifferential(diff, check);

  const pairingLog = [
    "[200.001] [Gameplay] While executing - 'insert into Traits(TraitType, Name) values (?, ?)'",
    '[200.001] [Gameplay] In XMLSerializer while updating table Traits with values (TRAIT_PAIRED, Paired Trait)',
    '[200.001] [Gameplay] from file D:/SteamLibrary/steamapps/workshop/content/289070/1234567890/Data/PairedMod_Traits.xml',
    '[200.001] [Gameplay] ERROR: UNIQUE constraint failed: Traits.TraitType',
    '[200.002] [Gameplay] ERROR: no such table: NoSuchLone -- file: lone.sql statement 1',
  ].join('\n');
  const paired = cr.parseDatabaseLog(pairingLog);
  check('context fixture parses to both ERROR entries', paired.length === 2, `got ${paired.length}`);
  const ctx = paired[0];
  check('executing statement joined',
    ctx.statement === 'insert into Traits(TraitType, Name) values (?, ?)', String(ctx.statement));
  check('row values joined',
    ctx.values === '(TRAIT_PAIRED, Paired Trait)', String(ctx.values));
  check('workshop source path joined',
    ctx.sourcePath === 'D:/SteamLibrary/steamapps/workshop/content/289070/1234567890/Data/PairedMod_Traits.xml',
    String(ctx.sourcePath));
  check('workshop ID attributed', ctx.workshopId === '1234567890', String(ctx.workshopId));
  const lone = paired[1];
  check('single-line fallback keeps null context fields',
    lone.statement === null && lone.values === null && lone.sourcePath === null && lone.workshopId === null,
    JSON.stringify({
      statement: lone.statement,
      values: lone.values,
      sourcePath: lone.sourcePath,
      workshopId: lone.workshopId,
    }));
  check('fallback keeps file-hint and statement-hint',
    lone.fileHint === 'lone.sql' && lone.stmtHint === 1, `${lone.fileHint}#${lone.stmtHint}`);

  const folderMap = {
    workshop: { 1234567890: { modId: 'mod-paired', name: 'Paired Mod' } },
    local: [{ folder: 'MyLocalMod', modId: 'mod-local', name: 'Local Mod' }],
  };
  const mapLog = [
    '[300.001] [Gameplay] from file D:/SteamLibrary/steamapps/workshop/content/289070/1234567890/Data/PairedMod_Traits.xml',
    '[300.001] [Gameplay] ERROR: UNIQUE constraint failed: Traits.TraitType',
    "[300.002] [Gameplay] from file C:/Users/Test/Documents/My Games/Sid Meier's Civilization VI/Mods/MyLocalMod/Data/Local_Traits.xml",
    '[300.002] [Gameplay] ERROR: no such table: LocalTraits',
    "[300.003] [Gameplay] from file C:/Games/Sid Meier's Civilization VI/Base/Assets/Gameplay/Data/Base_Traits.xml",
    '[300.003] [Gameplay] ERROR: UNIQUE constraint failed: BaseTraits.Id',
    '[300.004] [Gameplay] from file D:/SteamLibrary/steamapps/workshop/content/289070/9999999999/Data/Stranger_Traits.xml',
    '[300.004] [Gameplay] ERROR: no such table: StrangerTraits',
  ].join('\n');
  const mapEntries = cr.parseDatabaseLog(mapLog);
  const mapped = cr.attributeLogSources(mapEntries, folderMap);
  check('mapping fixture parses to four ERROR entries', mapped.length === 4, `got ${mapped.length}`);
  check('mapper does not mutate its input',
    mapEntries.every((e) => e.attribution === undefined));
  check('every entry carries a stated attribution (none dropped)',
    mapped.every((e) => e.attribution && typeof e.attribution.kind === 'string'),
    JSON.stringify(mapped.map((e) => e.attribution && e.attribution.kind)));
  check('workshop path maps to its mod',
    mapped[0].attribution.kind === 'workshop' && mapped[0].attribution.modId === 'mod-paired',
    JSON.stringify(mapped[0].attribution));
  check('local path resolves by folder',
    mapped[1].attribution.kind === 'local' && mapped[1].attribution.modId === 'mod-local',
    JSON.stringify(mapped[1].attribution));
  check('base-game path attributes to the base game',
    mapped[2].attribution.kind === 'base-game' && mapped[2].attribution.modId === 'base-game',
    JSON.stringify(mapped[2].attribution));
  check('unknown workshop ID is stated, not dropped',
    mapped[3].attribution.kind === 'unmapped' && /9999999999/.test(mapped[3].attribution.reason || ''),
    JSON.stringify(mapped[3].attribution));
  const unmappedAll = cr.attributeLogSources(mapEntries, null);
  check('empty map leaves nothing unstated (base needs no map entry)',
    unmappedAll.every((e) => e.attribution && typeof e.attribution.kind === 'string')
    && unmappedAll[0].attribution.kind === 'unmapped'
    && unmappedAll[1].attribution.kind === 'unmapped'
    && unmappedAll[2].attribution.kind === 'base-game',
    JSON.stringify(unmappedAll.map((e) => e.attribution.kind)));

  const hintLog = '[400.001] [Gameplay] ERROR: no such table: NoSuchHinted -- file: hinted.sql statement 2';
  const hintEntries = cr.parseDatabaseLog(hintLog);
  check('hint-only fixture parses to one ERROR', hintEntries.length === 1, `got ${hintEntries.length}`);
  const hintE = hintEntries[0];
  check('hint-only keeps file-hint matching', hintE.fileHint === 'hinted.sql' && hintE.stmtHint === 2,
    `${hintE.fileHint}#${hintE.stmtHint}`);
  check('hint-only has no usable context', !cr.hasUsableDbContext(hintE),
    JSON.stringify({ statement: hintE.statement, sourcePath: hintE.sourcePath }));
  const hintFb = cr.attributeErrorWithFallback(hintE, [], folderMap);
  check('hint-only stays hint-matched, never bracketed',
    hintFb.strength === 'hint-matched' && hintFb.bracket === null && !hintFb.approximate,
    JSON.stringify(hintFb));

  const bracketMap = {
    workshop: { 1111111111: { modId: 'mod-alpha', name: 'Alpha Mod' },
      2222222222: { modId: 'mod-beta', name: 'Beta Mod' } },
    local: [],
  };
  const moddingSingle = [
    '[500.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_Units.xml',
    '[500.002] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/2222222222/Data/Beta_Units.xml',
    '[500.004] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_Late.xml',
  ].join('\n');
  const singleLoads = cr.parseModdingLog(moddingSingle);
  check('Modding.log parses three Loading lines', singleLoads.length === 3, `got ${singleLoads.length}`);
  check('non-Loading lines are ignored', cr.parseModdingLog('[500.000] [Modding] Idle').length === 0);
  const bareLog = '[500.003] [Gameplay] ERROR: no such table: NoSuchBare';
  const bareE = cr.parseDatabaseLog(bareLog)[0];
  check('no-context error has neither context nor hint',
    !cr.hasUsableDbContext(bareE) && !bareE.fileHint, JSON.stringify(bareE));
  const bareB = cr.bracketErrorWithLoading(bareE, singleLoads, bracketMap);
  check('nearest-preceding Loading brackets the error', bareB.outcome === 'bracketed'
    && /2222222222/.test(bareB.loadingPath || ''), JSON.stringify(bareB));
  check('bracketing is labeled approximate', bareB.approximate === true
    && bareB.strength === 'bracket-approximate', JSON.stringify(bareB));
  check('bracket resolves the loading mod', !!bareB.attribution
    && bareB.attribution.modId === 'mod-beta', JSON.stringify(bareB.attribution));
  const bareFb = cr.attributeErrorWithFallback(bareE, singleLoads, bracketMap);
  check('fallback labels no-context as bracket-approximate',
    bareFb.strength === 'bracket-approximate' && bareFb.approximate === true,
    JSON.stringify(bareFb));

  const moddingAmbig = [
    '[600.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Ambig_A.xml',
    '[600.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/2222222222/Data/Ambig_B.xml',
  ].join('\n');
  const ambigLoads = cr.parseModdingLog(moddingAmbig);
  const ambigE = cr.parseDatabaseLog('[600.002] [Gameplay] ERROR: no such table: NoSuchAmbig')[0];
  const ambigB = cr.bracketErrorWithLoading(ambigE, ambigLoads, bracketMap);
  check('same-ms yields candidates, not a single pick',
    ambigB.outcome === 'ambiguous' && (ambigB.candidates || []).length === 2
    && ambigB.loadingPath === null, JSON.stringify(ambigB));
  check('candidates are named with mods',
    ambigB.candidates.every((c) => !!c.path && !!c.attribution && !!c.attribution.modId),
    JSON.stringify((ambigB.candidates || []).map((c) => c.path)));
  check('ambiguity keeps the approximate label', ambigB.approximate === true
    && ambigB.strength === 'bracket-approximate' && ambigB.reason === 'same-ms-ambiguity');

  const lateLoads = cr.parseModdingLog('[700.005] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Late.xml');
  const earlyE = cr.parseDatabaseLog('[700.001] [Gameplay] ERROR: no such table: NoSuchEarly')[0];
  const earlyB = cr.bracketErrorWithLoading(earlyE, lateLoads, bracketMap);
  check('no preceding Loading is stated explicitly',
    earlyB.outcome === 'unbracketed' && earlyB.reason === 'no-loading-precedes',
    JSON.stringify(earlyB));
  const ctxFb = cr.attributeErrorWithFallback(ctx, singleLoads, folderMap);
  check('context-proven errors never fall through to bracketing',
    ctxFb.strength === 'context-proven' && ctxFb.bracket === null,
    JSON.stringify(ctxFb));

  const assumedFiles = [
    { modId: 'mod-alpha', fileLabel: 'Alpha_Units.xml' },
    { modId: 'mod-beta', fileLabel: 'Beta_Units.xml' },
  ];
  const calLoadings = cr.parseModdingLog([
    '[800.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/2222222222/Data/Beta_Units.xml',
    '[800.002] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_Units.xml',
  ].join('\n'));
  const seq = cr.gameLoadSequence(calLoadings);
  check('game load sequence follows Loading order',
    seq.map((s) => s.label).join(',') === 'Beta_Units.xml,Alpha_Units.xml',
    seq.map((s) => s.label).join(','));
  const calBefore = JSON.stringify(assumedFiles);
  const cal = cr.calibrateLoadOrder(assumedFiles, calLoadings);
  check('one inverted pair reported', cal.divergences.length === 1, `got ${cal.divergences.length}`);
  const inv = cal.divergences[0];
  check('inversion names which side each order came from',
    !!inv && /assumed replay order/.test(inv.assumedOrder || '')
    && /game-observed order/.test(inv.observedOrder || ''),
    inv ? `${inv.assumedOrder} vs ${inv.observedOrder}` : 'none');
  check('inversion names both files',
    !!inv && /Alpha_Units\.xml/.test(inv.assumedOrder || '')
    && /Beta_Units\.xml/.test(inv.observedOrder || ''),
    inv ? `${inv.assumedOrder} vs ${inv.observedOrder}` : 'none');
  check('calibration never reorders its inputs', JSON.stringify(assumedFiles) === calBefore);
  const calSame = cr.calibrateLoadOrder(assumedFiles, cr.parseModdingLog([
    '[801.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_Units.xml',
    '[801.002] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/2222222222/Data/Beta_Units.xml',
  ].join('\n')));
  check('matching order reports no divergences', calSame.divergences.length === 0,
    `got ${calSame.divergences.length}`);

  cr.destroyTempCopy(c1.tmpDir);
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);
  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});

// ---- suite: --envelope (task 2.3) ----

suite('--envelope', () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-env-')));
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  const seed = new DatabaseSync(sourceDbPath);
  try { seed.exec('CREATE TABLE EnvCheck(Id INTEGER PRIMARY KEY, V INTEGER);'); } finally { seed.close(); }
  const beforeHash = sha256(sourceDbPath);
  const collected = cr.collectStatements(cr.envelopeFixtureModSet());
  check('fixture holds the reference-scale statement count',
    collected.total === cr.REPLAY_ENVELOPE_REF.statements, `got ${collected.total}`);
  const c1 = cr.createTempCopy(sourceDbPath);
  const report = cr.replayOrdered(c1.tempDbPath, collected);
  const env = cr.buildReplayEnvelope(report);
  check('envelope reports the statement count', env.statements === cr.REPLAY_ENVELOPE_REF.statements);
  check('envelope reports wall-clock', typeof env.wallMs === 'number' && env.wallMs >= 0, `${env.wallMs}ms`);
  check('envelope reports execution rate', env.stmtsPerSec > 0, `${env.stmtsPerSec}/s`);
  check('at least 9 in 10 statements execute FK-off',
    env.executedFraction >= cr.REPLAY_ENVELOPE_REF.executedFraction,
    `executed ${env.executed}/${env.statements} = ${(env.executedFraction * 100).toFixed(1)}%`);
  check('executed-vs-skipped covers every statement',
    env.executed + env.skipped === env.statements, `executed=${env.executed} skipped=${env.skipped}`);
  check('replay stays interactive (same order as the ~2s reference)', env.wallMs < 30000, `${env.wallMs}ms`);
  const landed = (() => {
    const db = new DatabaseSync(c1.tempDbPath, { readOnly: true });
    try { return db.prepare('SELECT count(*) AS n FROM EnvCheck').get().n; } finally { db.close(); }
  })();
  check('replayed rows land in the temp copy', landed === cr.REPLAY_ENVELOPE_REF.statements, `got ${landed}`);
  cr.destroyTempCopy(c1.tmpDir);
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);

  const zeroSource = path.join(scratch, 'DebugGameplayZero.sqlite');
  {
    const zeroSeed = new DatabaseSync(zeroSource);
    try {
      zeroSeed.exec(`CREATE TABLE ZeroCheck(Id TEXT PRIMARY KEY, V INTEGER);
        INSERT INTO ZeroCheck VALUES('real', 1);`);
    } finally {
      zeroSeed.close();
    }
  }
  const zeroBefore = sha256(zeroSource);
  const zeroSet = [
    {
      modId: 'mod-zero',
      files: [
        {
          label: 'fix.sql',
          text: `-- retune one row, then one that names nothing
            UPDATE ZeroCheck SET V = 2 WHERE Id = 'real';
            UPDATE ZeroCheck SET V = 9 WHERE Id = 'ghost';`,
        },
        {
          label: 'prune.sql',
          text: `DELETE FROM ZeroCheck WHERE Id = 'ghost';
            INSERT INTO ZeroCheck VALUES('new', 3);`,
        },
      ],
    },
  ];
  const zeroCopy = cr.createTempCopy(zeroSource);
  const zeroRep = cr.replayOrdered(zeroCopy.tempDbPath, cr.collectStatements(zeroSet));
  check('both files stay committed (flagged, never an error)',
    zeroRep.perFile.every((f) => f.status === 'committed'),
    zeroRep.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  check('executed counts every statement', zeroRep.executed === 4, `got ${zeroRep.executed}`);
  check('exactly the two no-match statements flag',
    zeroRep.zeroRows.length === 2
    && zeroRep.zeroRows[0].verb === 'UPDATE' && zeroRep.zeroRows[0].fileLabel === 'fix.sql'
    && zeroRep.zeroRows[0].stmtIndex === 1 && zeroRep.zeroRows[0].globalIndex === 1
    && zeroRep.zeroRows[1].verb === 'DELETE' && zeroRep.zeroRows[1].fileLabel === 'prune.sql'
    && zeroRep.zeroRows[1].stmtIndex === 0 && zeroRep.zeroRows[1].globalIndex === 2,
    JSON.stringify(zeroRep.zeroRows.map((z) => `${z.verb} ${z.fileLabel}#${z.stmtIndex}`)));
  check('every finding carries the replay-relative fidelity flag',
    zeroRep.zeroRows.every((z) => z.fidelityLimited.includes('replay-relative')),
    JSON.stringify(zeroRep.zeroRows.map((z) => z.fidelityLimited)));
  check('per-file records carry their own statement indexes',
    JSON.stringify(zeroRep.perFile[0].zeroRows) === JSON.stringify([1])
    && JSON.stringify(zeroRep.perFile[1].zeroRows) === JSON.stringify([0]),
    JSON.stringify(zeroRep.perFile.map((f) => f.zeroRows)));
  check('the matching UPDATE and the INSERT stay unflagged',
    !zeroRep.zeroRows.some((z) => (z.fileLabel === 'fix.sql' && z.stmtIndex === 0)
      || (z.fileLabel === 'prune.sql' && z.stmtIndex === 1)));
  const zeroVal = (() => {
    const db = new DatabaseSync(zeroCopy.tempDbPath, { readOnly: true });
    try { return db.prepare("SELECT V FROM ZeroCheck WHERE Id = 'real'").get().V; } finally { db.close(); }
  })();
  check('the matching UPDATE still applied', zeroVal === 2, `got ${zeroVal}`);
  cr.destroyTempCopy(zeroCopy.tmpDir);
  check('zero-rows source content unchanged', sha256(zeroSource) === zeroBefore);

  const limSource = path.join(scratch, 'DebugGameplayLim.sqlite');
  {
    const limSeed = new DatabaseSync(limSource);
    try {
      limSeed.exec('CREATE TABLE LimT(K TEXT PRIMARY KEY, V TEXT);'
        + 'CREATE TABLE LimTrig(Id INTEGER PRIMARY KEY, V INTEGER);'
        + 'CREATE TABLE LimH(Id TEXT PRIMARY KEY, H INTEGER);');
    } finally { limSeed.close(); }
  }
  const limBefore = sha256(limSource);
  const LIM_OFF = 'mod-lim-off-0000';
  const limCtx = { enabled: ['mod-lim-a', 'mod-lim-b'], installed: ['mod-lim-a', 'mod-lim-b', LIM_OFF] };
  const limSet = [
    {
      modId: 'mod-lim-a',
      files: [
        {
          label: 'trig.sql',
          text: 'CREATE TRIGGER lim_trg AFTER INSERT ON LimTrig BEGIN\n'
            + '  UPDATE LimTrig SET V = 1 WHERE Id = NEW.Id;\n'
            + 'END;\nINSERT INTO LimTrig VALUES(1, 0);',
        },
        { label: 'seed.xml', text: '<GameData><LimT><Row K="k1" V="v1"/></LimT></GameData>' },
      ],
    },
    {
      modId: 'mod-lim-b',
      files: [
        { label: 'contest.sql', text: "UPDATE LimT SET V = \"v2\" WHERE K = 'k1';" },
        { label: 'hash.sql', text: "INSERT INTO LimH VALUES('h', Make_Hash('abc'));" },
        {
          label: 'gated.sql',
          text: "INSERT INTO LimT VALUES('gated', 'G');",
          gate: { any: false, conditions: [{ type: 'ModInUse', value: LIM_OFF, inverse: false }] },
        },
      ],
    },
  ];
  const limCollected = cr.collectStatements(limSet, { preprocess: true });
  const limStageOf = (label, stage) => limCollected.files.find((f) => f.fileLabel === label)
    .stages.find((s) => s.stage === stage).outcome;
  check('trig.sql splitter transformed (heuristic, flagged)', limStageOf('trig.sql', 'splitter') === 'transformed');
  check('contest.sql double-quote rewrite transformed',
    limStageOf('contest.sql', 'double-quote-rewrite') === 'transformed');
  check('seed.xml converted', limStageOf('seed.xml', 'xml-to-sql') === 'transformed');
  check('hash.sql stub installed-at-replay', limStageOf('hash.sql', 'make-hash-stub') === 'installed-at-replay');
  const limCopy = cr.createTempCopy(limSource);
  const limRep = cr.replayOrdered(limCopy.tempDbPath, limCollected, { provenance: true, gates: limCtx });
  const limCol = limRep.provenance.collisions.find((c) => c.table === 'LimT' && c.pk === 'k1' && c.column === 'V');
  check('mixed fixture collides on the contested cell', !!limCol, limCol ? cr.formatCollision(limCol) : 'none');
  check('winner is the later writer (last-writer-wins)',
    !!limCol && limCol.winner.modId === 'mod-lim-b' && limCol.winner.fileLabel === 'contest.sql',
    limCol ? JSON.stringify(limCol.winner) : 'no collision');
  check('collision carries fidelity-limited flags from both writers',
    !!limCol && limCol.fidelityLimited.includes('xml-to-sql')
    && limCol.fidelityLimited.includes('double-quoted-string-rewrite'),
    limCol ? limCol.fidelityLimited.join(',') : 'no collision');
  check('gated file skipped with reason', limRep.skippedGated === 1 && limRep.gatedOut.length === 1,
    JSON.stringify(limRep.gatedOut));
  check('FK mode recorded on the report', limRep.fkMode === 'OFF', limRep.fkMode);
  check('Make_Hash stub recorded on the report', limRep.makeHashStub === 'installed');
  cr.destroyTempCopy(limCopy.tmpDir);
  check('limitation source content unchanged', sha256(limSource) === limBefore);
  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});

// ---- suite: --live-lock (reviewer WARNING 1, semantics verbatim) ----

suite('--live-lock', () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-livelock-')));
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec('CREATE TABLE LockCheck(Id TEXT PRIMARY KEY, Value INTEGER);'
        + "INSERT INTO LockCheck VALUES('base', 0);");
    } finally {
      seed.close();
    }
  }
  const modSet = [
    { modId: 'mod-a', files: [{ label: 'ok.sql', text: "INSERT INTO LockCheck VALUES('ok', 1);" }] },
    { modId: 'mod-b', files: [{ label: 'bad.sql', text: 'INSERT INTO NoSuchLock VALUES(1);' }] },
  ];

  const trial = cr.lockedCopyTrial(sourceDbPath, modSet);
  check('unlocked baseline: good file committed, bad file aborted',
    trial.baseline.statuses.join(' ') === 'mod-a/ok.sql:committed mod-b/bad.sql:aborted',
    trial.baseline.statuses.join(' '));
  check('unlocked baseline executed exactly the good statement',
    trial.baseline.executed === 1 && trial.baseline.total === 2,
    `executed=${trial.baseline.executed} total=${trial.baseline.total}`);

  check('copy + report succeed under lock (200-equivalent)',
    !trial.copyError && !!trial.locked,
    trial.copyError ? String((trial.copyError && trial.copyError.message) || trial.copyError)
      : `executed=${trial.locked && trial.locked.executed}`);
  check('locked findings match the unlocked run',
    !!trial.locked && JSON.stringify(trial.locked) === JSON.stringify(trial.baseline),
    trial.locked ? `statuses=${trial.locked.statuses.join(' ')} rows=${JSON.stringify(trial.locked.rows)}`
      : 'no locked report');

  check('live file byte-identical afterwards', trial.liveAfter === trial.liveBefore,
    `before=${trial.liveBefore.slice(0, 12)} after=${trial.liveAfter.slice(0, 12)}`);
  const liveRows = (() => {
    const db = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id, Value FROM LockCheck').all(); } finally { db.close(); }
  })();
  check('live DB holds only its seed row', liveRows.length === 1 && liveRows[0].Id === 'base',
    JSON.stringify(liveRows));

  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});
// ---- emit: one it() per recorded check ----

// ---- suite: --assumed-gates (game-setup task 2.2) ----

suite('--assumed-gates', () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-assumed-')));
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec('CREATE TABLE SetupCheck(Id TEXT PRIMARY KEY, Value INTEGER);'
        + "INSERT INTO SetupCheck VALUES('base', 0);");
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);
  const beforeMtime = fs.statSync(sourceDbPath).mtimeMs;

  const ON_ID = 'mod-setup-on-1111';
  const OFF_ID = 'mod-setup-off-2222';
  const RULESET = 'RULESET:RULESET_EXPANSION_2';
  const MODE = 'GAMEMODE:GAMEMODE_MONOPOLIES';
  const CONFIG = 'CONFIG:Map/MapSize=MAPSIZE_DUEL';
  const ctx = { enabled: [ON_ID], installed: [ON_ID, OFF_ID], asserted: [RULESET, MODE, CONFIG] };
  const bare = { enabled: [ON_ID], installed: [ON_ID, OFF_ID] };
  const gMeasuredIn = { any: false, conditions: [{ type: 'ModInUse', value: ON_ID }] };
  const gRuleset = { any: false, conditions: [{ type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2' }] };
  const gMode = { any: false, conditions: [{ type: 'ConfigurationValueMatches', value: '1', props: { Group: 'Game', ConfigurationId: 'GAMEMODE_MONOPOLIES', Value: '1' } }] };
  const gConfig = { any: false, conditions: [{ type: 'ConfigurationValueMatches', value: 'MAPSIZE_DUEL', props: { Group: 'Map', ConfigurationId: 'MapSize', Value: 'MAPSIZE_DUEL' } }] };
  const gConfigBare = { any: false, conditions: [{ type: 'ConfigurationValueMatches', value: 'MAPSIZE_DUEL' }] };
  const gOther = { any: false, conditions: [{ type: 'RuleSetInUse', value: 'RULESET_NEVER_ASSERTED' }] };
  const gMeasuredOut = { any: false, conditions: [{ type: 'ModInUse', value: OFF_ID }] };
  const gNotRuleset = { any: false, conditions: [{ type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2', inverse: true }] };

  const vMeasured = cr.evaluateGate(gMeasuredIn, ctx);
  check('measured will-run carries no assumed flag', vMeasured.willRun === true && vMeasured.assumed === false, JSON.stringify(vMeasured));
  const vRuleset = cr.evaluateGate(gRuleset, ctx);
  check('asserted ruleset runs, flagged assumed', vRuleset.willRun === true && vRuleset.assumed === true, JSON.stringify(vRuleset));
  const vMode = cr.evaluateGate(gMode, ctx);
  check('asserted game mode runs, flagged assumed', vMode.willRun === true && vMode.assumed === true, JSON.stringify(vMode));
  const vConfig = cr.evaluateGate(gConfig, ctx);
  check('asserted config triple runs, flagged assumed', vConfig.willRun === true && vConfig.assumed === true, JSON.stringify(vConfig));
  check('a value-only config condition never guesses', cr.evaluateGate(gConfigBare, ctx).willRun === null);
  check('an unasserted ruleset stays undecided', (() => {
    const v = cr.evaluateGate(gOther, ctx);
    return v.willRun === null && v.assumed === false && v.unknown.length === 1;
  })(), JSON.stringify(cr.evaluateGate(gOther, ctx).unknown));
  const vNot = cr.evaluateGate(gNotRuleset, ctx);
  check('NOT an asserted value is assumed not to run', vNot.willRun === false && vNot.assumed === true, JSON.stringify(vNot));
  check('a measured miss stays measured (never assumed)', (() => {
    const v = cr.evaluateGate(gMeasuredOut, ctx);
    return v.willRun === false && v.assumed === false;
  })());

  const andBoth = { any: false, conditions: [{ type: 'ModInUse', value: ON_ID }, { type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2' }] };
  check('AND measured+assumed runs assumed (without it: undecided)', cr.evaluateGate(andBoth, ctx).assumed === true);
  check('AND measured-only runs measured',
    cr.evaluateGate({ any: false, conditions: [{ type: 'ModInUse', value: ON_ID }, { type: 'ModInUse', value: ON_ID }] }, ctx).assumed === false);
  const orBoth = { any: true, conditions: [{ type: 'ModInUse', value: ON_ID }, { type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2' }] };
  check('OR carried by measured runs measured', cr.evaluateGate(orBoth, ctx).assumed === false);
  const orAssumed = { any: true, conditions: [{ type: 'ModInUse', value: OFF_ID }, { type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2' }] };
  check('OR carried by assumed alone runs assumed', cr.evaluateGate(orAssumed, ctx).assumed === true);
  check('undecided rows are never flagged',
    cr.evaluateGate({ any: true, conditions: [{ type: 'ModInUse', value: OFF_ID }, { type: 'RuleSetInUse', value: 'RULESET_X' }] }, ctx).assumed === false);
  check('store-view, Set, and array shapes all match',
    cr.evaluateGate(gRuleset, { enabled: [ON_ID], installed: [ON_ID], asserted: { asserted: { [RULESET]: true } } }).assumed === true
    && cr.evaluateGate(gRuleset, { enabled: [ON_ID], installed: [ON_ID], asserted: new Set([RULESET]) }).assumed === true);
  check('junk asserted never throws, never matches',
    cr.evaluateGate(gRuleset, { enabled: [], installed: [], asserted: 42 }).willRun === null
    && cr.evaluateGate(gRuleset, { enabled: [], installed: [], asserted: ['junk-without-a-kind'] }).willRun === null);

  const modSet = [
    {
      modId: 'mod-setup',
      files: [
        { label: 'measured.sql', text: "INSERT INTO SetupCheck VALUES('measured', 1);", gate: gMeasuredIn },
        { label: 'ruleset.sql', text: "INSERT INTO SetupCheck VALUES('ruleset', 2);", gate: gRuleset },
        { label: 'mode.sql', text: "INSERT INTO SetupCheck VALUES('mode', 3);", gate: gMode },
        { label: 'unknown.sql', text: "INSERT INTO SetupCheck VALUES('unknown', 4);", gate: gOther },
        { label: 'off.sql', text: "INSERT INTO SetupCheck VALUES('off', 5);", gate: gMeasuredOut },
        { label: 'not-ruleset.sql', text: "INSERT INTO SetupCheck VALUES('not-ruleset', 6);", gate: gNotRuleset },
      ],
    },
  ];
  const collected = cr.collectStatements(modSet);
  const c1 = cr.createTempCopy(sourceDbPath);
  const report = cr.replayOrdered(c1.tempDbPath, collected, { gates: ctx });
  check('measured and assumed files all commit', report.perFile.slice(0, 4).every((f) => f.status === 'committed'),
    report.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  check('both gated-out files skipped, never replayed',
    report.perFile[4].status === 'skipped-gated' && report.perFile[5].status === 'skipped-gated');
  check('assumed-satisfied files named distinctly from measured ones',
    report.gatedAssumed.map((g) => g.fileLabel).join(',') === 'ruleset.sql,mode.sql',
    JSON.stringify(report.gatedAssumed));
  check('measured commit carries no assumed flag', report.perFile[0].gate.assumed === false);
  check('assumed commits carry the flag', report.perFile[1].gate.assumed === true && report.perFile[2].gate.assumed === true);
  check('undecidable files stay flagged unknown, never assumed',
    report.gatedUnknown.length === 1 && report.gatedUnknown[0].fileLabel === 'unknown.sql' && report.perFile[3].gate.assumed === false,
    JSON.stringify(report.gatedUnknown));
  check('gated-out assumed flag tells the two misses apart',
    report.gatedOut.find((g) => g.fileLabel === 'off.sql').assumed === false
    && report.gatedOut.find((g) => g.fileLabel === 'not-ruleset.sql').assumed === true,
    JSON.stringify(report.gatedOut));
  check('executed counts the four replayed statements', report.executed === 4 && report.skippedGated === 2,
    `executed=${report.executed} skippedGated=${report.skippedGated}`);
  const rows = (() => {
    const db = new DatabaseSync(c1.tempDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id FROM SetupCheck').all().map((r) => r.Id).sort(); } finally { db.close(); }
  })();
  check('assumed-satisfied rows landed', rows.includes('ruleset') && rows.includes('mode'), rows.join(','));
  check('gated-out rows never landed', !rows.includes('off') && !rows.includes('not-ruleset'), rows.join(','));
  cr.destroyTempCopy(c1.tmpDir);

  const shapes = [gMeasuredIn, gRuleset, gMode, gConfig, gOther, gMeasuredOut, gNotRuleset];
  check('empty-asserted verdicts match bare-context verdicts', shapes.every((g) => {
    const a = cr.evaluateGate(g, bare);
    const b = cr.evaluateGate(g, { enabled: [ON_ID], installed: [ON_ID, OFF_ID], asserted: [] });
    return a.willRun === b.willRun && (a.reason || null) === (b.reason || null)
      && JSON.stringify(a.unknown) === JSON.stringify(b.unknown) && b.assumed === false;
  }));
  const c2 = cr.createTempCopy(sourceDbPath);
  const plain = cr.replayOrdered(c2.tempDbPath, collected, { gates: bare });
  check('no assumed flags anywhere without assertions',
    plain.gatedAssumed.length === 0 && plain.perFile.every((f) => !f.gate || f.gate.assumed === false)
    && plain.gatedOut.every((g) => g.assumed === false));
  check('unasserted setup files replay as unknown (1.3 behavior)',
    plain.gatedUnknown.map((g) => g.fileLabel).join(',') === 'ruleset.sql,mode.sql,unknown.sql,not-ruleset.sql',
    JSON.stringify(plain.gatedUnknown.map((g) => g.fileLabel)));
  check('measured outcomes unchanged without assertions',
    plain.perFile[0].status === 'committed' && plain.perFile[4].status === 'skipped-gated'
    && plain.perFile[5].status === 'committed' && plain.executed === 5 && plain.skippedGated === 1,
    plain.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  cr.destroyTempCopy(c2.tmpDir);

  check('source content unchanged', sha256(sourceDbPath) === beforeHash);
  check('source mtime unchanged', fs.statSync(sourceDbPath).mtimeMs === beforeMtime);
  const liveRows = (() => {
    const db = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id FROM SetupCheck').all(); } finally { db.close(); }
  })();
  check('source holds only its seed row', liveRows.length === 1 && liveRows[0].Id === 'base', JSON.stringify(liveRows));

  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});

// ---- suite: --text-tables (replay-text-tables 1.1 + 1.2) ----

suite('--text-tables', () => {
  const tmpRoot = fs.realpathSync.native(os.tmpdir());

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-text-')));
  const makeSource = (name, seedSql) => {
    const p = path.join(scratch, name);
    const db = new DatabaseSync(p);
    try { db.exec(seedSql); } finally { db.close(); }
    return p;
  };
  const tmpUnder = (p) => typeof p === 'string' && p.startsWith(tmpRoot);

  const GAME_SEED = 'CREATE TABLE Units(UnitType TEXT PRIMARY KEY);'
    + "INSERT INTO Units VALUES('WARRIOR');";
  const TEXT_CLEAN = [
    {
      modId: 'mod-text',
      files: [
        {
          label: 'text.sql',
          text: 'INSERT INTO LocalizedText (Language, Tag, Text)'
            + " VALUES ('en_US', 'LOC_HELLO', 'Hello');\n"
            + 'INSERT INTO LocalizedText (Language, Tag, Text, Gender)'
            + " VALUES ('en_US', 'LOC_BYE', 'Bye', 'Masculine');",
        },
        {
          label: 'more.xml',
          text: '<GameData><LocalizedText>'
            + '<Row Language="en_US" Tag="LOC_XML" Text="From XML"/>'
            + '</LocalizedText></GameData>',
        },
      ],
    },
  ];

  const srcA = makeSource('game-a.sqlite', GAME_SEED);
  const beforeA = sha256(srcA);
  const cA = cr.createTempCopy(srcA);
  const collectedA = cr.collectStatements(TEXT_CLEAN, { preprocess: true });
  const repA = cr.replayOrdered(cA.tempDbPath, collectedA, { textTables: false });
  check('both text files skipped-text, none aborted',
    repA.perFile.length === 2 && repA.perFile.every((f) => f.status === 'skipped-text'),
    repA.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  check('zero abort rows on the text fixture',
    repA.perFile.every((f) => f.status !== 'aborted'));
  check('note states the table set and the file count',
    !!repA.textTables.note && repA.textTables.note.includes('LocalizedText')
    && repA.textTables.tables.join(',') === 'LocalizedText' && repA.textTables.files === 2,
    repA.textTables.note);
  check('nothing executed (miss at statement 0)', repA.executed === 0, `got ${repA.executed}`);
  const diffA = cr.differentialValidate(repA, [], collectedA);
  check('no replay-only text noise in the differential', diffA.replayOnly.length === 0,
    `got ${diffA.replayOnly.length}`);
  cr.destroyTempCopy(cA.tmpDir);
  check('source content unchanged', sha256(srcA) === beforeA);

  const srcB = makeSource('game-b.sqlite', GAME_SEED);
  const beforeB = sha256(srcB);
  const cB = cr.createTempCopy(srcB);
  const repB = cr.replayOrdered(cB.tempDbPath, cr.collectStatements(TEXT_CLEAN, { preprocess: true }));
  check('clean text files commit', repB.perFile.every((f) => f.status === 'committed'),
    repB.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  check('every text statement executed', repB.executed === 3, `got ${repB.executed}`);
  check('both files routed to the text copy', repB.textTables.routed === 2
    && repB.perFile.every((f) => f.routed === 'text'), `got routed=${repB.textTables.routed}`);
  check('no skip note when nothing skipped', repB.textTables.note === null);
  check('text copy path reported under the OS temp dir', tmpUnder(repB.textTables.textDbPath),
    repB.textTables.textDbPath);
  check('text copy destroyed with the replay', !fs.existsSync(repB.textTables.textDbPath));
  cr.destroyTempCopy(cB.tmpDir);
  check('gameplay temp copy cleaned up', !fs.existsSync(cB.tempDbPath));
  check('source content unchanged', sha256(srcB) === beforeB);

  const sc = cr.createTextSchemaCopy({ prefix: 'civ6-conflict-replay-text-schema-' });
  check('schema copy lives under the OS temp dir', tmpUnder(sc.tempDbPath), sc.tempDbPath);
  const scDb = new DatabaseSync(sc.tempDbPath);
  let dupErr = '';
  let badErr = '';
  let colErr = '';
  try {
    scDb.exec("INSERT INTO LocalizedText (Language, Tag, Text) VALUES ('en_US', 'LOC_S', 'S');");
    try {
      scDb.exec("INSERT INTO LocalizedText (Language, Tag, Text) VALUES ('en_US', 'LOC_S', 'again');");
    } catch (e) { dupErr = e.message; }
    try {
      scDb.exec('INSERT INTO LocalizedText (Language, Tag, Text VALUES (1);');
    } catch (e) { badErr = e.message; }
    try {
      scDb.exec("INSERT INTO LocalizedText (Language, Tag, Text, FutureCol) VALUES ('en_US', 'LOC_F', 'F', 'x');");
    } catch (e) { colErr = e.message; }
    const got = scDb.prepare("SELECT Text FROM LocalizedText WHERE Tag = 'LOC_S'").get().Text;
    check('named-column inserts land', got === 'S', `got ${got}`);
  } finally {
    scDb.close();
  }
  check('duplicate keys fail UNIQUE', /UNIQUE constraint failed/i.test(dupErr), dupErr);
  check('bad statements fail (not silently kept)', !!badErr && !cr.textTableMiss(badErr), badErr);
  check('unknown columns fail as column misses', !!cr.textColumnMiss(colErr), colErr);
  cr.destroyTempCopy(sc.tmpDir);
  check('schema copy cleaned up', !fs.existsSync(sc.tempDbPath));

  const srcC = makeSource('game-c.sqlite', GAME_SEED);
  const cC = cr.createTempCopy(srcC);
  const badSet = [
    {
      modId: 'mod-bad',
      files: [
        { label: 'bad.sql', text: 'INSERT INTO LocalizedText (Language, Tag, Text VALUES (1);' },
      ],
    },
  ];
  const repC = cr.replayOrdered(cC.tempDbPath, cr.collectStatements(badSet));
  check('bad text file aborts', repC.perFile[0].status === 'aborted');
  check('abort is genuine (not a table miss)', !cr.textTableMiss(repC.perFile[0].error));
  const diffC = cr.differentialValidate(repC, [], cr.collectStatements(badSet));
  check('bad statement surfaces in the differential',
    diffC.replayOnly.length === 1 && diffC.replayOnly[0].fileLabel === 'bad.sql'
    && diffC.replayOnly[0].sameMod === undefined,
    JSON.stringify(diffC.replayOnly.map((r) => r.fileLabel)));
  cr.destroyTempCopy(cC.tmpDir);

  const srcD = makeSource('game-d.sqlite', GAME_SEED);
  const cD = cr.createTempCopy(srcD);
  const dupRow = "INSERT INTO LocalizedText (Language, Tag, Text) VALUES ('en_US', 'LOC_DUP', 'D');";
  const crossSet = [
    { modId: 'mod-a', files: [{ label: 'a.sql', text: dupRow }] },
    { modId: 'mod-b', files: [{ label: 'b.sql', text: dupRow }] },
  ];
  const collectedD = cr.collectStatements(crossSet);
  const repD = cr.replayOrdered(cD.tempDbPath, collectedD);
  check('first writer commits', repD.perFile[0].status === 'committed');
  check('second writer aborts UNIQUE',
    repD.perFile[1].status === 'aborted' && /UNIQUE constraint failed/i.test(repD.perFile[1].error || ''),
    repD.perFile[1].error);
  check('cross-mod duplicate carries no same-mod tag', repD.perFile[1].sameMod === undefined);
  const diffD = cr.differentialValidate(repD, [], collectedD);
  check('cross-mod duplicate surfaces untagged in the differential',
    diffD.replayOnly.length === 1 && diffD.replayOnly[0].sameMod === undefined);
  cr.destroyTempCopy(cD.tmpDir);

  const srcE = makeSource('game-e.sqlite', GAME_SEED);
  const cE = cr.createTempCopy(srcE);
  const sameSet = [
    {
      modId: 'mod-a',
      files: [
        { label: 'first.sql', text: dupRow },
        { label: 'second.sql', text: dupRow },
      ],
    },
  ];
  const collectedE = cr.collectStatements(sameSet);
  const repE = cr.replayOrdered(cE.tempDbPath, collectedE);
  check('layered file aborts UNIQUE', repE.perFile[1].status === 'aborted'
    && /UNIQUE constraint failed/i.test(repE.perFile[1].error || ''));
  check('same-mod duplicate tagged on the per-file row', repE.perFile[1].sameMod === true);
  const errsE = cr.collectReplayErrors(repE, collectedE);
  check('tag rides the replay error row', errsE.length === 1 && errsE[0].sameMod === true);
  const diffE = cr.differentialValidate(repE, [], collectedE);
  check('tag rides the replay-only row',
    diffE.replayOnly.length === 1 && diffE.replayOnly[0].sameMod === true);
  const logErr = repE.perFile[1].error;
  const diffAgree = cr.differentialValidate(repE,
    [{ line: 3, text: `[3] [Gameplay] ERROR: ${logErr}`, message: logErr }], collectedE);
  check('tag rides the agreement row when the log matches',
    diffAgree.agreements.length === 1 && diffAgree.agreements[0].sameMod === true);
  cr.destroyTempCopy(cE.tmpDir);

  const srcF = makeSource('game-f.sqlite', GAME_SEED);
  const cF = cr.createTempCopy(srcF);
  const driftSet = [
    {
      modId: 'mod-drift',
      files: [
        {
          label: 'drift.sql',
          text: "INSERT INTO LocalizedText (Language, Tag, Text, FutureCol) VALUES ('en_US', 'LOC_F', 'F', 'x');",
        },
      ],
    },
  ];
  let repF = null;
  let threw = false;
  try {
    repF = cr.replayOrdered(cF.tempDbPath, cr.collectStatements(driftSet));
  } catch (e) {
    threw = true;
  }
  check('replay never throws on drift', !threw && !!repF);
  if (repF) {
    check('drift file falls back with its reason',
      repF.textTables.fallback.length === 1
      && repF.textTables.fallback[0].fileLabel === 'drift.sql'
      && /^unknown-column:/.test(repF.textTables.fallback[0].reason),
      JSON.stringify(repF.textTables.fallback));
    check('drift file ends skipped-text on the gameplay copy', repF.perFile[0].status === 'skipped-text');
    check('skip note still states the miss', !!repF.textTables.note
      && repF.textTables.note.includes('LocalizedText'), repF.textTables.note);
  }
  cr.destroyTempCopy(cF.tmpDir);

  const srcG = makeSource('game-g.sqlite', GAME_SEED);
  const cG = cr.createTempCopy(srcG);
  const mixSet = [
    {
      modId: 'mod-mix',
      files: [
        {
          label: 'mix.sql',
          text: "INSERT INTO Units VALUES('SCOUT');\n"
            + "INSERT INTO LocalizedText (Language, Tag, Text) VALUES ('en_US', 'LOC_SCOUT', 'Scout');",
        },
      ],
    },
  ];
  const repG = cr.replayOrdered(cG.tempDbPath, cr.collectStatements(mixSet));
  check('mixed file commits', repG.perFile[0].status === 'committed');
  check('mixed file marked split', repG.perFile[0].routed === 'split', repG.perFile[0].routed);
  const landed = (() => {
    const db = new DatabaseSync(cG.tempDbPath, { readOnly: true });
    try { return db.prepare("SELECT count(*) AS n FROM Units WHERE UnitType = 'SCOUT'").get().n; }
    finally { db.close(); }
  })();
  check('gameplay statement lands in the gameplay copy', landed === 1, `got ${landed}`);
  cr.destroyTempCopy(cG.tmpDir);

  check('three named tables route text-side',
    cr.isTextTableName('LocalizedText') && cr.isTextTableName('englishtext') && cr.isTextTableName('BaseGameText'));
  check('*Text kin counts, gameplay tables do not',
    cr.isTextTableName('FrenchText') && !cr.isTextTableName('Units') && !cr.isTextTableName('NoSuchTable'));
  check('table misses parse (quoted and schema-qualified)',
    cr.textTableMiss('no such table: LocalizedText') === 'LocalizedText'
    && cr.textTableMiss('no such table: "EnglishText"') === 'EnglishText'
    && cr.textTableMiss('no such table: main.BaseGameText') === 'BaseGameText');
  check('gameplay misses are not table misses',
    cr.textTableMiss('no such table: NoSuchTable') === null
    && cr.textTableMiss('UNIQUE constraint failed: T.Id') === null
    && cr.textTableMiss('near "VALUES": syntax error') === null);
  check('duplicate-key tables parse', cr.uniqueMissTable('UNIQUE constraint failed: LocalizedText.Language') === 'LocalizedText');
  check('column misses parse',
    (cr.textColumnMiss('table LocalizedText has no column named FutureCol') || {}).column === 'FutureCol'
    && (cr.textColumnMiss('no such column: FutureCol') || {}).column === 'FutureCol'
    && cr.textColumnMiss('no such table: LocalizedText') === null);

  if (current.recs.every((r) => r.cond)) fs.rmSync(scratch, { recursive: true, force: true });
});
// ---- suite: --crash-vicinity (conflict-crash-vicinity tracks 1+2) ----

suite('--crash-vicinity', () => {
  const folderMap = {
    workshop: { 1111111111: { modId: 'mod-alpha', name: 'Alpha Mod' } },
    local: [{ folder: 'MyLocalMod', modId: 'mod-local', name: 'Local Mod' }],
  };
  const L = [];
  L.push('[100.001] [Gameplay] ERROR: no such table: NoSuchOld'); // line 1: outside the window
  for (let i = 2; i <= 105; i += 1) L.push(`[${(100 + i / 1000).toFixed(3)}] [Gameplay] Update ${i}...`);
  L.push('[106.001] [Gameplay] ERROR: no such table: NoSuchLone'); // 106: unattributed
  L.push('[107.001] [Gameplay] from file D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_A.xml'); // 107
  L.push('[107.001] [Gameplay] ERROR: UNIQUE constraint failed: AlphaA.Id'); // 108: alpha
  L.push('[107.001] [Gameplay] ERROR: UNIQUE constraint failed: AlphaB.Id'); // 109: alpha, same moment
  L.push('[110.001] [Gameplay] ERROR: RulersOfTheSahara progress era set failed'); // 110: benign
  L.push('[111.001] [Gameplay] ERROR: RulersOfTheSahara leader load warning'); // 111: benign
  L.push('[112.001] [Gameplay] ERROR: JuliusCaesar Districts load warning'); // 112: benign
  L.push('[113.001] [Gameplay] ERROR: CatherineDeMedici_Modifiers apply warning'); // 113: benign
  L.push('[114.001] [Gameplay] ERROR: Missing [Localization] LOC_CLICKOUT_CLOSE Entry'); // 114: benign
  L.push('[115.001] [Gameplay] ERROR: UNIQUE constraint failed: RealT.Id'); // 115: real
  L.push('[116.001] [Gameplay] ERROR: no such table: NoSuchHinted -- file: hinted.sql statement 2'); // 116
  L.push('[117.001] [Gameplay] from file C:/Games/Mods/MyLocalMod/Data/Beta_Traits.xml'); // 117
  L.push('[117.001] [Gameplay] ERROR: UNIQUE constraint failed: Beta.Id'); // 118: local
  const entries = cr.parseDatabaseLog(L.join('\n'));
  check('fixture parses to twelve ERROR entries', entries.length === 12, `got ${entries.length}`);
  const vic = cr.buildCrashVicinity(entries, [], folderMap, { totalLines: L.length });
  check('error outside the 100-line window is excluded',
    vic.count === 11 && vic.groups.every((g) => g.entries.every((e) => e.line > 1)),
    `count=${vic.count}`);
  check('window entries grouped by attributed mod',
    (vic.groups.find((g) => g.modId === 'mod-alpha') || { count: -1 }).count === 2,
    JSON.stringify(vic.groups.map((g) => `${g.modId}:${g.count}`)));
  check('attributed groups sort newest-first',
    vic.groups[0].modId === 'mod-local' && vic.groups[1].modId === 'mod-alpha',
    vic.groups.map((g) => `${g.modId}@${g.newestLine}`).join(', '));
  check('unattributed bucket stays visible and sorts last',
    vic.groups.length === 3 && vic.groups[2].modId === null && vic.groups[2].count > 0,
    JSON.stringify(vic.groups.map((g) => `${g.modId}:${g.count}`)));
  check('entries sort line-desc inside the group',
    (vic.groups.find((g) => g.modId === 'mod-alpha').entries.map((e) => e.line)).join(',') === '109,108');
  const pair = vic.groups.find((g) => g.modId === 'mod-alpha').entries;
  check('same-moment pair shares its tag, lone entries carry none',
    pair.every((e) => e.sameMoment === '[107.001]')
    && vic.groups[2].entries.every((e) => e.sameMoment === null),
    JSON.stringify(pair.map((e) => e.sameMoment)));
  const sample = pair[0];
  check('entries carry timestampMs + line + text + strength + fileHint',
    typeof sample.timestampMs === 'number' && typeof sample.line === 'number'
    && typeof sample.text === 'string' && typeof sample.strength === 'string'
    && 'fileHint' in sample,
    JSON.stringify({ timestampMs: sample.timestampMs, strength: sample.strength }));
  const empty = cr.buildCrashVicinity([], [], folderMap, { totalLines: 0 });
  check('empty log yields no groups', empty.groups.length === 0 && empty.count === 0);
  const benignHits = [
    '[210.001] [Gameplay] ERROR: RulersOfTheSahara progress era set failed',
    '[210.002] [Gameplay] ERROR: RulersOfTheSahara leader load warning',
    '[210.003] [Gameplay] ERROR: JuliusCaesar Units art load warning',
    '[210.004] [Gameplay] ERROR: CatherineDeMedici_Modifiers apply warning',
    '[210.005] [Gameplay] ERROR: Missing [Localization] LOC_CLICKOUT_BACK Entry',
  ].map((t) => cr.parseDatabaseLog(t)[0]);
  check('each benign pattern matches (Sahara x2, Caesar, Catherine, clickout)',
    benignHits.every((e) => cr.isBenignLogError(e).benign), JSON.stringify(benignHits.map((e) => e.message)));
  check('benign rows name why in player words',
    benignHits.every((e) => /never breaks mods/.test(cr.isBenignLogError(e).why || '')));
  const real = [
    '[211.001] [Gameplay] ERROR: UNIQUE constraint failed: RealT.Id',
    '[211.002] [Gameplay] ERROR: no such table: NoSuchReal',
  ].map((t) => cr.parseDatabaseLog(t)[0]);
  check('non-matching real errors are unaffected',
    real.every((e) => !cr.isBenignLogError(e).benign));
  const benignCount = cr.countBenignErrors(entries);
  check('tallies drop exactly by benign count',
    benignCount === 5 && entries.length - benignCount === 7,
    `benign=${benignCount} of ${entries.length}`);
  check('benign window entries stay grouped with their flag',
    vic.groups.flatMap((g) => g.entries).filter((e) => e.benign).length === 5);
});

for (const s of suites) {
  describe(s.name, () => {
    for (const rec of s.recs) {
      it(rec.label, () => {
        assert.ok(rec.cond, `${rec.label} :: ${rec.extra}`);
      });
    }
  });
}
