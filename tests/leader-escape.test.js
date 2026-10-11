'use strict';

// Mirror for the leader-screen Escape (ADR-017): the detector's parked,
// in-map and still-loading verdicts, per-load scoping of stale markers, the
// mtime gate on real temp logs, and the bounded closed loop run with stubs.
// Focus, key, log and sleep functions are injected, so no test sends a key
// or touches the game window.
//
// Run with `node --test tests/leader-escape.test.js`.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp } = require('./helpers');
const leader = require('../src/leader-escape');
const { parseGameProcesses } = require('../src/game');

const TMP = makeTmp('civ6-leader-escape-');

const VIEW_BEGIN = '[2026-10-11 19:15:01]\tLoadGameViewState::Begin()\n';
const VIEW_WAIT = '[2026-10-11 19:15:44]\tWAIT_FOR_PLAYERS End\n[2026-10-11 19:15:46]\tPostLoadTime: 2.1140 seconds\n';
const VIEW_END = '[2026-10-11 19:22:19]\tLoadGameViewState::End()\n[2026-10-11 19:22:19]\tLoadGameViewState::UnloadUI()\n';
const NET_REQUEST = '[2026-10-11 19:14:55]\tDoLoadRequest() leaving the network session.\n';
const NET_JOINED = '[2026-10-11 19:15:44]\tMultiplayerJoinGameComplete, client joined game.\n';
const NET_QUEUE_END = '[2026-10-11 19:22:19]\tCanRecieveMessage: Queuing Messages End, Previous State = kRecieveMessage_LoadInProgress\n';
const NET_TURN = '[2026-10-11 19:22:19]\tGame Turn: 166\n';
const NET_INITIAL = '[2026-10-11 19:22:19]\tGameCore SEND: GameUpdate: From=0, Passes=1, InitialTurnProcessing=1\n';
const LUA_DONE = 'LoadScreen: OnLoadGameViewStateDone\n';

const PARKED = { loadView: VIEW_BEGIN + VIEW_WAIT, net: NET_REQUEST + NET_JOINED, lua: LUA_DONE };
const IN_MAP = {
  loadView: VIEW_BEGIN + VIEW_WAIT + VIEW_END,
  net: NET_REQUEST + NET_JOINED + NET_QUEUE_END + NET_TURN + NET_INITIAL,
  lua: LUA_DONE,
};
const LOADING = { loadView: VIEW_BEGIN, net: NET_REQUEST, lua: '' };
const JOIN_ONLY = { loadView: VIEW_BEGIN + 'WAIT_FOR_PLAYERS End\n', net: NET_REQUEST + NET_JOINED, lua: LUA_DONE };

const fromStub = (logs) => ({ readLogs: () => logs });

describe('leader-waiting detector', () => {
  it('a game parked at the leader screen reads as waiting', () => {
    assert.equal(leader.isLeaderWaiting(0, fromStub(PARKED)), true);
  });
  it('a game already in the map does not read as waiting', () => {
    assert.equal(leader.isLeaderWaiting(0, fromStub(IN_MAP)), false);
  });
  it('a game still loading does not read as waiting', () => {
    assert.equal(leader.isLeaderWaiting(0, fromStub(LOADING)), false);
  });
  it('the join marker before PostLoadTime does not read as parked yet', () => {
    assert.equal(leader.isLeaderWaiting(0, fromStub(JOIN_ONLY)), false);
  });
  it('missing logs do not read as waiting', () => {
    assert.equal(leader.isLeaderWaiting(0, { logsDirs: [] }), false);
  });
  it('a join from an earlier load does not park this one', () => {
    const logs = {
      loadView: VIEW_BEGIN + VIEW_WAIT,
      net: NET_REQUEST + NET_JOINED + NET_REQUEST,
      lua: LUA_DONE,
    };
    assert.equal(leader.isLeaderWaiting(0, fromStub(logs)), false);
  });
  it('a finished earlier load does not block a new parked one', () => {
    const logs = {
      loadView: VIEW_BEGIN + VIEW_WAIT + VIEW_END + VIEW_BEGIN + VIEW_WAIT,
      net: NET_REQUEST + NET_JOINED + NET_QUEUE_END + NET_TURN + NET_REQUEST + NET_JOINED,
      lua: LUA_DONE,
    };
    assert.equal(leader.isLeaderWaiting(0, fromStub(logs)), true);
  });
});

describe('log reads on disk', () => {
  function writeLogs(dir, logs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LoadGameViewState.log'), logs.loadView);
    fs.writeFileSync(path.join(dir, 'net_message_debug.log'), logs.net);
    fs.writeFileSync(path.join(dir, 'Lua.log'), logs.lua);
    return dir;
  }
  function datedAgo(dir, ms) {
    const when = new Date(Date.now() - ms);
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), when, when);
  }
  it('logs older than the load are not read', () => {
    const dir = writeLogs(path.join(TMP, 'stale'), PARKED);
    datedAgo(dir, 600000);
    assert.deepEqual(leader.defaultReadLogs(Date.now() - 60000, [dir]), { loadView: null, net: null, lua: null });
    assert.equal(leader.isLeaderWaiting(Date.now() - 60000, { logsDirs: [dir] }), false);
  });
  it('fresh logs are read, and a parked game reads as waiting', () => {
    const dir = writeLogs(path.join(TMP, 'fresh'), PARKED);
    assert.equal(leader.isLeaderWaiting(Date.now() - 60000, { logsDirs: [dir] }), true);
  });
});

describe('leader Escape closed loop', () => {
  // The game stays parked until a key lands, then shows the map unless a
  // test overrides readLogs. Timings are zero, so the loop runs instantly.
  function rig(over = {}) {
    const calls = { keys: [], focus: [] };
    const base = {
      loadSinceMs: 1,
      readLogs: () => (calls.keys.length > 0 ? IN_MAP : PARKED),
      findPidFn: () => Promise.resolve(4242),
      focusFn: (pid) => { calls.focus.push(pid); return Promise.resolve(true); },
      sendKeyFn: (pid) => { calls.keys.push(pid); return Promise.resolve(true); },
      sleeper: () => Promise.resolve(),
      pollMs: 1,
      settleMs: 0,
      mapWaitMs: 3,
    };
    return { opts: { ...base, ...over }, calls };
  }

  it('a parked game gets one Escape, and the map confirms it', async () => {
    const { opts, calls } = rig();
    const r = await leader.escapeLeaderScreen(opts);
    assert.deepEqual(r, { state: 'loaded', presses: 1 });
    assert.deepEqual(calls.keys, [4242]);
    assert.deepEqual(calls.focus, [4242]);
  });

  it('a game still parked after the wait gets a second Escape, then the map', async () => {
    const { opts, calls } = rig({ readLogs: () => (calls.keys.length >= 2 ? IN_MAP : PARKED) });
    const r = await leader.escapeLeaderScreen(opts);
    assert.deepEqual(r, { state: 'loaded', presses: 2 });
    assert.equal(calls.keys.length, 2);
  });

  it('a game that never leaves the leader screen gets exactly three Escapes, then the manual-click message', async () => {
    const { opts, calls } = rig({ readLogs: () => PARKED });
    const r = await leader.escapeLeaderScreen(opts);
    assert.equal(calls.keys.length, 3);
    assert.equal(r.state, 'needsManualClick');
    assert.equal(r.presses, 3);
    assert.equal(r.needsManualClick, leader.LEADER_MANUAL_CLICK);
    assert.match(r.needsManualClick, /Click the globe or press Escape/);
  });

  it('a game that is not parked at the start gets zero Escapes', async () => {
    const { opts, calls } = rig({ readLogs: () => LOADING });
    const r = await leader.escapeLeaderScreen(opts);
    assert.deepEqual(r, { state: 'not-waiting', presses: 0 });
    assert.equal(calls.keys.length, 0);
  });

  it('a game already in the map at the start is confirmed without an Escape', async () => {
    const { opts, calls } = rig({ readLogs: () => IN_MAP });
    const r = await leader.escapeLeaderScreen(opts);
    assert.deepEqual(r, { state: 'loaded', presses: 0 });
    assert.equal(calls.keys.length, 0);
  });

  it('the settle window waits for PostLoadTime, after the join marker lands first', async () => {
    let reads = 0;
    const { opts, calls } = rig({
      settleMs: 5000,
      readLogs: () => {
        if (calls.keys.length > 0) return IN_MAP;
        reads += 1;
        return reads < 3 ? JOIN_ONLY : PARKED;
      },
    });
    const r = await leader.escapeLeaderScreen(opts);
    assert.deepEqual(r, { state: 'loaded', presses: 1 });
    assert.equal(calls.keys.length, 1);
  });

  it('a focus failure sends no Escape and gives a plain-words reason', async () => {
    const { opts, calls } = rig({ focusFn: () => Promise.resolve(false) });
    const r = await leader.escapeLeaderScreen(opts);
    assert.equal(calls.keys.length, 0);
    assert.equal(r.state, 'needsManualClick');
    assert.equal(r.presses, 0);
    assert.equal(r.needsManualClick, leader.LEADER_FOCUS_FAILED);
    assert.match(r.needsManualClick, /could not bring the game window forward/);
    assert.doesNotMatch(r.needsManualClick, /AppActivate|PID|4242/);
  });

  it('no running game process sends no Escape and gives the same reason', async () => {
    const { opts, calls } = rig({ findPidFn: () => Promise.resolve(null) });
    const r = await leader.escapeLeaderScreen(opts);
    assert.equal(calls.keys.length, 0);
    assert.equal(r.needsManualClick, leader.LEADER_FOCUS_FAILED);
  });

  it('a game that leaves the leader screen with no map markers is unconfirmed, with no second Escape', async () => {
    const { opts, calls } = rig({ readLogs: () => (calls.keys.length > 0 ? LOADING : PARKED) });
    const r = await leader.escapeLeaderScreen(opts);
    assert.deepEqual(r, { state: 'unconfirmed', presses: 1 });
    assert.equal(calls.keys.length, 1);
  });
});

describe('leader Escape helpers', () => {
  it('the game process lookup prefers the DX12 executable', () => {
    const procs = [
      { name: 'CivilizationVI.exe', pid: 7 },
      { name: 'CivilizationVI_DX12.exe', pid: 9 },
    ];
    assert.equal(leader.pickGamePid(procs), 9);
    assert.equal(leader.pickGamePid([{ name: 'CivilizationVI.exe', pid: 7 }]), 7);
    assert.equal(leader.pickGamePid([]), null);
  });
  it('tasklist rows keep only the game executables with their PIDs', () => {
    const csv = [
      '"CivilizationVI_DX12.exe","19520","Console","1","2.148.000 K"',
      '"notepad.exe","4","Console","1","9 K"',
      '"CivilizationVI.exe","88","Console","1","1 K"',
    ].join('\r\n');
    assert.deepEqual(parseGameProcesses(csv), [
      { name: 'CivilizationVI_DX12.exe', pid: 19520 },
      { name: 'CivilizationVI.exe', pid: 88 },
    ]);
  });
  it('an invalid process ID is refused without sending anything', async () => {
    assert.equal(await leader.focusGame(0), false);
    assert.equal(await leader.focusGame(Number.NaN), false);
    assert.equal(await leader.sendEscape(-1), false);
  });
});
