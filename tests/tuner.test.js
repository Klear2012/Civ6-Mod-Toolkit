'use strict';

// Mirror for src/tuner.js: Nexus framing, handshake, persistent reuse,
// read/write split, sentinel collection, retry bounds, plain-words errors,
// thin CLI. All protocol assertions run against a Temp loopback stub speaking
// the same frames as the game; live-game runs are recorded in findings.md,
// never claimed here.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');

const tuner = require('../src/tuner');

const SRCPATH = path.join(__dirname, '..', 'src', 'tuner.js');

// ---- Temp loopback stub (speaks Nexus frames like the game) ----

function startStub(behavior) {
  const counts = { connections: 0, app: 0, lsq: 0, cmds: [] };
  const server = net.createServer((sock) => {
    counts.connections += 1;
    let pending = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      let decoded;
      try {
        decoded = tuner.decodeFrames(pending);
      } catch (_) {
        return;
      }
      pending = decoded.rest;
      for (const msg of decoded.messages) {
        const text = msg.payload;
        if (msg.tag === 4 && text === 'APP:') {
          counts.app += 1;
          if (!behavior.silent) sock.write(tuner.encodeFrame(4, behavior.identity));
        } else if (msg.tag === 4 && text === 'LSQ:') {
          counts.lsq += 1;
          if (!behavior.silent) sock.write(tuner.encodeFrame(4, behavior.states));
        } else if (msg.tag === 3 && text.startsWith('CMD:')) {
          counts.cmds.push(text);
          const replies = behavior.onCmd ? behavior.onCmd(text) : [];
          for (const [tag, payload] of replies) sock.write(tuner.encodeFrame(tag, payload));
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        counts,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const IDENTITY = 'Civ6\x00Test Game\x00D:\\game';
const STATES = '101\x00GameCore_Tuner\x005\x00FrontEnd\x00102\x00InGame';

function outReply(value) {
  return [-1, 'O\x00FrontEnd: ' + value];
}

describe('frames are byte-exact', () => {
  it('encodeFrame writes length, tag, payload, NUL', () => {
    const body = Buffer.from('CMD:0:print(1)', 'utf8');
    const expected = Buffer.alloc(8 + body.length + 1);
    expected.writeUInt32LE(body.length + 1, 0);
    expected.writeInt32LE(3, 4);
    body.copy(expected, 8);
    expected[expected.length - 1] = 0;
    assert.deepEqual(tuner.encodeFrame(3, 'CMD:0:print(1)'), expected);
  });
  it('decodeFrames reassembles split segments and keeps order', () => {
    const a = tuner.encodeFrame(4, 'APP:');
    const b = tuner.encodeFrame(-1, 'O\0X: hi');
    const joined = Buffer.concat([a, b]);
    let acc = Buffer.alloc(0);
    let got = [];
    for (const slice of [joined.subarray(0, 3), joined.subarray(3, 10), joined.subarray(10)]) {
      acc = Buffer.concat([acc, slice]);
      const decoded = tuner.decodeFrames(acc);
      acc = decoded.rest;
      got = got.concat(decoded.messages);
    }
    assert.equal(got.length, 2);
    assert.deepEqual(got[0], { tag: 4, payload: 'APP:' });
    assert.deepEqual(got[1], { tag: -1, payload: 'O\x00X: hi' });
    assert.equal(acc.length, 0);
  });
  it('parseOutput strips the context prefix', () => {
    assert.equal(tuner.parseOutput('O\0FrontEnd: hello'), 'hello');
    assert.equal(tuner.parseOutput('nope'), null);
  });
});

describe('handshake discovers identity and states', () => {
  let stub = null;
  before(async () => {
    stub = await startStub({ identity: IDENTITY, states: STATES });
  });
  after(async () => {
    await stub.close();
  });
  it('openBridge returns identity plus GameCore/InGame indexes', async () => {
    const handle = await tuner.openBridge({ host: '127.0.0.1', port: stub.port });
    try {
      assert.equal(handle.identity.app, 'Civ6');
      assert.equal(handle.identity.title, 'Test Game');
      assert.deepEqual(handle.states, [
        { index: 101, name: 'GameCore_Tuner' },
        { index: 5, name: 'FrontEnd' },
        { index: 102, name: 'InGame' },
      ]);
      assert.equal(handle.gamecoreIndex, 101);
      assert.equal(handle.ingameIndex, 102);
    } finally {
      tuner.closeBridge(handle);
    }
  });
});

describe('one handshake serves N commands', () => {
  let stub = null;
  before(async () => {
    stub = await startStub({
      identity: IDENTITY,
      states: STATES,
      onCmd: (text) => [...['ok-1', '---END---'].map(outReply), [3, '']],
    });
  });
  after(async () => {
    await stub.close();
  });
  it('three executes share a single handshake and route by context', async () => {
    const handle = await tuner.openBridge({ host: '127.0.0.1', port: stub.port });
    try {
      const first = await tuner.executeRead(handle, 'print(1)');
      const second = await tuner.executeWrite(handle, 'print(2)');
      const third = await tuner.executeRead(handle, 'print(3)');
      assert.deepEqual(first.lines, ['ok-1']);
      assert.equal(first.ended, 'sentinel');
      assert.deepEqual(second.lines, ['ok-1']);
      assert.deepEqual(third.lines, ['ok-1']);
      assert.equal(stub.counts.app, 1);
      assert.equal(stub.counts.lsq, 1);
      assert.equal(stub.counts.cmds.length, 3);
      assert.ok(stub.counts.cmds[0].startsWith('CMD:101:'), stub.counts.cmds[0]);
      assert.ok(stub.counts.cmds[1].startsWith('CMD:102:'), stub.counts.cmds[1]);
      assert.ok(stub.counts.cmds[2].startsWith('CMD:101:'), stub.counts.cmds[2]);
    } finally {
      tuner.closeBridge(handle);
    }
  });
  it('a game-rejected action stays rejected with no retry', async () => {
    const failing = await startStub({
      identity: IDENTITY,
      states: STATES,
      onCmd: () => [[3, 'ERR:attempt to call a nil value']],
    });
    try {
      const handle = await tuner.openBridge({ host: '127.0.0.1', port: failing.port });
      try {
        await assert.rejects(tuner.executeWrite(handle, 'NoSuchThing_xyz()'), (err) => err.code === 'E_LUA');
        assert.equal(failing.counts.cmds.length, 1);
      } finally {
        tuner.closeBridge(handle);
      }
    } finally {
      await failing.close();
    }
  });
});

describe('collection stops at the sentinel and bounds runaways', () => {
  it('200 unsentinelled lines return at the timeout, never hang', async () => {
    const flood = await startStub({
      identity: IDENTITY,
      states: STATES,
      onCmd: () => Array.from({ length: 200 }, (_, i) => outReply('line-' + i)),
    });
    try {
      const handle = await tuner.openBridge({ host: '127.0.0.1', port: flood.port });
      try {
        const t0 = Date.now();
        const result = await tuner.executeInState(handle, 5, 'print avalanche', { timeoutMs: 400 });
        const elapsed = Date.now() - t0;
        assert.equal(result.lines.length, 200);
        assert.equal(result.ended, 'timeout');
        assert.ok(elapsed < 5000, 'took ' + elapsed + ' ms');
      } finally {
        tuner.closeBridge(handle);
      }
    } finally {
      await flood.close();
    }
  });
});

describe('hangs retry bounded with a plain-words message', () => {
  it('a silent handshake tries three times then names the fix', async () => {
    const silent = await startStub({ silent: true });
    try {
      const t0 = Date.now();
      const err = await tuner.openBridge({
        host: '127.0.0.1',
        port: silent.port,
        handshakeTimeoutMs: 200,
        attempts: 3,
        retryDelaysMs: [50, 50],
      }).then(() => null, (e) => e);
      const elapsed = Date.now() - t0;
      assert.ok(err, 'expected a hang error');
      assert.equal(err.code, 'E_HANG');
      assert.equal(err.message, 'The game is not answering on the tuner port — check it runs windowed with EnableTuner=1, then try again.');
      assert.equal(silent.counts.connections, 3);
      assert.ok(elapsed < 5000, 'took ' + elapsed + ' ms');
    } finally {
      await silent.close();
    }
  });
});

describe('every failure speaks plain words', () => {
  it('refused names the fix for each cause, word for word', () => {
    const generic = tuner.classifyConnectError({ code: 'ECONNREFUSED' }, null);
    assert.equal(generic.code, 'E_REFUSED');
    assert.equal(generic.message, 'Nothing is listening on 127.0.0.1:4318 — start Civilization VI with the Tuner enabled (EnableTuner=1, which disables achievements for the session), then try again.');
    const held = tuner.classifyConnectError({ code: 'ECONNREFUSED' }, { known: true, civ6: true, firetuner: true });
    assert.equal(held.message, 'The tuner takes one connection and it looks like FireTuner is holding it — close the FireTuner window and try again.');
    const off = tuner.classifyConnectError({ code: 'ECONNREFUSED' }, { known: true, civ6: false, firetuner: false });
    assert.equal(off.message, generic.message);
    const noTuner = tuner.classifyConnectError({ code: 'ECONNREFUSED' }, { known: true, civ6: true, firetuner: false });
    assert.equal(noTuner.message, 'The game is running but nothing is listening on 127.0.0.1:4318 — set EnableTuner=1 (this disables achievements for the session) and restart the game, then try again.');
  });
  it('a refused port opens as E_REFUSED, not a hang', async () => {
    const probe = net.createServer();
    const freePort = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)));
    await new Promise((done) => probe.close(done));
    const err = await tuner.openBridge({ host: '127.0.0.1', port: freePort, attempts: 1 }).then(() => null, (e) => e);
    assert.ok(err, 'expected a refusal');
    assert.equal(err.code, 'E_REFUSED');
  });
  it('missing game states refuse reads with the fix, not a guess', async () => {
    const menu = await startStub({
      identity: IDENTITY,
      states: '0\x00Main State\x0030\x00FrontEnd',
      onCmd: (text) => [[-1, 'O\x00FrontEnd: hi'], [-1, 'O\x00FrontEnd: ---END---'], [3, '']],
    });
    try {
      const handle = await tuner.openBridge({ host: '127.0.0.1', port: menu.port });
      try {
        const err = await tuner.executeRead(handle, 'print(1)').then(() => null, (e) => e);
        assert.ok(err, 'expected a no-states error');
        assert.equal(err.code, 'E_NO_STATES');
        assert.equal(err.message, 'The game answered but has no loaded game to talk to — load or start a game first (menus expose no GameCore or InGame state), then try again.');
        const direct = await tuner.executeInState(handle, 30, 'print(1)');
        assert.deepEqual(direct.lines, ['hi']);
      } finally {
        tuner.closeBridge(handle);
      }
    } finally {
      await menu.close();
    }
  });
  it('appendSentinel ends the snippet with the sentinel print', () => {
    assert.equal(tuner.appendSentinel('print(1)'), 'print(1)\nprint("---END---")');
  });
});

describe('thin CLI prints JSON on the same code path', () => {
  let stub = null;
  before(async () => {
    stub = await startStub({
      identity: IDENTITY,
      states: STATES,
      onCmd: (text) => {
        const code = text.slice(text.indexOf(':', 4) + 1);
        if (/NoSuchThing/.test(code)) return [[3, 'ERR:attempt to call a nil value']];
        return [[-1, 'O\x00GameCore_Tuner: 42'], [-1, 'O\x00GameCore_Tuner: ---END---'], [3, '']];
      },
    });
  });
  after(async () => {
    await stub.close();
  });
  function runCli(args, extraEnv) {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [SRCPATH, ...args], {
        env: { ...process.env, TUNER_HOST: '127.0.0.1', TUNER_PORT: String(stub.port), ...(extraEnv || {}) },
        timeout: 20000,
      }, (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
  it('node src/tuner.js "<lua>" prints parsed JSON with the lines', async () => {
    const run = await runCli(['print(40 + 2)']);
    assert.equal(run.code, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.context, 'read');
    assert.deepEqual(parsed.lines, ['42']);
  });
  it('a Lua error exits 4 with a structured envelope', async () => {
    const run = await runCli(['NoSuchThing_xyz()']);
    assert.equal(run.code, 4, run.stdout);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'E_LUA');
  });
  it('an unreachable game exits 3 with plain words', async () => {
    const probe = net.createServer();
    const freePort = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)));
    await new Promise((done) => probe.close(done));
    const run = await runCli(['print(1)'], { TUNER_PORT: String(freePort) });
    assert.equal(run.code, 3, run.stdout);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'E_REFUSED');
    assert.ok(/Nothing is listening|FireTuner|EnableTuner/.test(parsed.message), parsed.message);
  });
});
