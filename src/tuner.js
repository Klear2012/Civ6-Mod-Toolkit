'use strict';

// Persistent FireTuner bridge: one TCP connection to the game's tuner port
// (localhost:4318), reused for N commands — process-per-command is forbidden.
// Nexus frames ([u32le len][i32le tag][utf-8 + NUL]); handshake APP:/LSQ:;
// execute CMD:<index>:<lua>; output collected to a sentinel print.
// execute_read targets GameCore_Tuner, execute_write targets InGame
// (game-validated, no-cheat by construction); database files never touched.
// Wire format per the MIT-licensed lmwilki/civ6-mcp reverse engineering;
// full notes in decisions/adr-015-tuner-live-operation.md.

const net = require('node:net');
const { execFile } = require('node:child_process');
const minimist = require('minimist');

// ---- Protocol constants (single owner: this module, see ADR-013) ----

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4318;
const TAG_HELP = 1;
const TAG_COMMAND = 3;
const TAG_HANDSHAKE = 4;
const TAG_OUTPUT = -1;
const HEADER_SIZE = 8;
const MAX_FRAME = 64 * 1024 * 1024;
const GAMECORE_NAME = 'GameCore_Tuner';
const INGAME_NAME = 'InGame';

// Sentinel ends a snippet's output. Field-proven value shared with
// lmwilki/civ6-mcp; the comparison runs on the parsed value (after the
// `O\0<context>: ` prefix is stripped), never on raw bytes.
const SENTINEL = '---END---';

// Retry policy (decisions/02, option A): fixed handshake attempts with
// linear backoff. Measured live 2026-10-10: APP: answers in ~25 ms, so a
// 5 s handshake timeout only fires on a real hang. Reads/writes retry
// nothing: a live command either answers or its failure is the finding.
const HANDSHAKE_ATTEMPTS = 3;
const HANDSHAKE_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 3000;
const RETRY_DELAYS_MS = [500, 1500];
const COMMAND_TIMEOUT_MS = 8000;
const DRAIN_MS = 150;
const ACK_GRACE_MS = 500;

// ---- Errors (one plain-words message per cause) ----

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

class LuaError extends Error {
  constructor(payload) {
    super('The game reported a Lua error: ' + payload);
    this.name = 'LuaError';
    this.code = 'E_LUA';
    this.payload = payload;
  }
}

function refusedMessage(procs) {
  if (procs && procs.firetuner) {
    return 'The tuner takes one connection and it looks like FireTuner is holding it — close the FireTuner window and try again.';
  }
  if (procs && procs.known && !procs.civ6) {
    return 'Nothing is listening on 127.0.0.1:4318 — start Civilization VI with the Tuner enabled (EnableTuner=1, which disables achievements for the session), then try again.';
  }
  if (procs && procs.civ6) {
    return 'The game is running but nothing is listening on 127.0.0.1:4318 — set EnableTuner=1 (this disables achievements for the session) and restart the game, then try again.';
  }
  return 'Nothing is listening on 127.0.0.1:4318 — start Civilization VI with the Tuner enabled (EnableTuner=1, which disables achievements for the session), then try again.';
}

const HANG_MESSAGE = 'The game is not answering on the tuner port — check it runs windowed with EnableTuner=1, then try again.';
const NO_STATES_MESSAGE = 'The game answered but has no loaded game to talk to — load or start a game first (menus expose no GameCore or InGame state), then try again.';
const TIMEOUT_MESSAGE = 'The game did not finish that command in time — it may still be working; try a smaller command or try again.';

// Pure classifier so tests assert wording without a game. procs is
// { known, civ6, firetuner } (see probeProcesses) or null when unknown.
function classifyConnectError(err, procs) {
  if (err && (err.code === 'ECONNREFUSED' || /refused/i.test(err.message || ''))) {
    return new BridgeError('E_REFUSED', refusedMessage(procs));
  }
  return new BridgeError('E_HANG', HANG_MESSAGE);
}

// Best-effort process probe: one tasklist call answers both questions the
// refused message needs (is Civ6 up? is FireTuner holding the slot?).
function probeProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ known: false, civ6: false, firetuner: false });
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ known: false, civ6: false, firetuner: false });
      const found = { known: true, civ6: false, firetuner: false };
      for (const line of String(out).split(/\r?\n/)) {
        const name = (line.match(/^"([^"]+)"/) || [])[1] || '';
        if (/^civilizationvi(_dx12)?\.exe$/i.test(name)) found.civ6 = true;
        if (/^firetuner(\.exe)?$/i.test(name)) found.firetuner = true;
      }
      resolve(found);
    });
  });
}

// ---- Frames (pure encode/decode; byte-for-byte testable) ----

function encodeFrame(tag, payload) {
  const body = Buffer.from(String(payload), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(body.length + 1, 0);
  header.writeInt32LE(tag, 4);
  return Buffer.concat([header, body, Buffer.from([0])]);
}

// Splits available bytes into complete messages; keeps the tail for later.
function decodeFrames(buffer) {
  const messages = [];
  let rest = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  while (rest.length >= HEADER_SIZE) {
    const length = rest.readUInt32LE(0);
    const tag = rest.readInt32LE(4);
    if (length < 1 || length > MAX_FRAME) {
      throw new BridgeError('E_FRAME', 'The game sent a frame the bridge cannot parse — try again.');
    }
    if (rest.length < HEADER_SIZE + length) break;
    const body = rest.subarray(HEADER_SIZE, HEADER_SIZE + length);
    rest = rest.subarray(HEADER_SIZE + length);
    const text = body[body.length - 1] === 0 ? body.subarray(0, -1).toString('utf8') : body.toString('utf8');
    messages.push({ tag, payload: text });
  }
  return { messages, rest };
}

// `O\0<context>: <value>` carries print output; anything else is control.
function parseOutput(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('O')) return null;
  const sep = payload.indexOf(': ', 2);
  if (sep >= 0) return payload.slice(sep + 2);
  return payload.replace(/^O\x00?/, '');
}

// ---- Connection handle (explicit open/use/close, decisions/01 option A) ----

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => {
      sock.destroy();
      const err = new Error('connect timed out');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.connect(port, host, () => {
      clearTimeout(timer);
      sock.removeListener('error', reject);
      resolve(sock);
    });
  });
}

// Reads one framed message; null on timeout. Buffers partial frames on the
// handle so split TCP segments reassemble across calls.
function readOne(handle, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = handle.socket;
    if (!sock || handle.closed) return reject(new BridgeError('E_CLOSED', 'The tuner connection is closed — open a new one and try again.'));
    const pump = () => {
      try {
        const { messages, rest } = decodeFrames(handle.pending);
        handle.pending = rest;
        if (messages.length) {
          cleanup();
          resolve(messages[0]);
          // Any extra messages in this batch stay queued in arrival order.
          handle.queued.push(...messages.slice(1));
          return true;
        }
      } catch (e) {
        cleanup();
        reject(e);
        return true;
      }
      return false;
    };
    const onData = (chunk) => {
      handle.pending = Buffer.concat([handle.pending, chunk]);
      pump();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      handle.closed = true;
      reject(new BridgeError('E_CLOSED', 'The game closed the tuner connection — try again.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
    }
    if (handle.queued.length) {
      const next = handle.queued.shift();
      cleanup();
      resolve(next);
      return;
    }
    if (pump()) return;
    sock.on('data', onData);
    sock.once('error', onError);
    sock.once('close', onClose);
  });
}

async function drainMessages(handle, timeoutMs) {
  const out = [];
  for (;;) {
    const msg = await readOne(handle, timeoutMs);
    if (!msg) break;
    out.push(msg);
  }
  return out;
}

function parseStates(payload) {
  const parts = String(payload).split('\0').map((s) => s.trim()).filter((s) => s !== '');
  const states = [];
  const pairs = (list) => {
    let i = 0;
    while (i + 1 < list.length) {
      const index = Number.parseInt(list[i], 10);
      if (!Number.isInteger(index)) {
        i += 1;
        continue;
      }
      states.push({ index, name: list[i + 1] });
      i += 2;
    }
  };
  pairs(parts);
  if (!states.length && /\n/.test(String(payload))) {
    pairs(String(payload).split('\n').map((s) => s.trim()).filter((s) => s !== ''));
  }
  return states;
}

function parseIdentity(payload) {
  const parts = String(payload).split('\0');
  return { app: parts[0] || '', title: parts[1] || '', path: parts[2] || '', raw: String(payload) };
}

function findState(states, name) {
  const hit = states.find((s) => s.name === name);
  return hit ? hit.index : null;
}

async function handshakeOnce(handle, timeoutMs) {
  await drainMessages(handle, DRAIN_MS);
  handle.socket.write(encodeFrame(TAG_HANDSHAKE, 'APP:'));
  const appMsg = await readOne(handle, timeoutMs);
  if (!appMsg) throw new BridgeError('E_HANG', HANG_MESSAGE);
  handle.socket.write(encodeFrame(TAG_HANDSHAKE, 'LSQ:'));
  const lsqMsg = await readOne(handle, timeoutMs);
  if (!lsqMsg) throw new BridgeError('E_HANG', HANG_MESSAGE);
  handle.identity = parseIdentity(appMsg.payload);
  handle.states = parseStates(lsqMsg.payload);
  handle.gamecoreIndex = findState(handle.states, GAMECORE_NAME);
  handle.ingameIndex = findState(handle.states, INGAME_NAME);
  return handle;
}

// One handshake reused N times: open, shake hands with bounded retry, then
// every execute below reuses handle.socket. Never opens per command.
async function openBridge(options) {
  const opts = options || {};
  const host = opts.host || process.env.TUNER_HOST || DEFAULT_HOST;
  const port = Number.parseInt(opts.port || process.env.TUNER_PORT || DEFAULT_PORT, 10);
  const timeoutMs = opts.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS;
  const attempts = opts.attempts || HANDSHAKE_ATTEMPTS;
  const delays = opts.retryDelaysMs || RETRY_DELAYS_MS;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let sock = null;
    try {
      sock = await connectSocket(host, port, opts.connectTimeoutMs || CONNECT_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
      continue;
    }
    const handle = {
      socket: sock,
      host,
      port,
      pending: Buffer.alloc(0),
      queued: [],
      closed: false,
      busy: false,
      identity: null,
      states: [],
      gamecoreIndex: null,
      ingameIndex: null,
    };
    sock.on('error', () => {});
    sock.on('close', () => {
      handle.closed = true;
    });
    try {
      await handshakeOnce(handle, timeoutMs);
      return handle;
    } catch (err) {
      lastError = err;
      try {
        sock.destroy();
      } catch (_) { /* already gone */ }
      // Connect-phase retries cover the single-slot re-arm race (a fresh
    // disconnect can refuse briefly); handshake-phase retries below are
    // hang-only.
      if (err.code !== 'E_HANG' || attempt >= attempts) break;
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    }
  }
  if (lastError && lastError.code === 'E_HANG') throw lastError;
  throw classifyConnectError(lastError, opts.procs || null);
}

function closeBridge(handle) {
  if (!handle) return;
  handle.closed = true;
  try {
    if (handle.socket) handle.socket.destroy();
  } catch (_) { /* already gone */ }
  handle.socket = null;
}

// Appends the sentinel print so output collection terminates. Statement
// snippets only: a trailing top-level `return` would no longer be last, so
// debug one-liners should `print(<expr>)` instead of `return <expr>`.
function appendSentinel(lua) {
  return String(lua) + '\nprint("' + SENTINEL + '")';
}

async function executeInState(handle, index, lua, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || COMMAND_TIMEOUT_MS;
  if (!handle || handle.closed || !handle.socket) {
    throw new BridgeError('E_CLOSED', 'The tuner connection is closed — open a new one and try again.');
  }
  if (handle.busy) throw new BridgeError('E_BUSY', 'The tuner runs one command at a time — wait for the last one, then try again.');
  if (!Number.isInteger(index)) throw new BridgeError('E_STATE', 'That Lua state is not a number — pick one from the handshake list.');
  handle.busy = true;
  try {
    await drainMessages(handle, DRAIN_MS);
    handle.socket.write(encodeFrame(TAG_COMMAND, 'CMD:' + index + ':' + String(lua)));
    const lines = [];
    const deadline = Date.now() + timeoutMs;
    let sawAck = false;
    let ended = 'timeout';
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const msg = await readOne(handle, Math.min(remaining, ACK_GRACE_MS));
      if (!msg) {
        if (sawAck) {
          ended = 'ack-quiet';
          break;
        }
        continue;
      }
      if (typeof msg.payload === 'string' && msg.payload.startsWith('ERR:')) throw new LuaError(msg.payload);
      if (msg.tag === TAG_COMMAND && msg.payload === '') {
        sawAck = true;
        continue;
      }
      const value = parseOutput(msg.payload);
      if (value === null) continue;
      if (value === SENTINEL) {
        ended = 'sentinel';
        break;
      }
      lines.push(value);
    }
    if (ended === 'timeout' && !sawAck && !lines.length) throw new BridgeError('E_TIMEOUT', TIMEOUT_MESSAGE);
    return { lines, sawAck, ended };
  } finally {
    handle.busy = false;
  }
}

// Reads run in the GameCore context (read-only surface); writes run only
// through the InGame context (game-validated). A missing state is an
// honest error naming the fix, never a guess at another state.
async function executeRead(handle, lua, options) {
  if (handle.gamecoreIndex === null || handle.gamecoreIndex === undefined) {
    throw new BridgeError('E_NO_STATES', NO_STATES_MESSAGE);
  }
  return executeInState(handle, handle.gamecoreIndex, lua, options);
}

async function executeWrite(handle, lua, options) {
  if (handle.ingameIndex === null || handle.ingameIndex === undefined) {
    throw new BridgeError('E_NO_STATES', NO_STATES_MESSAGE);
  }
  return executeInState(handle, handle.ingameIndex, lua, options);
}

// ---- Thin CLI on the same code path: node src/tuner.js "<lua>" ----

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_BRIDGE = 3;
const EXIT_LUA = 4;

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function runCli(argv) {
  const args = minimist(argv, { boolean: ['write', 'help'], string: ['state'], alias: { w: 'write' } });
  if (args.help) {
    process.stdout.write(
      'Usage: node src/tuner.js "<lua>" [--write] [--state N]\n' +
      'Runs one Lua snippet through the tuner bridge and prints JSON.\n' +
      'Default context is read (GameCore, read-only). --write uses the InGame\n' +
      'context (game-validated). --state N names a state index explicitly\n' +
      '(for menu screens, which expose no GameCore/InGame state).\n' +
      'Snippets should print() what you want back; a sentinel print is added\n' +
      'so output ends. Needs Civ6 running windowed with EnableTuner=1\n' +
      '(which disables achievements for the session) and no FireTuner window.\n',
    );
    return EXIT_OK;
  }
  const lua = args._[0];
  if (typeof lua !== 'string' || !lua.trim()) {
    printJson({ ok: false, code: 'E_USAGE', message: 'Give one Lua snippet in quotes — for example node src/tuner.js "print(GameInfo ~= nil)".' });
    return EXIT_USAGE;
  }
  let handle = null;
  try {
    handle = await openBridge({});
  } catch (err) {
    if (err.code === 'E_REFUSED') {
      const procs = await probeProcesses();
      const classified = classifyConnectError({ code: 'ECONNREFUSED' }, procs);
      printJson({ ok: false, code: classified.code, message: classified.message });
    } else {
      printJson({ ok: false, code: err.code || 'E_BRIDGE', message: err.message });
    }
    return EXIT_BRIDGE;
  }
  try {
    let context = 'read';
    let index = handle.gamecoreIndex;
    if (args.state !== undefined) {
      index = Number.parseInt(args.state, 10);
      if (!Number.isInteger(index)) {
        printJson({ ok: false, code: 'E_USAGE', message: '--state needs a number from the handshake list.' });
        return EXIT_USAGE;
      }
      context = 'state:' + index;
    } else if (args.write) {
      context = 'write';
      index = handle.ingameIndex;
    }
    if (index === null || index === undefined) {
      printJson({ ok: false, code: 'E_NO_STATES', message: NO_STATES_MESSAGE });
      return EXIT_BRIDGE;
    }
    const state = handle.states.find((s) => s.index === index) || { index, name: 'unknown' };
    try {
      const { lines, ended } = await executeInState(handle, index, appendSentinel(lua));
      printJson({ ok: true, context, state, lines, ended });
      return EXIT_OK;
    } catch (err) {
      if (err.code === 'E_LUA') {
        printJson({ ok: false, code: err.code, message: err.message });
        return EXIT_LUA;
      }
      printJson({ ok: false, code: err.code || 'E_BRIDGE', message: err.message });
      return EXIT_BRIDGE;
    }
  } finally {
    closeBridge(handle);
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      printJson({ ok: false, code: (err && err.code) || 'E_BRIDGE', message: (err && err.message) || String(err) });
      process.exit(EXIT_BRIDGE);
    },
  );
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  TAG_HELP,
  TAG_COMMAND,
  TAG_HANDSHAKE,
  TAG_OUTPUT,
  GAMECORE_NAME,
  INGAME_NAME,
  SENTINEL,
  HANDSHAKE_ATTEMPTS,
  HANDSHAKE_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  BridgeError,
  LuaError,
  encodeFrame,
  decodeFrames,
  parseOutput,
  parseStates,
  parseIdentity,
  appendSentinel,
  classifyConnectError,
  probeProcesses,
  openBridge,
  closeBridge,
  executeInState,
  executeRead,
  executeWrite,
  runCli,
};
