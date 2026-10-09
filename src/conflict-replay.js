'use strict';

// Conflict-replay library: temp-copy lifecycle, ordered replay with per-file
// SAVEPOINT abort emulation, preprocessing stages, criteria gating,
// provenance, Database.log differential, envelope, live-lock trial,
// assumed gates, and text-table replay. Required by both src/server.js (live
// report path) and src/phase9-conflict-replay.js (the 9-suite proof wrapper).
// Pure move from src/phase9-conflict-replay.js (wave4); behavior unchanged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const iconv = require('iconv-lite');

// ---------------------------------------------------------------------------
// Temp-copy lifecycle: the live game DB is never opened for writing.
// ---------------------------------------------------------------------------

// Copy sourceDbPath into a fresh directory under the OS temp dir and return
// the scratch dir plus the temp copy path. The source is only read.
function createTempCopy(sourceDbPath, { prefix = 'civ6-conflict-replay-' } = {}) {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const tempDbPath = path.join(tmpDir, path.basename(sourceDbPath));
  fs.copyFileSync(sourceDbPath, tempDbPath);
  return { tmpDir, tempDbPath, sourceDbPath };
}

function destroyTempCopy(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Mechanical guard: replay opens a database for writing only when it sits
// under the OS temp dir. A live game-DB path fails closed here, not in docs.
function assertTempPath(dbPath) {
  const tmp = fs.realpathSync.native(os.tmpdir());
  let resolved = path.resolve(dbPath);
  try { resolved = fs.realpathSync.native(resolved); } catch (_) { /* missing file: use resolved */ }
  const rel = path.relative(tmp, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to open for writing outside the temp dir: ${dbPath}`);
  }
}

// ---------------------------------------------------------------------------
// SQL file decoding: Civ6 mod files are commonly UTF-16; decode via
// iconv-lite with BOM detection plus a null-byte heuristic for BOM-less
// UTF-16LE. Plain ASCII/UTF-8 passes through as UTF-8.
// ---------------------------------------------------------------------------

function decodeModSql(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.slice(2), 'utf16-le'), encoding: 'utf16-le-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.slice(2), 'utf16-be'), encoding: 'utf16-be-bom' };
  }
  const probe = buf.slice(0, Math.min(buf.length, 4096));
  let zeros = 0;
  for (const b of probe) if (b === 0x00) zeros += 1;
  if (zeros > 0 && zeros >= probe.length * 0.1) {
    return { text: iconv.decode(buf, 'utf16-le'), encoding: 'utf16-le' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

function readModFile(filePath) {
  const raw = fs.readFileSync(filePath);
  return { ...decodeModSql(raw), filePath };
}

// ---------------------------------------------------------------------------
// Statement splitting (task-1.1 naive edition): split on semicolons outside
// single/double-quoted strings and -- / * * / comments. Trigger bodies with
// embedded semicolons need the trigger-aware splitter below (task 1.2).
// Kept verbatim for the 1.1 --check path: collectStatements defaults to it
// unless preprocessing is requested.
// ---------------------------------------------------------------------------

function splitStatements(sqlText) {
  const out = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < sqlText.length; i += 1) {
    const c = sqlText[i];
    const next = sqlText[i + 1];
    if (inLine) {
      cur += c;
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      cur += c;
      if (c === '*' && next === '/') { cur += next; i += 1; inBlock = false; }
      continue;
    }
    if (inSingle) {
      cur += c;
      if (c === "'") {
        if (next === "'") { cur += next; i += 1; } else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"') {
        if (next === '"') { cur += next; i += 1; } else inDouble = false;
      }
      continue;
    }
    if (c === '-' && next === '-') { cur += c + next; i += 1; inLine = true; continue; }
    if (c === '/' && next === '*') { cur += c + next; i += 1; inBlock = true; continue; }
    if (c === "'") { cur += c; inSingle = true; continue; }
    if (c === '"') { cur += c; inDouble = true; continue; }
    if (c === ';') {
      const stmt = cur.trim();
      if (stmt) out.push(stmt);
      cur = '';
      continue;
    }
    cur += c;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

// ---------------------------------------------------------------------------
// Task 1.2, stage: trigger-aware splitter. Same scanning as the naive
// splitter, plus word tracking so semicolons inside a CREATE TRIGGER body
// (between its BEGIN and matching END) do not terminate the statement.
// Nested BEGIN levels count; CASE...END inside a trigger body is tracked
// separately so a CASE END does not close the trigger early. A trigger
// statement ends at its terminating semicolon, which resets the tracking.
// Heuristic limits (declared, not silent): [...] / `...` quoted identifiers
// get no special handling, same as the naive splitter.
// ---------------------------------------------------------------------------

function splitStatementsTriggerAware(sqlText) {
  const out = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let inLine = false;
  let inBlock = false;
  let word = '';
  let sawCreate = false;
  let pendingTrigger = false;
  let depth = 0;
  let caseDepth = 0;
  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);
  const flushWord = () => {
    if (!word) return;
    const u = word.toUpperCase();
    word = '';
    if (!pendingTrigger) {
      if (u === 'CREATE') sawCreate = true;
      else if ((u === 'TEMP' || u === 'TEMPORARY') && sawCreate) { /* keep sawCreate */ }
      else if (u === 'TRIGGER' && sawCreate) { pendingTrigger = true; sawCreate = false; }
      else sawCreate = false;
    } else if (u === 'BEGIN') {
      depth += 1;
    } else if (u === 'CASE') {
      caseDepth += 1;
    } else if (u === 'END') {
      if (caseDepth > 0) caseDepth -= 1;
      else if (depth > 0) depth -= 1;
    }
  };
  const emit = () => {
    const stmt = cur.trim();
    if (stmt) out.push(stmt);
    cur = '';
    pendingTrigger = false;
    sawCreate = false;
    depth = 0;
    caseDepth = 0;
  };
  for (let i = 0; i < sqlText.length; i += 1) {
    const c = sqlText[i];
    const next = sqlText[i + 1];
    if (inLine) {
      cur += c;
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      cur += c;
      if (c === '*' && next === '/') { cur += next; i += 1; inBlock = false; }
      continue;
    }
    if (inSingle) {
      cur += c;
      if (c === "'") {
        if (next === "'") { cur += next; i += 1; } else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"') {
        if (next === '"') { cur += next; i += 1; } else inDouble = false;
      }
      continue;
    }
    if (isWordChar(c)) { cur += c; word += c; continue; }
    flushWord();
    if (c === '-' && next === '-') { cur += c + next; i += 1; inLine = true; continue; }
    if (c === '/' && next === '*') { cur += c + next; i += 1; inBlock = true; continue; }
    if (c === "'") { cur += c; inSingle = true; continue; }
    if (c === '"') { cur += c; inDouble = true; continue; }
    if (c === ';') {
      if (depth > 0) { cur += c; continue; } // inside a trigger body: not a terminator
      emit();
      continue;
    }
    cur += c;
  }
  flushWord();
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

// Mechanical splitter flag: naive vs trigger-aware statement counts.
function splitterFlags(sqlText) {
  const naive = splitStatements(sqlText);
  const aware = splitStatementsTriggerAware(sqlText);
  const transformed = naive.length !== aware.length;
  return {
    stage: 'splitter',
    mode: 'trigger-aware',
    outcome: transformed ? 'transformed' : 'skipped:identical',
    naive: naive.length,
    aware: aware.length,
    reason: transformed ? 'trigger-body-kept-whole' : 'no-trigger-bodies',
  };
}

// ---------------------------------------------------------------------------
// Task 1.2, stage: double-quoted-string rewrite. Civ6 mod SQL often uses
// "..." for string literals where strict SQLite expects '...'. Rewrite a
// "..." segment to '...' only in value positions: after a value-clause
// keyword (VALUES/SET/WHERE/...), after = at any level, or after ( / ,
// inside a VALUE parenthesis (VALUES(...), IN(...), function calls).
// Parentheses following a table name (CREATE TABLE T(...), INSERT INTO
// T(...), CREATE INDEX ... ON T(...)) open OTHER parens whose ,-separated
// "..." entries are quoted identifiers and stay verbatim. "" escapes become
// " then re-escape to '' on rewrite. Reports rewritten vs kept-identifier
// counts. Heuristic, declared per file.
// ---------------------------------------------------------------------------

const DQ_CLAUSE_PRECEDERS = new Set([
  'VALUES', 'SET', 'WHERE', 'AND', 'OR', 'LIKE', 'GLOB',
  'BETWEEN', 'IN', 'IS', 'THEN', 'ELSE', 'WHEN', 'DEFAULT',
]);

// Words after which ( opens a non-value (DDL identifier-list) paren.
const DQ_DDL_GUARDS = new Set(['TABLE', 'VIEW', 'INDEX', 'INTO', 'ON']);

function dqParenKind(lastSig, prevSig) {
  if (lastSig === 'VALUES' || lastSig === 'IN') return 'VALUE';
  const wordLike = lastSig !== '' && !['=', '(', ')', ','].includes(lastSig);
  if (wordLike && !DQ_DDL_GUARDS.has(prevSig)) return 'VALUE';
  return 'OTHER';
}

function shouldRewriteDq(lastSig, parenStack) {
  if (lastSig === '=') return true;
  if (DQ_CLAUSE_PRECEDERS.has(lastSig)) return true;
  if (lastSig === ',' || lastSig === '(') {
    const top = parenStack.length ? parenStack[parenStack.length - 1] : null;
    return top === null || top === 'VALUE';
  }
  return false;
}

function rewriteDoubleQuotes(sqlText) {
  let out = '';
  let word = '';
  let lastSig = '';
  let prevSig = '';
  const parenStack = [];
  const setSig = (s) => { prevSig = lastSig; lastSig = s; };
  let inSingle = false;
  let inLine = false;
  let inBlock = false;
  let rewritten = 0;
  let kept = 0;
  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);
  const flush = () => { if (word) { setSig(word.toUpperCase()); word = ''; } };
  for (let i = 0; i < sqlText.length; i += 1) {
    const c = sqlText[i];
    const next = sqlText[i + 1];
    if (inLine) {
      out += c;
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      out += c;
      if (c === '*' && next === '/') { out += next; i += 1; inBlock = false; }
      continue;
    }
    if (inSingle) {
      out += c;
      if (c === "'") {
        if (next === "'") { out += next; i += 1; } else inSingle = false;
      }
      continue;
    }
    if (isWordChar(c)) { out += c; word += c; continue; }
    flush();
    if (c === '-' && next === '-') { out += c + next; i += 1; inLine = true; continue; }
    if (c === '/' && next === '*') { out += c + next; i += 1; inBlock = true; continue; }
    if (c === "'") { out += c; inSingle = true; continue; }
    if (c === '"') {
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < sqlText.length) {
        if (sqlText[j] === '"') {
          if (sqlText[j + 1] === '"') { inner += '"'; j += 2; }
          else { closed = true; j += 1; break; }
        } else { inner += sqlText[j]; j += 1; }
      }
      if (!closed) { out += c; setSig(''); continue; } // unbalanced: leave as-is
      if (shouldRewriteDq(lastSig, parenStack)) {
        out += `'${inner.replace(/'/g, "''")}'`;
        rewritten += 1;
        setSig('LITERAL');
      } else {
        out += `"${inner.replace(/"/g, '""')}"`;
        kept += 1;
        setSig('IDENT');
      }
      i = j - 1;
      continue;
    }
    if (c === '(') {
      parenStack.push(dqParenKind(lastSig, prevSig));
      setSig('(');
    } else if (c === ')') {
      if (parenStack.length) parenStack.pop();
      setSig(')');
    } else if (c === '=' || c === ',') {
      setSig(c);
    } else if (c === ';') {
      parenStack.length = 0;
      prevSig = '';
      lastSig = '';
    } else if (!/\s/.test(c)) {
      setSig('');
    }
    out += c;
  }
  flush();
  return { text: out, rewritten, kept, outcome: rewritten > 0 ? 'transformed' : 'skipped' };
}

// ---------------------------------------------------------------------------
// Task 1.2, stage: Make_Hash JS stub. Some mods call the game-registered SQL
// function Make_Hash(...), which does not exist in a bare sqlite open, so
// those statements fail without a stub. The stub is a deterministic
// placeholder (FNV-1a over the string form) — the real game hash is
// unknown, so any collision touching a stubbed value is fidelity-limited by
// declaration (see the make-hash-stub flag note). needsMakeHash detects the
// call; installMakeHashStub registers it on a replay connection.
// ---------------------------------------------------------------------------

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function makeHashStubValue(value) {
  if (value === null || value === undefined) return null;
  return fnv1a32(String(value));
}

function needsMakeHash(statements) {
  return (statements || []).some((s) => /\bMake_Hash\s*\(/i.test(s));
}

function installMakeHashStub(db) {
  db.function('Make_Hash', { deterministic: true }, makeHashStubValue);
}

// ---------------------------------------------------------------------------
// Task 1.2, stage: XML→SQL converter. About 5% of Civ6 data files are
// GameData XML instead of SQL: <TableName> wrappers containing <Row>,
// <Replace>, <Update> (<Where>/<Set> children), <Delete>, <InsertOrIgnore>,
// plus embedded raw SQL in <Sql> blocks (CDATA unwrapped first). Generated
// SQL uses bare identifiers and single-quoted literals; numerics stay bare,
// NULL stays NULL. Ops outside any table wrapper are counted as unassigned,
// never assigned an invented table. Regex-based, matching the repo's existing
// convention for small consistent XML (see modinfo.js / modsdb.js).
// ---------------------------------------------------------------------------

function looksLikeXml(label, text) {
  return /\.xml$/i.test(label || '') || /^\s*</.test(text || '');
}

function decodeXmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => (
    { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n]));
}

function parseXmlAttrs(attrStr) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function sqlVal(v) {
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^NULL$/i.test(v)) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

const XML_OP_CANON = {
  row: 'Row',
  replace: 'Replace',
  insertorignore: 'InsertOrIgnore',
  update: 'Update',
  delete: 'Delete',
};

function convertXmlToSql(xmlText) {
  const flags = {
    stage: 'xml-to-sql',
    outcome: 'skipped',
    reason: 'not-xml',
    tables: [],
    opCounts: {},
    statements: 0,
    rawChunks: 0,
    unconvertible: 0,
    unassigned: 0,
  };
  const empty = { statements: [], rawChunks: [], sqlText: xmlText, flags };
  if (!/^\s*</.test(xmlText || '')) return empty;
  let body = (xmlText || '').replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c);
  const raws = [];
  body = body.replace(/<Sql\b[^>]*>([\s\S]*?)<\/\s*Sql\s*>/gi, (_, inner) => {
    if (inner.trim()) raws.push(inner.trim());
    return '\n';
  });
  body = body.replace(/<\?xml[^?]*\?>/g, ' ').replace(/<\/?GameData\b[^>]*>/gi, ' ');
  const statements = [];
  const opCounts = {};
  const tables = [];
  const matchedRanges = [];
  const count = (op) => { opCounts[op] = (opCounts[op] || 0) + 1; };
  const whereEq = (o) => Object.keys(o).map((k) => `${k}=${sqlVal(o[k])}`).join(' AND ');
  const tableRe = /<([A-Za-z_]\w*)\b[^>]*>([\s\S]*?)<\/\1\s*>/g;
  let tm;
  while ((tm = tableRe.exec(body)) !== null) {
    const table = tm[1];
    const inner = tm[2];
    if (/^(Row|Replace|Update|Delete|InsertOrIgnore|Where|Set|Sql)$/i.test(table)) continue;
    if (!/<(Row|Replace|Update|Delete|InsertOrIgnore)\b/i.test(inner)) continue;
    matchedRanges.push([tm.index, tableRe.lastIndex]);
    if (!tables.includes(table)) tables.push(table);
    const singleRe = new RegExp(
      '<(Row|Replace|InsertOrIgnore|Delete)\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1\\s*>)', 'gi',
    );
    let sm;
    while ((sm = singleRe.exec(inner)) !== null) {
      const op = XML_OP_CANON[sm[1].toLowerCase()];
      const attrs = parseXmlAttrs(sm[2]);
      const keys = Object.keys(attrs);
      // Zero-attribute Delete/Row forms convert to nothing safe: a bare
      // DELETE would wipe the table, so count unconvertible instead.
      if (keys.length === 0) { flags.unconvertible += 1; continue; }
      if (op === 'Delete') {
        statements.push(`DELETE FROM ${table} WHERE ${whereEq(attrs)};`);
      } else {
        const verb = op === 'Replace' ? 'INSERT OR REPLACE'
          : op === 'InsertOrIgnore' ? 'INSERT OR IGNORE' : 'INSERT';
        statements.push(`${verb} INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => sqlVal(attrs[k])).join(', ')});`);
      }
      count(op);
    }
    const updRe = /<Update\b[^>]*>([\s\S]*?)<\/Update\s*>/gi;
    let um;
    while ((um = updRe.exec(inner)) !== null) {
      const wm = /<Where\b([^>]*?)\/>/i.exec(um[1]);
      const st = /<Set\b([^>]*?)\/>/i.exec(um[1]);
      const w = wm ? parseXmlAttrs(wm[1]) : {};
      const s = st ? parseXmlAttrs(st[1]) : {};
      // A Where-less UPDATE would touch every row: refuse, count instead.
      if (Object.keys(w).length === 0 || Object.keys(s).length === 0) {
        flags.unconvertible += 1;
        continue;
      }
      statements.push(`UPDATE ${table} SET ${whereEq(s)} WHERE ${whereEq(w)};`);
      count('Update');
    }
  }
  // Ops outside any table wrapper cannot be assigned a table: count them.
  let rest = body;
  for (let k = matchedRanges.length - 1; k >= 0; k -= 1) {
    rest = `${rest.slice(0, matchedRanges[k][0])} ${rest.slice(matchedRanges[k][1])}`;
  }
  const stray = rest.match(/<(Row|Replace|Update|Delete|InsertOrIgnore)\b/gi);
  flags.unassigned = stray ? stray.length : 0;
  flags.tables = tables;
  flags.opCounts = opCounts;
  flags.rawChunks = raws.length;
  flags.statements = statements.length;
  if (statements.length > 0 || raws.length > 0) {
    flags.outcome = 'transformed';
    delete flags.reason;
  } else {
    flags.reason = 'no-convertible-ops';
  }
  return { statements, rawChunks: raws, sqlText: statements.concat(raws).join('\n'), flags };
}

// ---------------------------------------------------------------------------
// Task 1.2 preprocessing pipeline per file: XML→SQL, double-quote rewrite,
// trigger-aware split, Make_Hash detection. Returns the executable
// statements plus one flag object per stage (transform/skip with reason).
// ---------------------------------------------------------------------------

function preprocessFile(file, { splitter = 'trigger-aware' } = {}) {
  const label = file.label || 'file';
  let sqlText = file.text || '';
  const stages = [];
  // Stage 1: XML→SQL (only for XML-looking inputs; SQL passes through).
  if (looksLikeXml(label, sqlText)) {
    const conv = convertXmlToSql(sqlText);
    stages.push({ ...conv.flags });
    if (conv.flags.outcome === 'transformed') sqlText = conv.sqlText;
  } else {
    stages.push({ stage: 'xml-to-sql', outcome: 'skipped', reason: 'not-xml' });
  }
  // Stage 2: double-quoted-string rewrite.
  const rw = rewriteDoubleQuotes(sqlText);
  stages.push({
    stage: 'double-quote-rewrite',
    outcome: rw.outcome,
    rewritten: rw.rewritten,
    keptIdentifiers: rw.kept,
    ...(rw.rewritten > 0 ? {} : { reason: 'no-double-quoted-literals' }),
  });
  sqlText = rw.text;
  // Stage 3: statement splitting (trigger-aware keeps BEGIN...END whole).
  let statements;
  if (splitter === 'trigger-aware') {
    const sf = splitterFlags(sqlText);
    statements = splitStatementsTriggerAware(sqlText);
    stages.push({
      stage: 'splitter',
      mode: sf.mode,
      outcome: sf.outcome,
      naive: sf.naive,
      aware: sf.aware,
      reason: sf.reason,
    });
  } else {
    statements = splitStatements(sqlText);
    stages.push({
      stage: 'splitter', mode: 'naive', outcome: 'skipped',
      reason: 'naive-mode-selected', count: statements.length,
    });
  }
  // Stage 4: Make_Hash detection (the stub itself installs at replay time).
  const mh = needsMakeHash(statements);
  stages.push({
    stage: 'make-hash-stub',
    outcome: mh ? 'installed-at-replay' : 'skipped',
    needed: mh,
    ...(mh ? { note: 'deterministic-placeholder-fidelity-limited' } : { reason: 'no-Make_Hash-call' }),
  });
  return { label, sqlText, statements, stages };
}

// ---------------------------------------------------------------------------
// Ordered statement collection: mods in load order, files in listed order,
// statements in file order. Each file is { label, text } or
// { label, filePath } (filePath form exercises the UTF-16 decode path).
// With { preprocess: true } each file runs the task-1.2 pipeline and the
// entry carries per-stage flags; default false keeps the exact 1.1 path.
// A file's optional gate ({ label, text, gate }, with `criteria` accepted
// as an alias) mirrors one ActionCriteria set for task 1.3 and rides along
// on the file entry; files without one are ungated. Gates are evaluated at
// replay time, never here, so collection counts are gate-blind.
// ---------------------------------------------------------------------------

function collectStatements(modSet, { preprocess = false, splitter = 'trigger-aware' } = {}) {
  const ordered = [];
  const files = [];
  let globalIndex = 0;
  modSet.forEach((mod, modIndex) => {
    (mod.files || []).forEach((file, fileIndex) => {
      let text = file.text;
      let encoding = 'inline';
      if (file.filePath) {
        const decoded = readModFile(file.filePath);
        text = decoded.text;
        encoding = decoded.encoding;
      }
      const fileLabel = file.label || (file.filePath ? path.basename(file.filePath) : `file${fileIndex}`);
      let statements;
      let stages = null;
      if (preprocess) {
        const pre = preprocessFile({ label: fileLabel, text: text || '' }, { splitter });
        statements = pre.statements;
        stages = pre.stages;
      } else {
        statements = splitStatements(text || '');
      }
      const entry = {
        modIndex,
        modId: mod.modId,
        fileIndex,
        fileLabel,
        encoding,
        statements,
        stages,
        gate: file.gate !== undefined ? file.gate : (file.criteria !== undefined ? file.criteria : null),
        baseGlobalIndex: globalIndex,
      };
      files.push(entry);
      statements.forEach((sql, stmtIndex) => {
        ordered.push({ ...entry, statements: undefined, stages: undefined, sql, stmtIndex, globalIndex: globalIndex });
        globalIndex += 1;
      });
    });
  });
  return { ordered, files, total: ordered.length };
}

// ---------------------------------------------------------------------------
// Ordered replay with per-file SAVEPOINT abort emulation: the first failing
// statement rolls back only its own file (ROLLBACK TO + RELEASE) and replay
// continues with the next file, so earlier files persist.
//
// Task-1.2 additions: explicit FK mode recorded on the report (PRAGMA
// foreign_keys OFF default, ON comparison mode), and the Make_Hash JS stub
// installed when any collected statement needs it (disable via
// { installStubs: false } to show the without-stub abort).
//
// Task-1.3 addition: optional { gates } context ({ enabled, installed } mod
// id lists, as gateContextOf reads). A file whose gate evaluates to
// willRun=false is skipped-gated — never executed, counted in skippedGated
// and named in gatedOut with its reason. willRun=null (undecidable gate)
// replays normally but is flagged gateUnknown on the per-file record and in
// gatedUnknown. No gates context means no gating at all (the 1.1 path).
//
// Game-setup task 2.2 addition: the gates context may carry `asserted` (the
// assumed-setup store keys). An asserted value satisfying an otherwise
// undecidable gate decides it, flagged assumed: rec.gate carries assumed,
// assumed-satisfied files are named in gatedAssumed, and skipped-gated files
// carry assumed in gatedOut. Undecided files are never flagged.
//
// Task-2.1 addition: optional { provenance: true } installs simonw-style
// history triggers before replay and records (table, pk, column) ->
// (file, statement index) for every committed write. Report carries
// provenance: { writes, collisions } or null when disabled (default off).
// ---------------------------------------------------------------------------
// replay-text-tables change (tasks 1.1, 1.2): environmental localization
// misses plus minimal-schema text replay. Statements targeting localization
// tables (LocalizedText, EnglishText, BaseGameText and *Text kin, unless the
// table was created earlier in this replay) run on a purpose-built empty
// text-schema database in its own temp dir — created lazily, only when a
// text-targeting statement executes, and destroyed with the replay, so the
// live game DB is never touched. Gameplay replay is otherwise unchanged:
//   - a `no such table` miss naming a localization table is environmental,
//     never a finding: the file rolls back like an abort but records status
//     skipped-text, and the report states the skip once
//     (report.textTables: which tables, how many files) instead of
//     per-file rows, so the differential stops drowning in replay-only
//     text noise;
//   - genuine text errors surface normally: bad statements and duplicate
//     keys abort their file; a duplicate key whose earlier writers are all
//     the same mod carries sameMod like collision rows (through the
//     differential, which spreads it; the per-file row stays an abort);
//   - a text-side `no such column` (schema drift: the mod names a column
//     outside Language/Tag/Text/Gender/Plurality) falls back to current
//     behavior: the file replays whole on the gameplay copy and the
//     fallback is recorded — never failing the replay itself;
//   - mixed files replay statement-by-statement on whichever copy owns the
//     target (separable-statements rule); a single statement reading both
//     sides runs on the gameplay copy with a fallback flag, since the
//     minimal schema cannot evaluate cross-side reads;
//   - DDL (CREATE/DROP/ALTER) always runs on the gameplay copy, so a mod
//     shipping its own text table keeps working exactly as before.
// Opt out per replay via { textTables: false } (gameplay copy only, with
// the 1.1 skip-note still applied).
// ---------------------------------------------------------------------------

// Localization tables the gameplay copy never carries: the three named in
// the field (LocalizedText, EnglishText, BaseGameText) and kin —
// localization tables are *Text tables, and the measured gameplay schema
// carries no *Text tables of its own.
const TEXT_TABLE_NAMES = ['LocalizedText', 'EnglishText', 'BaseGameText'];

// Measured text column set (design: Language/Tag/Text/Gender/Plurality as
// measured from the game database). The minimal schema below carries exactly
// these columns with the (Language, Tag) key and no FKs. Payload columns
// stay nullable so the replay never invents NOT NULL failures; the key is
// strict so duplicate tags fail exactly like duplicate keys should.
const TEXT_TABLE_COLUMNS = ['Language', 'Tag', 'Text', 'Gender', 'Plurality'];

// Strip quoting, bracketing, and any schema prefix: [main].[LocalizedText]
// and "LocalizedText" both read as LocalizedText.
function cleanSqlIdent(name) {
  let s = String(name == null ? '' : name).trim();
  const dot = s.lastIndexOf('.');
  if (dot >= 0) s = s.slice(dot + 1);
  return s.replace(/^["'`[]+|["'`\]]+$/g, '');
}

// Intentional breadth: any *Text suffix counts, so a custom *Text typo
// skips as environmental — accepted trade-off per the spec's "and kin".
function isTextTableName(name) {
  const clean = cleanSqlIdent(name);
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (lower === 'localizedtext' || lower === 'englishtext' || lower === 'basegametext') return true;
  return lower.length > 4 && lower.slice(-4) === 'text';
}

// A `no such table` miss naming a localization table is environmental (the
// gameplay copy carries no text tables), never a mod finding. Returns the
// table name as written, or null for any other error.
function textTableMiss(error) {
  const msg = String((error && error.message) || error || '');
  const m = /no such table:\s*["'`[]?([^\s;"'`\]]+)/i.exec(msg);
  if (!m) return null;
  const table = cleanSqlIdent(m[1]);
  return table && isTextTableName(table) ? table : null;
}

// A text-side column miss: { table, column } with table null when the
// message names none. Only text-table misses fall back; anything else is a
// genuine error for the abort path.
function textColumnMiss(error) {
  const msg = String((error && error.message) || error || '');
  let m = /table\s+([^\s]+)\s+has no column named\s+([^\s;]+)/i.exec(msg);
  if (m) return { table: cleanSqlIdent(m[1]), column: cleanSqlIdent(m[2]) };
  m = /no such column:\s*([^\s;]+)/i.exec(msg);
  if (!m) return null;
  const raw = cleanSqlIdent(m[1]);
  const parts = raw.split('.');
  if (parts.length > 1) {
    return { table: parts.slice(0, -1).join('.'), column: parts[parts.length - 1] };
  }
  return { table: null, column: raw };
}

// Table half of a UNIQUE-constraint failure, or null for other errors.
function uniqueMissTable(error) {
  const msg = String((error && error.message) || error || '');
  const m = /UNIQUE constraint failed:\s*([A-Za-z_$][\w$]*)/i.exec(msg);
  if (!m) return null;
  return cleanSqlIdent(m[1].split('.')[0]);
}

// Whether a text-side column miss falls back (unknown column on a
// text-table target) rather than aborting. Bare `no such column: X` (no
// table named) falls back: the statement only targets text tables.
function textColumnFallback(error, targets) {
  const miss = textColumnMiss(error);
  if (!miss) return null;
  if (miss.table && !isTextTableName(miss.table)) return null;
  if (miss.table && !(targets || []).some((t) => String(t).toLowerCase() === String(miss.table).toLowerCase())) {
    return null;
  }
  return miss.column || 'unknown';
}

function textSchemaSql() {
  const cols = 'Language TEXT NOT NULL, Tag TEXT NOT NULL, Text TEXT, Gender TEXT, Plurality TEXT,'
    + ' PRIMARY KEY(Language, Tag)';
  return TEXT_TABLE_NAMES.map((t) => `CREATE TABLE ${t}(${cols});`).join('\n');
}

// Fresh empty text-schema database in its own temp dir: the text leg of the
// temp-copy discipline (created, replayed, path reported, destroyed — never
// the live game DB, of which there is no text copy to take).
function createTextSchemaCopy({ prefix = 'civ6-conflict-replay-text-' } = {}) {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const tempDbPath = path.join(tmpDir, 'DebugLocalization.sqlite');
  const init = new DatabaseSync(tempDbPath);
  try {
    init.exec(textSchemaSql());
  } catch (e) {
    try { init.close(); } finally { destroyTempCopy(tmpDir); }
    throw e;
  }
  init.close();
  return { tmpDir, tempDbPath };
}

// Blank string literals and comments so target extraction never reads SQL
// out of a text value. Quoted identifiers (`.."..`, [..]) keep their inner
// text (those quotes are never string literals); "..." spans keep theirs
// only when identifier-shaped, else they blank like the value-position
// literals the double-quote rewrite exists for. Heuristic, declared: a
// comment marker inside a string literal eats to end-of-line (fails safe
// toward the gameplay copy), and a spaceless "..." literal in a non-target
// position reads bare (harmless outside INTO/FROM/JOIN/UPDATE positions).
function blankSqlLiterals(sqlText) {
  return String(sqlText || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/`((?:``|[^`])*)`/g, (_, inner) => inner.replace(/``/g, '`'))
    .replace(/\[([^\]]*)\]/g, (_, inner) => inner)
    .replace(/"((?:""|[^"])*)"/g, (m, inner) => {
      const unesc = inner.replace(/""/g, '"');
      return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(unesc) ? unesc : '""';
    });
}

const TEXT_TBL_REF = '([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?)';

// Every table a statement reads or writes (deduped, first-seen order).
// Covers the DML the splitter emits; DDL needs no targets (it always runs
// on the gameplay copy).
function stmtTargets(sql) {
  const flat = blankSqlLiterals(sql).replace(/\s+/g, ' ');
  const out = [];
  const push = (raw) => {
    const t = cleanSqlIdent(raw);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  let m;
  const intoRe = new RegExp('\\b(?:INSERT(?:\\s+OR\\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?|REPLACE)\\s+INTO\\s+'
    + TEXT_TBL_REF, 'gi');
  while ((m = intoRe.exec(flat)) !== null) push(m[1]);
  const updRe = new RegExp('\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+' + TEXT_TBL_REF + '(?=\\s+SET\\b)', 'gi');
  while ((m = updRe.exec(flat)) !== null) push(m[1]);
  const delRe = new RegExp('\\bDELETE\\s+FROM\\s+' + TEXT_TBL_REF, 'gi');
  while ((m = delRe.exec(flat)) !== null) push(m[1]);
  const fromRe = new RegExp('\\b(?:FROM|JOIN)\\s+' + TEXT_TBL_REF, 'gi');
  while ((m = fromRe.exec(flat)) !== null) push(m[1]);
  return out;
}

// Which copy owns a statement: 'text' only when every target is a
// localization table the replay has not created on the gameplay copy.
// Anything else (gameplay tables, mod-created tables, target-less
// statements) stays where it has always run.
function routeStatementTargets(targets, gameplayTables) {
  const known = (t) => (gameplayTables || new Set()).has(String(t).toLowerCase());
  const text = (targets || []).filter((t) => isTextTableName(t) && !known(t));
  const game = (targets || []).filter((t) => !isTextTableName(t) || known(t));
  if (text.length > 0 && game.length === 0) return 'text';
  return 'gameplay';
}

const TEXT_CREATE_REF = '("[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_$][\\w$]*)';

function createdTableOf(sql) {
  const m = new RegExp('\\bCREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'
    + TEXT_CREATE_REF, 'i').exec(String(sql || ''));
  return m ? cleanSqlIdent(m[1]).toLowerCase() : null;
}

function droppedTableOf(sql) {
  const m = new RegExp('\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?' + TEXT_CREATE_REF, 'i')
    .exec(String(sql || ''));
  return m ? cleanSqlIdent(m[1]).toLowerCase() : null;
}

// Zero-rows-affected: an UPDATE/DELETE that runs clean but matches nothing
// is flagged, never an error. Shared by both copies: the statement stays
// executed and the file stays committed either way.
function recordZeroRows(conn, sql, file, s, rec, zeroRows) {
  const verb = leadingVerb(sql);
  if (verb !== 'UPDATE' && verb !== 'DELETE') return;
  let affected = null;
  try {
    affected = conn.prepare('SELECT changes() AS n').get().n;
  } catch (_) {
    affected = null;
  }
  if (affected === 0) {
    rec.zeroRows.push(s);
    zeroRows.push({
      modId: file.modId,
      fileLabel: file.fileLabel,
      stmtIndex: s,
      globalIndex: file.baseGlobalIndex + s,
      verb,
      fidelityLimited: ['replay-relative', ...fileLimitationFlags(file.stages)],
    });
  }
}

// ---------------------------------------------------------------------------
// Ordered replay with per-file SAVEPOINT abort emulation (see the
// replay-text-tables notes above for the text leg): the first failing
// statement rolls back only its own file (ROLLBACK TO + RELEASE on every
// copy the file touched) and replay continues with the next file.
// ---------------------------------------------------------------------------

function replayOrdered(tempDbPath, collected, { foreignKeys = false, installStubs = true, gates = null, provenance = false, textTables = true } = {}) {
  assertTempPath(tempDbPath);
  const db = new DatabaseSync(tempDbPath);
  const started = Date.now();
  const perFile = [];
  const fkMode = foreignKeys ? 'ON' : 'OFF';
  let makeHashStub = 'skipped';
  let makeHashStubReason = 'no-Make_Hash-call';
  let executed = 0;
  let rolledBack = 0;
  let skippedGated = 0;
  const gatedOut = [];
  const gatedUnknown = [];
  const gatedAssumed = [];
  const zeroRows = [];
  const gateCtx = gates ? gateContextOf(gates) : null;
  const provInstalled = new Set();
  let provWriters = null;
  let provCollisions = null;
  // Text leg (replay-text-tables 1.1/1.2): tables the gameplay copy carries
  // (seeded from its schema, plus every table DDL creates there as the
  // replay runs) route gameplay-side even when *Text-named, so a mod
  // shipping its own text table replays exactly as before.
  const gameplayTables = new Set(listUserTables(db).map((t) => String(t).toLowerCase()));
  let textDb = null;
  let textTmp = null;
  const textWriters = new Map();
  const skippedTextTables = new Map();
  let skippedTextFiles = 0;
  let routedTextFiles = 0;
  const textFallback = [];
  try {
    db.exec(`PRAGMA foreign_keys=${fkMode}`);
    if (provenance) {
      ensureProvenanceSchema(db);
      installProvenanceTriggers(db, provInstalled);
    }
    const allStmts = (collected.files || []).flatMap((f) => f.statements || []);
    if (needsMakeHash(allStmts)) {
      if (installStubs) {
        installMakeHashStub(db);
        makeHashStub = 'installed';
        makeHashStubReason = null;
      } else {
        makeHashStubReason = 'stub-disabled';
      }
    }
    const textHashNeeded = needsMakeHash(allStmts);
    collected.files.forEach((file, i) => {
      const sp = `cr_file_${i}`;
      const rec = {
        modId: file.modId,
        fileLabel: file.fileLabel,
        statements: file.statements.length,
        executed: 0,
        status: 'committed',
        error: null,
        failedAt: null,
        zeroRows: [],
        routed: 'gameplay',
      };
      // Task 2.1: pick up tables created by earlier files. Runs outside the
      // per-file SAVEPOINT so the triggers persist like the tables do.
      if (provenance) installProvenanceTriggers(db, provInstalled);
      // Task 1.3: gate check before any statement runs. Gated-out files are
      // skipped here — no SAVEPOINT, no execution — so their writes can never
      // land or collide. Undecidable gates replay but stay flagged.
      const verdict = gateCtx ? evaluateGate(file.gate || null, gateCtx) : null;
      if (verdict) {
        rec.gate = { willRun: verdict.willRun, reason: verdict.reason, assumed: !!verdict.assumed };
        if (verdict.willRun === false) {
          rec.status = 'skipped-gated';
          skippedGated += file.statements.length;
          gatedOut.push({
            modId: file.modId,
            fileLabel: file.fileLabel,
            statements: file.statements.length,
            reason: verdict.reason,
            assumed: !!verdict.assumed,
          });
          perFile.push(rec);
          return;
        }
        if (verdict.willRun === null) {
          rec.gateUnknown = true;
          gatedUnknown.push({
            modId: file.modId,
            fileLabel: file.fileLabel,
            statements: file.statements.length,
            reason: 'gate-undecidable-here',
            unknown: verdict.unknown,
          });
        }
        // An assumed-satisfied gate replays like a measured one but is named
        // in gatedAssumed, never as measured.
        if (verdict.willRun === true && verdict.assumed) {
          gatedAssumed.push({
            modId: file.modId,
            fileLabel: file.fileLabel,
            statements: file.statements.length,
          });
        }
      }
      db.exec(`SAVEPOINT "${sp}"`);
      const provSnapshot = new Set(provInstalled);
      const zrMark = zeroRows.length;
      let tSp = null;
      let touchedText = false;
      let touchedGame = false;
      let forceGameplay = false;
      let fileFallback = null;
      const liveTextTables = new Set();
      const flagFallback = (reason) => {
        if (fileFallback) return;
        fileFallback = reason;
        textFallback.push({ modId: file.modId, fileLabel: file.fileLabel, reason });
      };
      const ensureText = () => {
        if (!textDb) {
          textTmp = createTextSchemaCopy();
          assertTempPath(textTmp.tempDbPath);
          textDb = new DatabaseSync(textTmp.tempDbPath);
          textDb.exec(`PRAGMA foreign_keys=${fkMode}`);
          if (textHashNeeded && installStubs) installMakeHashStub(textDb);
        }
        if (!tSp) {
          tSp = `cr_text_${i}`;
          textDb.exec(`SAVEPOINT "${tSp}"`);
        }
      };
      let failed = false;
      for (let s = 0; s < file.statements.length; s += 1) {
        const sql = file.statements[s];
        const verb = leadingVerb(sql);
        const ddl = verb === 'CREATE' || verb === 'DROP' || verb === 'ALTER';
        let targets = [];
        let side = 'gameplay';
        if (textTables && !forceGameplay && !ddl && verb) {
          targets = stmtTargets(sql);
          side = routeStatementTargets(targets, gameplayTables);
          if (side === 'gameplay'
            && targets.some((t) => isTextTableName(t) && !gameplayTables.has(t.toLowerCase()))) {
            // One statement reading both sides: the minimal schema cannot
            // evaluate cross-side reads, so it runs where it always has,
            // flagged. (Separable-statements rule, non-separable case.)
            flagFallback('cross-side-statement-uses-text-and-gameplay-tables');
          }
        }
        try {
          if (side === 'text') {
            ensureText();
            textDb.exec(sql);
            touchedText = true;
            for (const t of targets) {
              if (isTextTableName(t)) liveTextTables.add(t.toLowerCase());
            }
            rec.executed += 1;
            executed += 1;
            recordZeroRows(textDb, sql, file, s, rec, zeroRows);
          } else {
            if (provenance) {
              setProvenanceWriter(db, {
                modId: file.modId,
                fileLabel: file.fileLabel,
                stmtIndex: s,
                globalIndex: file.baseGlobalIndex + s,
              });
            }
            db.exec(sql);
            touchedGame = true;
            rec.executed += 1;
            executed += 1;
            // Zero-rows-affected: an UPDATE/DELETE that runs clean but
            // matches nothing is flagged, never an error — the statement
            // stays executed and the file stays committed. SELECT changes()
            // reflects the statement's own row count (trigger sub-statements
            // excluded), so this reads correctly with provenance triggers
            // installed too. Fidelity-limited by construction: zero rows
            // matched in THIS replay, whose order, gates, and earlier aborts
            // may differ from the game's, hence the replay-relative flag on
            // every finding.
            recordZeroRows(db, sql, file, s, rec, zeroRows);
            if (verb === 'CREATE') {
              const created = createdTableOf(sql);
              if (created) gameplayTables.add(created);
            } else if (verb === 'DROP') {
              const dropped = droppedTableOf(sql);
              if (dropped) gameplayTables.delete(dropped);
            }
            // Task 2.1: tables born mid-file need triggers for later
            // statements in the same file. Installed inside the SAVEPOINT so
            // a later abort removes table and triggers together.
            if (provenance && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TABLE\b/i.test(sql)) {
              installProvenanceTriggers(db, provInstalled);
            }
          }
        } catch (e) {
          if (!forceGameplay && side === 'text') {
            const fallbackColumn = textColumnFallback(e, targets);
            if (fallbackColumn) {
              // Schema drift (a column outside the minimal set): roll both
              // copies back and replay the whole file on the gameplay copy
              // (current behavior), flagged. Never fails the replay itself.
              flagFallback(`unknown-column:${fallbackColumn}`);
              db.exec(`ROLLBACK TO "${sp}"`);
              if (tSp) textDb.exec(`ROLLBACK TO "${tSp}"`);
              rolledBack += rec.executed;
              executed -= rec.executed;
              rec.executed = 0;
              rec.zeroRows.length = 0;
              zeroRows.length = zrMark;
              liveTextTables.clear();
              forceGameplay = true;
              s = -1;
              continue;
            }
          }
          const miss = textTableMiss(e);
          if (miss) {
            // 1.1: environmental localization miss (on either copy — the
            // minimal schema carries only the three named tables, so *Text
            // kin misses there too). Rolls back like an abort but records
            // skipped-text: no per-file row, aggregated into the once-per-
            // replay note instead.
            rec.status = 'skipped-text';
            rec.error = e.message;
            rec.failedAt = file.baseGlobalIndex + s;
            rolledBack += rec.executed;
            executed -= rec.executed;
            rec.executed = 0;
            skippedTextFiles += 1;
            if (!skippedTextTables.has(miss.toLowerCase())) skippedTextTables.set(miss.toLowerCase(), miss);
            failed = true;
            break;
          }
          if (side === 'text') {
            // 1.2: duplicate text keys abort their file like any genuine
            // error. Same-mod layering (every earlier writer of the key's
            // table is this mod — the text copy starts empty, so the
            // conflicting row can only come from an earlier committed file
            // or this file's own rolled-back statements) carries sameMod
            // like collision rows; cross-mod stays untagged and surfaces
            // normally. Table-level and conservative by design: it tags only
            // when no other mod has touched the table.
            const dupTable = uniqueMissTable(e);
            if (dupTable) {
              const writers = textWriters.get(dupTable.toLowerCase()) || new Set();
              if ([...writers].every((m) => m === file.modId)) rec.sameMod = true;
            }
          }
          rec.status = 'aborted';
          rec.error = e.message;
          rec.failedAt = file.baseGlobalIndex + s;
          rolledBack += rec.executed;
          executed -= rec.executed;
          rec.executed = 0;
          failed = true;
          break;
        }
      }
      if (failed) db.exec(`ROLLBACK TO "${sp}"`);
      if (failed && provenance) {
        // Triggers born inside the rolled-back file are gone with its
        // tables; forget them so a later file recreates them.
        provInstalled.clear();
        provSnapshot.forEach((t) => provInstalled.add(t));
      }
      db.exec(`RELEASE "${sp}"`);
      if (tSp) {
        if (failed) textDb.exec(`ROLLBACK TO "${tSp}"`);
        textDb.exec(`RELEASE "${tSp}"`);
      }
      if (!failed) {
        for (const t of liveTextTables) {
          if (!textWriters.has(t)) textWriters.set(t, new Set());
          textWriters.get(t).add(file.modId);
        }
      }
      // Files whose final replay touched the text copy count as routed;
      // fallbacks belong to the fallback list (their final replay ran on
      // the gameplay copy), whatever they attempted first.
      if (touchedText && !fileFallback) routedTextFiles += 1;
      rec.routed = fileFallback ? 'fallback' : (touchedText ? (touchedGame ? 'split' : 'text') : 'gameplay');
      perFile.push(rec);
    });
    if (provenance) {
      provWriters = readProvenanceWrites(db);
      provCollisions = buildCollisions(provWriters, collected);
    }
  } finally {
    db.close();
    if (textDb) {
      try { textDb.close(); } finally { destroyTempCopy(textTmp.tmpDir); }
    }
  }
  const wallMs = Date.now() - started;
  const skippedTables = [...skippedTextTables.values()]
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  const textNote = skippedTables.length > 0
    ? `skipped ${skippedTextFiles} text file(s) naming tables the gameplay copy does not carry`
      + ` (${skippedTables.join(', ')}): environmental misses, stated once here instead of per file`
    : null;
  return {
    tempDbPath,
    total: collected.total,
    executed,
    rolledBack,
    skippedGated,
    gatedOut,
    gatedUnknown,
    gatedAssumed,
    zeroRows,
    perFile,
    wallMs,
    stmtsPerSec: wallMs > 0 ? Math.round((executed / wallMs) * 1000) : executed,
    fkMode,
    makeHashStub,
    makeHashStubReason,
    provenance: provenance ? { writes: provWriters, collisions: provCollisions } : null,
    textTables: {
      note: textNote,
      tables: skippedTables,
      files: skippedTextFiles,
      routed: routedTextFiles,
      textDbPath: textTmp ? textTmp.tempDbPath : null,
      fallback: textFallback,
    },
  };
}

// ---------------------------------------------------------------------------
// --check: fixture with one failing file proves counts + per-file rollback.
// (Task 1.1, unchanged.)
// ---------------------------------------------------------------------------

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ---------------------------------------------------------------------------
// Reviewer WARNING 1: locked live DB. holdLiveExclusiveForCopy keeps a BEGIN
// EXCLUSIVE transaction open on the fixture live DB plus an open write
// handle (fs r+), emulating the game holding DebugGameplay.sqlite while the
// conflict replay runs. Scratch fixtures only, never a real game DB.
// ---------------------------------------------------------------------------

function holdLiveExclusiveForCopy(liveDbPath) {
  const holder = new DatabaseSync(liveDbPath);
  holder.exec('BEGIN EXCLUSIVE;');
  const fd = fs.openSync(liveDbPath, 'r+');
  return {
    release() {
      try { holder.exec('ROLLBACK'); } finally {
        try { holder.close(); } finally { fs.closeSync(fd); }
      }
    },
  };
}

// lockedCopyTrial replays the same mod set once unlocked (baseline) and
// once while the live DB is held exclusive, so callers can assert the
// locked copy+report still succeed, findings match, and the live file is
// byte-identical afterwards. The fixture must seed LockCheck(Id, Value).
function lockedCopyTrial(liveDbPath, modSet) {
  const collected = collectStatements(modSet);
  const readIds = (dbPath) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare('SELECT Id, Value FROM LockCheck ORDER BY Id').all(); }
    finally { db.close(); }
  };
  const summarize = (report, tempDb) => ({
    total: report.total,
    executed: report.executed,
    rolledBack: report.rolledBack,
    statuses: report.perFile.map((f) => `${f.modId}/${f.fileLabel}:${f.status}`),
    failedAt: report.perFile.map((f) => f.failedAt),
    rows: readIds(tempDb),
  });
  const liveBefore = sha256(liveDbPath);
  const base = createTempCopy(liveDbPath);
  let baseline;
  try { baseline = summarize(replayOrdered(base.tempDbPath, collected), base.tempDbPath); }
  finally { destroyTempCopy(base.tmpDir); }
  const hold = holdLiveExclusiveForCopy(liveDbPath);
  let locked = null;
  let copyError = null;
  let live = null;
  try {
    live = createTempCopy(liveDbPath);
    locked = summarize(replayOrdered(live.tempDbPath, collected), live.tempDbPath);
  } catch (e) { copyError = e; }
  finally { if (live) destroyTempCopy(live.tmpDir); hold.release(); }
  return { collected, baseline, locked, copyError, liveBefore, liveAfter: sha256(liveDbPath) };
}

// ---------------------------------------------------------------------------
// Task 1.3: criteria gating evaluation (ActionCriteria) with
// skipped-with-reason reporting. Gated-out actions are skipped (never
// replayed) and reported with their reason; gated-in actions replay
// normally; gates this harness cannot read replay normally but are flagged
// gate-unknown, never silently treated as decided.
//
// Gate model: one gate mirrors one ActionCriteria set:
//   { any: false, conditions: [{ type, value, inverse }] }
// attached per file as file.gate (file.criteria accepted as an alias) and
// carried through collectStatements onto the file entry. An absent gate, or
// a gate with no conditions, is ungated and replays. The evaluation context
// mirrors the profile read in loadorder.js:
//   { enabled: [modIds on in the profile], installed: [modIds present] }
// Only ModInUse / ModIsEnabled are decidable here (measured in
// loadorder.js: ModInUse is scoped to the active profile, like
// ModIsEnabled). Every other criterion type is unknown, with a per-type
// reason in the same shape as unreadableWhy. Any=true is OR, Any=false
// (default) is AND, combined three-valued exactly like verdictOf: one unmet
// defeats AND, one met carries OR, and anything left undecided stays null
// with its unknown list attached.
// ---------------------------------------------------------------------------

const GATE_DECIDABLE = new Set(['ModInUse', 'ModIsEnabled']);

// Comparison key for mod ids in gates: lowercase, brace-stripped, trimmed.
// Local (no modinfo import) so this library stays free of the view/store
// stack: zero project imports, so the server and the phase wrapper can both
// require it without a require cycle (see tests/arch.test.js).
function normGateId(id) {
  return String(id == null ? '' : id).replace(/[{}]/g, '').trim().toLowerCase();
}

function gateSetOf(list) {
  const arr = list instanceof Set ? [...list]
    : list instanceof Map ? [...list.keys()]
      : (list || []);
  const out = new Set();
  for (const v of arr) {
    const k = normGateId(v);
    if (k) out.add(k);
  }
  return out;
}

function gateContextOf(ctx) {
  const c = ctx || {};
  return {
    enabled: gateSetOf(c.enabled),
    installed: gateSetOf(c.installed),
    asserted: c.asserted !== undefined ? c.asserted : null,
  };
}

// Why a condition cannot be read here, in checkable words (same shape as
// unreadableWhy in gates.js; shortened, with no display-name lookup).
function gateUnreadableWhy(cond) {
  const v = cond.value;
  switch (cond.type) {
    case 'ConfigurationValueMatches':
      return `needs a game option to be ${v} - a game option picked in the main menu, so it is not known until the game starts`;
    case 'RuleSetInUse':
      return `needs the ${v} ruleset - you choose the ruleset when you start a game, so replay cannot see it`;
    case 'GameCoreInUse':
      return `needs the ${v} game core - that is a matter of which DLC is installed`;
    case 'LeaderPlayable':
      return `needs ${v} to be playable - which depends on who is in the game, not on the profile`;
    default:
      return `depends on ${cond.type}, which replay cannot see`;
  }
}

// Assumed-setup keys for one gate condition, kept in sync with setupKeysFor
// in gates.js by contract (this library stays free of the view/store stack).
// KIND:<Value>, the Configuration triple, and the GAMEMODE:<id> shorthand
// yield keys; anything else yields no key: never guessed (see ADR-004).
// Comma lists read as OR, mirroring the view and the catalog.
function gateCommaSingles(value) {
  return String(value == null ? '' : value).split(',').map((s) => s.trim()).filter((s) => s);
}

function gateLeaderTail(single) {
  const s = String(single == null ? '' : single).trim();
  if (!s) return '';
  return s.includes('::') ? s.slice(s.lastIndexOf('::') + 2).trim() : s;
}

function gateSetupKeysFor(cond) {
  const c = cond || {};
  if (c.type === 'RuleSetInUse' || c.type === 'GameCoreInUse' || c.type === 'LeaderPlayable') {
    const kind = c.type === 'RuleSetInUse' ? 'RULESET' : c.type === 'GameCoreInUse' ? 'CORE' : 'LEADER';
    const out = [];
    for (const s of gateCommaSingles(c.value)) {
      const single = c.type === 'LeaderPlayable' ? gateLeaderTail(s) : s;
      if (!single) continue;
      out.push(`${kind}:${single}`);
    }
    return [...new Set(out)];
  }
  if (c.type === 'ConfigurationValueMatches') {
    const p = (c.props && typeof c.props === 'object') ? c.props : {};
    const pick = (k) => (p[k] != null ? p[k] : c[k]);
    const g = String(pick('Group') == null ? '' : pick('Group')).trim();
    const cid = String(pick('ConfigurationId') == null ? '' : pick('ConfigurationId')).trim();
    if (!g || !cid) return [];
    const out = [];
    for (const single of gateCommaSingles(pick('Value'))) {
      out.push(`CONFIG:${g}/${cid}=${single}`);
      if (single === '1' && (g === 'Game' || cid.startsWith('GAMEMODE_'))) out.push(`GAMEMODE:${cid}`);
    }
    return [...new Set(out)];
  }
  return [];
}

// Whether an asserted store holds a key satisfying this condition. Accepts a
// key array, a Set, a raw asserted map, or a readSetup view, mirroring
// isAsserted in gamesetup.js without importing it. Null or empty asserts
// nothing; junk answers false, never throws.
function gateIsAsserted(asserted, key) {
  if (!asserted) return false;
  if (asserted instanceof Set) return asserted.has(key);
  if (Array.isArray(asserted)) return asserted.includes(key);
  const map = asserted.asserted && typeof asserted.asserted === 'object' ? asserted.asserted : asserted;
  return !!map && typeof map === 'object' && map[key] === true;
}

function gateAssumedMatch(cond, asserted) {
  if (!asserted) return false;
  const keys = gateSetupKeysFor(cond);
  if (!keys.length) return false;
  return keys.some((k) => {
    try { return gateIsAsserted(asserted, k); } catch (_) { return false; }
  });
}

// One condition, three ways: satisfied, not satisfied, or not readable here.
// Matches evalCondition in gates.js by contract, including the
// inverted-absence rule (NOT ModInUse(absent-mod) is satisfied) and never
// guessing.
function evalGateCondition(cond, ctx) {
  const c = cond || {};
  if (!GATE_DECIDABLE.has(c.type)) {
    // Assumed game setup (game-setup task 2.2), read-only: a matching
    // assertion satisfies the condition, flagged assumed so the verdict can
    // label it. Anything else stays undecidable with byte-identical wording,
    // so measured verdicts never move when nothing is asserted.
    if (ctx && ctx.asserted && gateAssumedMatch(c, ctx.asserted)) {
      return c.inverse
        ? { sat: false, needs: gateUnreadableWhy(c), assumed: true }
        : { sat: true, needs: null, assumed: true };
    }
    return { sat: null, needs: gateUnreadableWhy(c), assumed: false };
  }
  const target = normGateId(c.value);
  if (!ctx.installed.has(target)) {
    return c.inverse
      ? { sat: true, needs: null, assumed: false }
      : { sat: false, needs: `needs ${c.value}, which is not installed`, assumed: false };
  }
  const on = ctx.enabled.has(target);
  return {
    sat: c.inverse ? !on : on,
    needs: c.inverse
      ? `needs ${c.value} to be off in this profile`
      : `needs ${c.value} to be on in this profile`,
    assumed: false,
  };
}

// One gate set to a verdict: { willRun, reason, unknown, assumed }. Absent gate or
// no conditions means ungated (willRun true), matching verdictOf.
function evaluateGate(gate, ctx) {
  const items = (gate && gate.conditions) || [];
  if (items.length === 0) return { willRun: true, reason: null, unknown: [], assumed: false };
  const context = ctx && ctx.enabled instanceof Set ? ctx : gateContextOf(ctx);
  const unknown = [];
  const unmet = [];
  let read = 0;
  let met = 0;
  let metAssumed = 0;
  let metMeasured = 0;
  let unmetAssumed = 0;
  let unmetMeasured = 0;
  for (const cond of items) {
    const r = evalGateCondition(cond, context);
    if (r.sat === null) { unknown.push({ type: cond.type, why: r.needs }); continue; }
    read += 1;
    if (r.sat) {
      met += 1;
      if (r.assumed) metAssumed += 1;
      else metMeasured += 1;
    } else {
      unmet.push(r.needs);
      if (r.assumed) unmetAssumed += 1;
      else unmetMeasured += 1;
    }
  }
  const any = !!(gate && gate.any);
  let willRun = null;
  if (any) {
    if (met > 0) willRun = true;
    else if (read > 0 && unknown.length === 0) willRun = false;
  } else {
    if (unmet.length > 0) willRun = false;
    else if (read > 0 && unknown.length === 0) willRun = true;
  }
  // Assumed verdicts match verdictOf in gates.js by contract: true only where
  // removing the assertions would leave a different willRun. Undecided rows
  // are never flagged: fewer unknowns is not running.
  let assumed = false;
  if (willRun === true) {
    assumed = any ? (metAssumed > 0 && metMeasured === 0) : metAssumed > 0;
  } else if (willRun === false) {
    assumed = any ? unmetAssumed > 0 : (unmetAssumed > 0 && unmetMeasured === 0);
  }
  if (willRun === true) return { willRun: true, reason: null, unknown, assumed };
  if (willRun === false) return { willRun: false, reason: unmet.join('; ') || 'a condition is not met', unknown, assumed };
  return { willRun: null, reason: null, unknown, assumed: false };
}

// ---------------------------------------------------------------------------
// Task 2.1: history-trigger provenance (simonw-style). One AFTER INSERT
// trigger per table logs every column; one AFTER UPDATE OF trigger per
// column logs exactly that column. UPDATE OF fires on assignment even when
// the value is unchanged, so two files writing identical values still
// produce two provenance rows (post-hoc diffing would miss that). The
// current writer lives in _cr_writer (one row, id=1); replay sets it before
// each statement and triggers copy it into _cr_provenance. Both tables are
// _cr_-prefixed so trigger installation skips them; provenance rows written
// inside a per-file SAVEPOINT roll back with the file, matching abort
// semantics. Temp copies only, like everything else here.
// ---------------------------------------------------------------------------

function qIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function qLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function listUserTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return rows.map((r) => r.name).filter((n) => n !== undefined
    && !n.startsWith('sqlite_') && !n.startsWith('_cr_'));
}

function getTableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${qIdent(table)})`).all();
}

function tableIsWithoutRowid(db, table) {
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table);
  return !!row && !!row.sql && /WITHOUT\s+ROWID/i.test(row.sql);
}

function pkExprNew(pkCols, fallbackCols) {
  const cast = (c) => `COALESCE(CAST(NEW.${qIdent(c)} AS TEXT), 'NULL')`;
  if (pkCols.length === 1) return cast(pkCols[0]);
  if (pkCols.length > 1) return pkCols.map(cast).join(" || '|' || ");
  if (fallbackCols && fallbackCols.length > 0) return fallbackCols.map(cast).join(" || '|' || ");
  return 'CAST(NEW.rowid AS TEXT)';
}

function ensureProvenanceSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS "_cr_provenance"('
    + 'seq INTEGER PRIMARY KEY AUTOINCREMENT, '
    + 'tbl TEXT NOT NULL, pk TEXT, col TEXT NOT NULL, '
    + 'modId TEXT, fileLabel TEXT, stmtIndex INTEGER, globalIndex INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS "_cr_writer"('
    + 'id INTEGER PRIMARY KEY CHECK(id = 1), '
    + 'modId TEXT, fileLabel TEXT, stmtIndex INTEGER, globalIndex INTEGER)');
  db.exec('INSERT OR IGNORE INTO "_cr_writer"(id) VALUES(1)');
}

function installProvenanceTriggers(db, installed) {
  const tables = listUserTables(db);
  for (const table of tables) {
    if (installed.has(table)) continue;
    const cols = getTableColumns(db, table);
    if (cols.length === 0) { installed.add(table); continue; }
    const pkCols = cols.filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const useRowid = pkCols.length === 0 && !tableIsWithoutRowid(db, table);
    const pkE = useRowid ? 'CAST(NEW.rowid AS TEXT)'
      : pkExprNew(pkCols, cols.map((c) => c.name));
    const provCols = '(tbl, pk, col, modId, fileLabel, stmtIndex, globalIndex)';
    const insBody = cols.map((c) => 'INSERT INTO "_cr_provenance"'
      + `${provCols} SELECT ${qLit(table)}, ${pkE}, ${qLit(c.name)}, `
      + 'w.modId, w.fileLabel, w.stmtIndex, w.globalIndex '
      + 'FROM "_cr_writer" w WHERE w.id = 1;').join(' ');
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${qIdent(`_cr_ins__${table}`)} `
      + `AFTER INSERT ON ${qIdent(table)} BEGIN ${insBody} END;`);
    for (const c of cols) {
      const one = 'INSERT INTO "_cr_provenance"'
        + `${provCols} SELECT ${qLit(table)}, ${pkE}, ${qLit(c.name)}, `
        + 'w.modId, w.fileLabel, w.stmtIndex, w.globalIndex '
        + 'FROM "_cr_writer" w WHERE w.id = 1;';
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${qIdent(`_cr_upd__${table}__${c.name}`)} `
        + `AFTER UPDATE OF ${qIdent(c.name)} ON ${qIdent(table)} `
        + `BEGIN ${one} END;`);
    }
    installed.add(table);
  }
}

function setProvenanceWriter(db, writer) {
  db.prepare('UPDATE "_cr_writer" SET modId = ?, fileLabel = ?, stmtIndex = ?, globalIndex = ? WHERE id = 1')
    .run(writer.modId, writer.fileLabel, writer.stmtIndex, writer.globalIndex);
}

function readProvenanceWrites(db) {
  return db.prepare('SELECT seq, tbl AS "table", pk, col AS "column", '
    + 'modId, fileLabel, stmtIndex, globalIndex '
    + 'FROM "_cr_provenance" ORDER BY globalIndex, seq').all();
}

// Per-file fidelity limitations feeding collision flags: only stages that
// actually transformed (or installed the stub) limit fidelity. Splitter
// kept-whole is heuristic handling, so it flags too.
function fileLimitationFlags(stages) {
  const out = [];
  for (const s of stages || []) {
    if (s.stage === 'xml-to-sql' && s.outcome === 'transformed') out.push('xml-to-sql');
    else if (s.stage === 'double-quote-rewrite' && s.outcome === 'transformed') out.push('double-quoted-string-rewrite');
    else if (s.stage === 'make-hash-stub' && s.outcome === 'installed-at-replay') out.push('make-hash-stub');
    else if (s.stage === 'splitter' && s.outcome === 'transformed') out.push('trigger-aware-splitter');
  }
  return out;
}

// Group provenance rows by cell; cells with >=2 distinct writing statements
// are contested. Winner is the last writer in replay order; losers are the
// earlier writers in replay order. Single-writer cells carry no collision.
function buildCollisions(provWrites, collected) {
  const byCell = new Map();
  for (const w of provWrites || []) {
    const key = `${w.table}\x1f${w.pk}\x1f${w.column}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(w);
  }
  const fileByWriter = new Map();
  for (const f of (collected && collected.files) || []) {
    for (let s = 0; s < (f.statements || []).length; s += 1) {
      fileByWriter.set(`${f.modId}\x1f${f.fileLabel}\x1f${s}`, f);
    }
  }
  const collisions = [];
  for (const rows of byCell.values()) {
    const ordered = [...rows].sort((a, b) => (a.globalIndex - b.globalIndex) || (a.seq - b.seq));
    const seen = new Map();
    for (const w of ordered) {
      if (!seen.has(w.globalIndex)) seen.set(w.globalIndex, w);
    }
    if (seen.size < 2) continue;
    const writers = [...seen.values()];
    const winner = writers[writers.length - 1];
    const losers = writers.slice(0, -1);
    const flagSet = new Set();
    for (const w of writers) {
      const f = fileByWriter.get(`${w.modId}\x1f${w.fileLabel}\x1f${w.stmtIndex}`);
      for (const flag of fileLimitationFlags(f && f.stages)) flagSet.add(flag);
    }
    collisions.push({
      table: ordered[0].table,
      pk: ordered[0].pk,
      column: ordered[0].column,
      winner: {
        modId: winner.modId,
        fileLabel: winner.fileLabel,
        stmtIndex: winner.stmtIndex,
        globalIndex: winner.globalIndex,
      },
      losers: losers.map((w) => ({
        modId: w.modId,
        fileLabel: w.fileLabel,
        stmtIndex: w.stmtIndex,
        globalIndex: w.globalIndex,
      })),
      writes: writers.length,
      fidelityLimited: [...flagSet],
    });
  }
  collisions.sort((a, b) => (a.winner.globalIndex - b.winner.globalIndex)
    || (a.table < b.table ? -1 : a.table > b.table ? 1 : 0)
    || (String(a.pk) < String(b.pk) ? -1 : String(a.pk) > String(b.pk) ? 1 : 0)
    || (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
  return collisions;
}

function formatCollision(c) {
  const who = (w) => `${w.modId}/${w.fileLabel}#${w.stmtIndex} (global ${w.globalIndex})`;
  const losers = c.losers.map(who).join(', ');
  const flag = c.fidelityLimited.length ? ` [fidelity-limited: ${c.fidelityLimited.join(',')}]` : '';
  return `${c.table} pk=${c.pk} col=${c.column} writes=${c.writes} `
    + `winner=${who(c.winner)} losers=[${losers}]${flag}`;
}

// The leading SQL verb of a statement (UPDATE, DELETE, INSERT, ...), skipping
// leading whitespace and -- / * * / comments the splitter keeps. Null when
// there is no leading word. Only UPDATE/DELETE feed the zero-rows flag.
function leadingVerb(sql) {
  let s = String(sql == null ? '' : sql);
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      if (nl < 0) return null;
      s = s.slice(nl + 1);
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end < 0) return null;
      s = s.slice(end + 2);
      continue;
    }
    break;
  }
  const m = /^[A-Za-z]+/.exec(s);
  return m ? m[0].toUpperCase() : null;
}

function formatZeroRows(z) {
  const flag = z.fidelityLimited.length ? ` [fidelity-limited: ${z.fidelityLimited.join(',')}]` : '';
  return `${z.verb} ${z.modId}/${z.fileLabel}#${z.stmtIndex} (global ${z.globalIndex}) matched no rows${flag}`;
}

// ---------------------------------------------------------------------------
// Task 2.2: Database.log differential validation. parseDatabaseLog reads
// Database.log-format text into error entries { line, text, message,
// fileHint, stmtHint }: only lines containing ERROR count, leading
// [timestamp] / [tag] prefixes strip to a message, a *.sql/*.xml token is
// the file hint, and a statement/stmt N token is the statement hint.
//
// Log-pairing 1.1 (additive): each ERROR also joins its same-timestamp
// non-ERROR context lines -- the executing statement ("While executing -
// '...'"), the row values ("... with values (...)"), and the source file
// ("from file <path>", usually a workshop path carrying its Steam ID) --
// into { statement, values, sourcePath, workshopId }. An ERROR with no
// same-timestamp context lines keeps today's single-line shape (all four
// null), so existing differential behavior is unchanged.
// ---------------------------------------------------------------------------

// Leading [timestamp] tag of a Database.log line; the join key for 1.1.
function dbTimestampOf(raw) {
  const m = /^\s*(\[[^\]]*\])/.exec(String(raw == null ? '' : raw));
  return m ? m[1] : null;
}

// Fold one same-timestamp context line into the attribution accumulator.
// First match per field wins across the timestamp group. Shapes measured
// on real logs (synthetic values in fixtures, never real paths).
function foldDbContextLine(text, acc) {
  let m = /while\s+executing\s*[-–:]\s*(.+?)\s*$/i.exec(text);
  if (m && acc.statement == null) {
    const stmt = m[1].replace(/^['"]/, '').replace(/['"]\s*[.,;]?\s*$/, '').trim();
    if (stmt) acc.statement = stmt;
  }
  m = /with\s+values\s*(.+?)\s*$/i.exec(text);
  if (m && acc.values == null) {
    let v = m[1].trim();
    if (!/\)$/.test(v)) v = v.replace(/[.,;]+$/, '').trim();
    if (v) acc.values = v;
  }
  m = /from\s+file\s+(.+?)\s*$/i.exec(text);
  if (m && acc.sourcePath == null) {
    const p = m[1].trim().replace(/^['"]/, '').replace(/['"\s.,;]+$/, '');
    if (p) {
      acc.sourcePath = p;
      const w = /workshop\/content\/\d+\/(\d+)/i.exec(p);
      if (w) acc.workshopId = w[1];
    }
  }
  return acc;
}

function parseDatabaseLog(logText) {
  const lines = String(logText == null ? '' : logText).split(/\r?\n/);
  // First pass: index non-ERROR context lines by leading timestamp tag.
  const contextByTs = new Map();
  lines.forEach((raw) => {
    if (/ERROR/i.test(raw)) return;
    const ts = dbTimestampOf(raw);
    if (!ts) return;
    const text = raw.trim();
    if (!text) return;
    if (!contextByTs.has(ts)) contextByTs.set(ts, []);
    contextByTs.get(ts).push(text);
  });
  const entries = [];
  lines.forEach((raw, i) => {
    if (!/ERROR/i.test(raw)) return;
    const text = raw.trim();
    if (!text) return;
    const message = text.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim();
    const fileM = /([\w][\w.\-]*\.(?:sql|xml))\b/i.exec(text);
    const stmtM = /(?:statement|stmt)\s*#?\s*(\d+)/i.exec(text);
    // Same-timestamp siblings only; none shared means today's shape.
    const acc = { statement: null, values: null, sourcePath: null, workshopId: null };
    const ts = dbTimestampOf(raw);
    const siblings = (ts && contextByTs.get(ts)) || [];
    siblings.forEach((sib) => foldDbContextLine(sib, acc));
    entries.push({
      line: i + 1,
      text,
      message,
      fileHint: fileM ? fileM[1] : null,
      stmtHint: stmtM ? Number(stmtM[1]) : null,
      statement: acc.statement,
      values: acc.values,
      sourcePath: acc.sourcePath,
      workshopId: acc.workshopId,
    });
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Log-pairing 1.2: workshop/local/base source mapping. Pure functions over
// the attributed entries from parseDatabaseLog: no filesystem access, the
// caller supplies the folder map (built server-side from scanMods plus
// resolved folders). Every entry yields an attribution stating its outcome;
// unmapped paths are reported, never silently dropped.
//
// Folder map shape:
//   { workshop: { [workshopId]: { modId, name? } | 'modId-string' },
//     local: [{ folder, modId, name? }] or
//            { [folderOrPrefix]: { modId, name? } | 'modId-string' } }
// A local folder is either a bare mod-folder name (matched as a /Mods/<name>/
// path segment) or an absolute mod-folder prefix (matched case-insensitively
// after slash normalization). Base-game/DLC paths need no map entry: a
// normalized path carrying a /base/ or /dlc/ segment attributes to the base
// game. Explicit maps win over the base-game heuristic, in that order.
// ---------------------------------------------------------------------------

function normalizeLogPath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').toLowerCase();
}

function isBaseGamePath(norm) {
  return /(^|\/)(base|dlc)(\/|$)/.test(norm || '');
}

function localEntriesOf(folderMap) {
  const local = (folderMap && folderMap.local) || [];
  if (Array.isArray(local)) return local;
  return Object.keys(local).map((k) => {
    const v = local[k];
    return typeof v === 'string' ? { folder: k, modId: v } : { folder: k, ...(v || {}) };
  });
}

function matchLocalFolder(normPath, entry) {
  const folder = normalizeLogPath((entry && entry.folder) || '').replace(/^\/+|\/+$/g, '');
  if (!folder) return false;
  // Absolute-prefix form (caller passed a full mod folder): prefix match.
  if (folder.includes('/')) return normPath.startsWith(folder);
  // Bare folder-name form: match one full path segment.
  return normPath.includes(`/${folder}/`);
}

// One source path to its owning mod. Never throws on a missing map and
// never returns a bare null: the reason field always says what happened.
function resolveLogSourceMod(sourcePath, workshopId, folderMap) {
  const map = folderMap || {};
  const wid = workshopId == null || workshopId === '' ? null : String(workshopId);
  if (!sourcePath) {
    return {
      kind: 'unmapped', modId: null, modName: null,
      workshopId: wid, reason: 'no-source-path',
    };
  }
  if (wid) {
    const hit = (map.workshop || {})[wid];
    if (hit) {
      return {
        kind: 'workshop',
        modId: typeof hit === 'string' ? hit : (hit.modId || null),
        modName: typeof hit === 'string' ? null : (hit.name || null),
        workshopId: wid, reason: null,
      };
    }
    return {
      kind: 'unmapped', modId: null, modName: null,
      workshopId: wid, reason: `workshop-id-not-installed:${wid}`,
    };
  }
  const norm = normalizeLogPath(sourcePath);
  for (const entry of localEntriesOf(map)) {
    if (matchLocalFolder(norm, entry)) {
      return {
        kind: 'local',
        modId: entry.modId || null,
        modName: entry.name || null,
        workshopId: null, reason: null,
      };
    }
  }
  if (isBaseGamePath(norm)) {
    return {
      kind: 'base-game', modId: 'base-game', modName: 'Base game',
      workshopId: null, reason: null,
    };
  }
  return {
    kind: 'unmapped', modId: null, modName: null,
    workshopId: null, reason: 'path-not-mapped',
  };
}

// Entries plus folder map to entries carrying .attribution. Non-mutating:
// the input array and its entries are returned untouched in fresh objects.
function attributeLogSources(entries, folderMap) {
  return (entries || []).map((e) => ({
    ...(e || {}),
    attribution: resolveLogSourceMod(e && e.sourcePath, e && e.workshopId, folderMap),
  }));
}

// Log-pairing 2.1: numeric ms clock shared by Database.log and Modding.log.
// Tags look like [100.001]; unparseable tags yield null (unbracketable).
function parseLogTimestampMs(tag) {
  const m = /^\s*\[\s*([0-9]+(?:\.[0-9]+)?)\s*\]/.exec(String(tag == null ? '' : tag));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Log-pairing 2.1: Modding.log Loading timeline. Real shape is
// `[t] <Action> - Loading <path>` on the same ms clock as Database.log;
// fixtures below use synthetic paths only, never real paths.
function parseModdingLog(logText) {
  const lines = String(logText == null ? '' : logText).split(/\r?\n/);
  const out = [];
  lines.forEach((raw, i) => {
    const m = /-\s*Loading\s+(.+?)\s*$/.exec(raw);
    if (!m) return;
    const cleaned = m[1].trim().replace(/^['"]/, '').replace(/['"\s.,;]+$/, '');
    if (!cleaned) return;
    const tag = dbTimestampOf(raw);
    const w = /workshop\/content\/\d+\/(\d+)/i.exec(cleaned);
    out.push({
      line: i + 1,
      text: raw.trim(),
      timestampTag: tag,
      timestampMs: tag ? parseLogTimestampMs(tag) : null,
      path: cleaned,
      workshopId: w ? w[1] : null,
    });
  });
  return out;
}

// Log-pairing 2.1: usable context means any same-timestamp joined field.
// Hint-only errors (fileHint without context) stay hint-matched, never
// bracketed; only errors with neither context nor hint are bracketable.
function hasUsableDbContext(entry) {
  const e = entry || {};
  return !!(e.sourcePath || e.statement || e.values);
}

// Log-pairing 2.1: nearest-preceding Loading bracketing, always labeled
// approximate. Single preceding Loading brackets to its file; two or more
// sharing the nearest ms yield a named-candidates list (never a pick);
// no preceding Loading states so explicitly via reason.
function bracketErrorWithLoading(dbError, loadings, folderMap) {
  const e = dbError || {};
  const errTag = e.timestampTag || dbTimestampOf(e.text || '');
  const errMs = errTag ? parseLogTimestampMs(errTag) : null;
  const base = { timestampTag: errTag || null, approximate: true };
  if (errMs == null) {
    return { ...base, outcome: 'unbracketed', strength: 'unattributed',
      loadingPath: null, loadingLine: null, attribution: null,
      candidates: [], reason: 'no-error-timestamp' };
  }
  const prior = (loadings || []).filter((l) => l && typeof l.timestampMs === 'number' && l.timestampMs <= errMs);
  if (prior.length === 0) {
    return { ...base, outcome: 'unbracketed', strength: 'unattributed',
      loadingPath: null, loadingLine: null, attribution: null,
      candidates: [], reason: 'no-loading-precedes' };
  }
  let maxMs = prior[0].timestampMs;
  for (const l of prior) if (l.timestampMs > maxMs) maxMs = l.timestampMs;
  const nearest = prior.filter((l) => l.timestampMs === maxMs);
  if (nearest.length === 1) {
    const n = nearest[0];
    return { ...base, outcome: 'bracketed', strength: 'bracket-approximate',
      loadingPath: n.path, loadingLine: n.line, timestampTag: n.timestampTag,
      attribution: resolveLogSourceMod(n.path, n.workshopId, folderMap),
      candidates: null, reason: null };
  }
  return { ...base, outcome: 'ambiguous', strength: 'bracket-approximate',
    loadingPath: null, loadingLine: null, timestampTag: nearest[0].timestampTag,
    attribution: null,
    candidates: nearest.map((n) => ({ path: n.path, line: n.line,
      attribution: resolveLogSourceMod(n.path, n.workshopId, folderMap) })),
    reason: 'same-ms-ambiguity' };
}

// Log-pairing 2.1: three-strength fallback in order. Context-proven first,
// then hint-matched (fileHint kept, never bracketed), then Modding.log
// bracketing labeled approximate; otherwise unattributed with a reason.
function attributeErrorWithFallback(entry, loadings, folderMap) {
  const e = entry || {};
  if (e.sourcePath || e.statement || e.values) {
    return { strength: 'context-proven', approximate: false,
      attribution: resolveLogSourceMod(e.sourcePath, e.workshopId, folderMap),
      bracket: null };
  }
  if (e.fileHint) {
    return { strength: 'hint-matched', approximate: false,
      attribution: { kind: 'hint', modId: null, modName: null,
        fileHint: e.fileHint, stmtHint: e.stmtHint == null ? null : e.stmtHint,
        workshopId: null, reason: 'file-hint-only' },
      bracket: null };
  }
  const bracket = bracketErrorWithLoading(e, loadings, folderMap);
  if (bracket.outcome === 'bracketed') {
    return { strength: 'bracket-approximate', approximate: true,
      attribution: { ...bracket.attribution, strength: 'bracket-approximate',
        approximate: true, loadingPath: bracket.loadingPath,
        loadingLine: bracket.loadingLine },
      bracket };
  }
  if (bracket.outcome === 'ambiguous') {
    return { strength: 'bracket-approximate', approximate: true,
      attribution: { kind: 'bracket-ambiguous', modId: null, modName: null,
        workshopId: null, reason: bracket.reason,
        candidates: bracket.candidates },
      bracket };
  }
  return { strength: 'unattributed', approximate: true,
    attribution: { kind: 'unattributed', modId: null, modName: null,
      workshopId: null, reason: bracket.reason },
    bracket };
}

// Log-pairing 2.2: load-sequence calibration (report-only). The game file
// load sequence is the Modding.log Loading order; calibration compares it
// against the assumed replay order and reports inverted pairs naming which
// side each order came from (game-observed vs assumed). Never reorders or
// corrects anything: replay assumptions stay as-is.
function basenameOfLoadPath(p) {
  const norm = String(p == null ? '' : p).replace(/\\/g, '/');
  const base = norm.split('/').pop() || '';
  return base;
}

function loadOrderKey(s) {
  return basenameOfLoadPath(s).toLowerCase();
}

function assumedFileLabel(f) {
  if (typeof f === 'string') return f;
  if (f && typeof f.fileLabel === 'string') return f.fileLabel;
  if (f && typeof f.label === 'string') return f.label;
  if (f && typeof f.path === 'string') return basenameOfLoadPath(f.path);
  return String(f == null ? '' : f);
}

// Game-observed file load sequence: Loading paths in file (line) order.
// Returns fresh objects; never mutates the loadings input.
function gameLoadSequence(loadings) {
  const sorted = [...(loadings || [])]
    .filter((l) => l && typeof l.path === 'string' && l.path)
    .sort((a, b) => (a.line || 0) - (b.line || 0));
  return sorted.map((l) => ({
    path: l.path,
    key: loadOrderKey(l.path),
    label: basenameOfLoadPath(l.path),
    line: l.line,
    timestampMs: l.timestampMs,
  }));
}

// Report-only calibration of assumed replay order vs game-observed order.
// Files are matched by basename (case-insensitive); only files present on
// both sides participate in pair comparison, while side-only files are
// listed separately (never dropped silently). Returns a fresh report;
// inputs are never reordered or mutated.
function calibrateLoadOrder(assumedFiles, loadings) {
  const assumed = (assumedFiles || []).map((f, i) => ({
    index: i,
    label: assumedFileLabel(f),
    key: loadOrderKey(assumedFileLabel(f)),
    modId: (f && typeof f === 'object' && f.modId) || null,
  })).filter((a) => a.key);
  const observed = gameLoadSequence(loadings);
  const assumedPos = new Map();
  for (const a of assumed) if (!assumedPos.has(a.key)) assumedPos.set(a.key, a.index);
  const observedPos = new Map();
  observed.forEach((o, rank) => { if (!observedPos.has(o.key)) observedPos.set(o.key, rank); });
  const commonKeys = [...assumedPos.keys()].filter((k) => observedPos.has(k));
  const assumedOrder = [...commonKeys].sort((a, b) => assumedPos.get(a) - assumedPos.get(b));
  const observedOrder = [...commonKeys].sort((a, b) => observedPos.get(a) - observedPos.get(b));
  const labelOf = (key) => {
    const a = assumed.find((x) => x.key === key);
    return a ? a.label : key;
  };
  const divergences = [];
  for (let i = 0; i < assumedOrder.length; i += 1) {
    for (let j = i + 1; j < assumedOrder.length; j += 1) {
      const first = assumedOrder[i];
      const second = assumedOrder[j];
      if (observedPos.get(first) > observedPos.get(second)) {
        const aLabel = labelOf(first);
        const bLabel = labelOf(second);
        divergences.push({
          assumedFirst: aLabel,
          assumedSecond: bLabel,
          assumedOrder: `${aLabel} before ${bLabel} (assumed replay order)`,
          observedOrder: `${bLabel} before ${aLabel} (game-observed order)`,
        });
      }
    }
  }
  const assumedOnly = assumed.filter((a) => !observedPos.has(a.key)).map((a) => a.label);
  const observedOnly = observed.filter((o) => !assumedPos.has(o.key)).map((o) => o.label);
  return {
    assumedOrder: assumedOrder.map(labelOf),
    observedOrder: observedOrder.map(labelOf),
    divergences,
    assumedOnly,
    observedOnly,
  };
}

function formatCalibration(cal) {
  const lines = [];
  lines.push(`assumed=[${(cal.assumedOrder || []).join(', ')}]`
    + ` observed=[${(cal.observedOrder || []).join(', ')}]`
    + ` divergences=${(cal.divergences || []).length}`);
  (cal.divergences || []).forEach((d) => {
    lines.push(`  inverted: ${d.assumedOrder} vs ${d.observedOrder}`);
  });
  return lines.join('\n');
}

// Message comparison strips the -- file: annotation this harness appends
// to fixture log lines plus any ERROR: prefix, then lowercases and
// collapses whitespace. Equality wins; delimited inclusion tolerates
// game-side wrapping but never matches a table-name prefix (NoSuchAlpha
// must not match NoSuchAlpha2): the shorter side must end on non-word.

function normalizeDbMessage(msg) {
  const s = String(msg == null ? '' : msg).toLowerCase()
    .replace(/\s*--\s*file:.*$/, '')
    .replace(/\s*\(file:.*\)\s*$/, '')
    .replace(/^error\s*:\s*/, '');
  return s.replace(/\s+/g, ' ').trim();
}

function dbMessagesMatch(a, b) {
  const x = normalizeDbMessage(a);
  const y = normalizeDbMessage(b);
  if (!x || !y || x.length < 8 || y.length < 8) return false;
  if (x === y) return true;
  const delimited = (hay, needle) => {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) return false;
      const word = (c) => /[a-z0-9_]/.test(c || '');
      if (!word(hay[at - 1]) && !word(hay[at + needle.length])) return true;
      from = at + 1;
    }
  };
  return delimited(x, y) || delimited(y, x);
}

// Replay-side findings: every aborted per-file record becomes one error
// keyed by (file, statement). stmtIndex derives from failedAt minus the
// file's baseGlobalIndex via the collected set; lookup by (mod, file)
// name is the fallback when positional correlation misses.

function collectReplayErrors(report, collected) {
  const files = (collected && collected.files) || [];
  const out = [];
  ((report && report.perFile) || []).forEach((rec, i) => {
    if (!rec || rec.status !== 'aborted' || !rec.error) return;
    const file = (files[i] && files[i].fileLabel === rec.fileLabel && files[i].modId === rec.modId)
      ? files[i]
      : files.find((f) => f.modId === rec.modId && f.fileLabel === rec.fileLabel);
    const stmtIndex = (file && typeof rec.failedAt === 'number'
      && typeof file.baseGlobalIndex === 'number')
      ? rec.failedAt - file.baseGlobalIndex
      : null;
    out.push({
      modId: rec.modId,
      fileLabel: rec.fileLabel,
      stmtIndex,
      globalIndex: typeof rec.failedAt === 'number' ? rec.failedAt : null,
      error: rec.error,
      ...(rec.sameMod === true ? { sameMod: true } : {}),
    });
  });
  return out;
}

// Greedy one-to-one match of replay errors to log errors by message.
// Agreements name file, statement, and the matched log line; leftovers
// are replay-only (replay raised, game silent) and log-only (game logged,
// replay missed), each still naming file and statement.

function differentialValidate(report, logInput, collected) {
  const logErrors = typeof logInput === 'string' ? parseDatabaseLog(logInput) : (logInput || []);
  const replayErrors = collectReplayErrors(report, collected);
  const used = new Array(logErrors.length).fill(false);
  const agreements = [];
  const replayOnly = [];
  replayErrors.forEach((re) => {
    let hit = -1;
    for (let i = 0; i < logErrors.length; i += 1) {
      if (!used[i] && dbMessagesMatch(re.error, logErrors[i].message)) { hit = i; break; }
    }
    if (hit >= 0) {
      used[hit] = true;
      agreements.push({
        modId: re.modId,
        fileLabel: re.fileLabel,
        stmtIndex: re.stmtIndex,
        globalIndex: re.globalIndex,
        replayError: re.error,
        ...(re.sameMod === true ? { sameMod: true } : {}),
        logLine: logErrors[hit].line,
        logText: logErrors[hit].text,
      });
    } else {
      replayOnly.push({ ...re, replayError: re.error, side: 'replay-only' });
    }
  });
  const logOnly = [];
  logErrors.forEach((le, i) => {
    if (!used[i]) {
      logOnly.push({
        side: 'log-only',
        fileLabel: le.fileHint,
        stmtIndex: le.stmtHint,
        logLine: le.line,
        logText: le.text,
        message: le.message,
      });
    }
  });
  return {
    agreements,
    replayOnly,
    logOnly,
    replayErrors: replayErrors.length,
    logErrors: logErrors.length,
  };
}

function formatDifferential(diff) {
  const lines = [];
  lines.push(`agreements=${diff.agreements.length}`
    + ` replay-only=${diff.replayOnly.length} log-only=${diff.logOnly.length}`);
  diff.agreements.forEach((a) => {
    lines.push(`  agree: ${a.modId}/${a.fileLabel}#${a.stmtIndex} (global ${a.globalIndex})`
      + ` <-> Database.log:${a.logLine}: ${a.logText}`);
  });
  diff.replayOnly.forEach((r) => {
    lines.push(`  replay-only: ${r.modId}/${r.fileLabel}#${r.stmtIndex} (global ${r.globalIndex})`
      + ` :: ${r.replayError}`);
  });
  diff.logOnly.forEach((l) => {
    lines.push(`  log-only: ${l.fileLabel || '(unattributed)'}#${l.stmtIndex == null ? '?' : l.stmtIndex}`
      + ` Database.log:${l.logLine}: ${l.logText}`);
  });
  return lines.join('\n');
}

// --differential fixture: two replay failures plus a three-line
// Database.log-format text. The log carries bad-a's own replay error (one
// agreement), stays silent about bad-b (one replay-only divergence), and
// adds a ghost error no replay statement raised (one log-only divergence).

function differentialFixtureLog(badAError) {
  return [
    `[100.001] [Gameplay] ERROR: ${badAError} -- file: bad-a.sql statement 0`,
    '[100.002] [Gameplay] Validating Foreign Key Constraints...',
    '[100.003] [Gameplay] ERROR: UNIQUE constraint failed: DiffCheck.Id'
    + ' -- file: ghost.sql statement 3',
  ].join('\n');
}

// Checkable assertions for runDifferential: one agreement naming
// file/statement/log line, plus one divergence per direction each naming
// file, statement, and which side observed it.

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

// ---------------------------------------------------------------------------
// Task 2.3: replay envelope reporting. Every replay already records counts,
// wall-clock, and rate (see replayOrdered); buildReplayEnvelope projects
// those onto the measured-spike reference shape (8,138 statements in ~2s,
// ~3,700 statements/s, 9 in 10 executing FK-off), and
// formatReplayEnvelope prints the one-line envelope every replay carries.
// ---------------------------------------------------------------------------

const REPLAY_ENVELOPE_REF = { statements: 8138, wallMs: 2000, stmtsPerSec: 3700, executedFraction: 0.9 };

function buildReplayEnvelope(report) {
  const statements = (report && report.total) || 0;
  const executed = (report && report.executed) || 0;
  return {
    statements,
    executed,
    skipped: statements - executed,
    wallMs: (report && report.wallMs) || 0,
    stmtsPerSec: (report && report.stmtsPerSec) || 0,
    executedFraction: statements > 0 ? executed / statements : 0,
  };
}

function formatReplayEnvelope(env) {
  const pct = (env.executedFraction * 100).toFixed(1);
  return `envelope: ${env.statements} statements in ${env.wallMs}ms`
    + ` (${env.stmtsPerSec} statements/s, executed ${env.executed}/${env.statements}`
    + ` skipped ${env.skipped}/${env.statements} = ${pct}%)`;
}

// Reference-scale fixture: exactly 8,138 valid INSERTs across 8 files in
// one mod, so ordered replay measures the envelope without abort noise.
function envelopeFixtureModSet() {
  const files = [];
  let n = 0;
  const per = Math.ceil(REPLAY_ENVELOPE_REF.statements / 8);
  for (let f = 0; f < 8 && n < REPLAY_ENVELOPE_REF.statements; f += 1) {
    const chunk = [];
    for (let k = 0; k < per && n < REPLAY_ENVELOPE_REF.statements; k += 1, n += 1) {
      chunk.push(`INSERT INTO EnvCheck VALUES(${n}, ${n});`);
    }
    files.push({ label: `part${f}.sql`, text: chunk.join('\n') });
  }
  return [{ modId: 'mod-env', files }];
}

module.exports = {
  createTempCopy,
  destroyTempCopy,
  decodeModSql,
  readModFile,
  splitStatements,
  splitStatementsTriggerAware,
  splitterFlags,
  rewriteDoubleQuotes,
  fnv1a32,
  makeHashStubValue,
  needsMakeHash,
  installMakeHashStub,
  looksLikeXml,
  convertXmlToSql,
  normGateId,
  gateContextOf,
  gateSetupKeysFor,
  gateIsAsserted,
  gateAssumedMatch,
  evalGateCondition,
  evaluateGate,
  qIdent,
  qLit,
  listUserTables,
  getTableColumns,
  ensureProvenanceSchema,
  installProvenanceTriggers,
  setProvenanceWriter,
  readProvenanceWrites,
  fileLimitationFlags,
  buildCollisions,
  formatCollision,
  leadingVerb,
  formatZeroRows,
  parseDatabaseLog,
  resolveLogSourceMod,
  attributeLogSources,
  parseLogTimestampMs,
  parseModdingLog,
  hasUsableDbContext,
  bracketErrorWithLoading,
  attributeErrorWithFallback,
  gameLoadSequence,
  calibrateLoadOrder,
  formatCalibration,
  normalizeDbMessage,
  dbMessagesMatch,
  collectReplayErrors,
  differentialValidate,
  formatDifferential,
  differentialFixtureLog,
  assertDifferential,
  REPLAY_ENVELOPE_REF,
  buildReplayEnvelope,
  formatReplayEnvelope,
  envelopeFixtureModSet,
  TEXT_TABLE_NAMES,
  TEXT_TABLE_COLUMNS,
  cleanSqlIdent,
  isTextTableName,
  textTableMiss,
  textColumnMiss,
  uniqueMissTable,
  textColumnFallback,
  textSchemaSql,
  createTextSchemaCopy,
  stmtTargets,
  routeStatementTargets,
  preprocessFile,
  collectStatements,
  replayOrdered,
  holdLiveExclusiveForCopy,
  lockedCopyTrial,
};