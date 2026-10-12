'use strict';

// Leader-screen Escape (see ADR-017). After a save load the game can park at
// the Begin Game (leader) screen and wait for the player. The logs tell a
// parked game apart from one still loading or already in the map, and Escape
// is pressed only after a positive match. Focus is by process ID; no mouse
// input, coordinates, OCR, or screenshots.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { gameProcesses } = require('./game');

const LOG_FILES = {
  loadView: 'LoadGameViewState.log',
  net: 'net_message_debug.log',
  lua: 'Lua.log',
};
// Per-load boundaries: the view log restarts at Begin(), the network log at
// DoLoadRequest(). Markers before the last boundary belong to earlier loads.
const VIEW_BOUNDARY = 'LoadGameViewState::Begin()';
const NET_BOUNDARY = 'DoLoadRequest()';

const GAME_NAMES = ['CivilizationVI_DX12.exe', 'CivilizationVI.exe'];
const MAX_ATTEMPTS = 3;
const SETTLE_MS = 60000;
const MAP_WAIT_MS = 15000;
const POLL_MS = 1000;

const LEADER_MANUAL_CLICK = 'The save loaded to the Begin Game screen. Click the globe or press Escape to start playing.';
const LEADER_FOCUS_FAILED = 'The save loaded to the Begin Game screen, but the toolkit could not bring the game window forward to press Escape. Click the game window, then press Escape to start playing.';

function afterLast(text, marker) {
  const at = text.lastIndexOf(marker);
  return at < 0 ? text : text.slice(at + marker.length);
}

function scopedLogs(logs) {
  return {
    view: afterLast(logs.loadView || '', VIEW_BOUNDARY),
    net: afterLast(logs.net || '', NET_BOUNDARY),
    lua: logs.lua || '',
  };
}

/** Whether the logs of the current load show the game parked at the leader screen. */
function parkedIn(logs) {
  const { view, net, lua } = scopedLogs(logs);
  const parkedView = /WAIT_FOR_PLAYERS End/.test(view) && /PostLoadTime:/.test(view)
    && !/LoadGameViewState::End\(\)/.test(view) && !/UnloadUI\(\)/.test(view);
  const parkedNet = /MultiplayerJoinGameComplete/.test(net)
    && !/Queuing Messages End/.test(net) && !/Game Turn:/.test(net)
    && !/InitialTurnProcessing=1/.test(net);
  return parkedView && parkedNet && /LoadScreen: OnLoadGameViewStateDone/.test(lua);
}

/** Whether the logs of the current load show the map was entered. */
function mapEnteredIn(logs) {
  const { view, net } = scopedLogs(logs);
  return /LoadGameViewState::End\(\)/.test(view) || /UnloadUI\(\)/.test(view)
    || /InitialTurnProcessing=1/.test(net);
}

function readFresh(file, sinceMs) {
  try {
    if (sinceMs && fs.statSync(file).mtimeMs < sinceMs) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

/** The three logs as text, each from the first folder rewritten since sinceMs. */
function defaultReadLogs(sinceMs, logsDirs = []) {
  const logs = {};
  for (const [key, name] of Object.entries(LOG_FILES)) {
    logs[key] = null;
    for (const dir of logsDirs) {
      const text = readFresh(path.join(dir, name), sinceMs);
      if (text !== null) {
        logs[key] = text;
        break;
      }
    }
  }
  return logs;
}

function logsFor(sinceMs, opts) {
  return opts.readLogs ? opts.readLogs(sinceMs) : defaultReadLogs(sinceMs, opts.logsDirs);
}

/**
 * Whether the game is parked at the leader screen for the load that began
 * after loadSinceMs. Any doubt (missing logs, still loading, map entered)
 * reads as false, so no key is ever sent on a guess.
 */
function isLeaderWaiting(loadSinceMs, opts = {}) {
  return parkedIn(logsFor(loadSinceMs, opts));
}

function pickGamePid(processes) {
  for (const name of GAME_NAMES) {
    const hit = processes.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.pid;
  }
  return null;
}

async function findGamePid() {
  const { processes } = await gameProcesses();
  return pickGamePid(processes);
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 20000 }, (err) => resolve(!err));
  });
}

/** Bring the game window forward by process ID. Resolves whether it took focus. */
function focusGame(pid) {
  if (!validPid(pid)) return Promise.resolve(false);
  return runPowerShell(`$w = New-Object -ComObject WScript.Shell; if (-not $w.AppActivate(${pid})) { exit 1 }`);
}

/** Send the one Escape key, only after the game window takes focus. */
function sendEscape(pid) {
  if (!validPid(pid)) return Promise.resolve(false);
  return runPowerShell(`$w = New-Object -ComObject WScript.Shell; if (-not $w.AppActivate(${pid})) { exit 1 }; Start-Sleep -Milliseconds 200; $w.SendKeys('{ESC}')`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Settle on the leader verdict, then press Escape until the map shows up.
 * Each press needs a fresh focus and a parked reading first. A game still
 * parked after the wait gets another press, up to MAX_ATTEMPTS.
 *
 * Resolves loaded (map markers seen), not-waiting (no key sent),
 * unconfirmed (left the leader screen without map markers), or
 * needsManualClick with a plain-words reason. Never throws. The hooks
 * (readLogs, findPidFn, focusFn, sendKeyFn, sleeper, timings) keep tests
 * off the game window.
 */
async function escapeLeaderScreen(opts = {}) {
  const sinceMs = opts.loadSinceMs || 0;
  const readNow = () => logsFor(sinceMs, opts);
  const wait = opts.sleeper || sleep;
  const pollMs = Math.max(1, opts.pollMs == null ? POLL_MS : opts.pollMs);
  const settleMs = opts.settleMs == null ? SETTLE_MS : opts.settleMs;
  const polls = Math.max(1, Math.ceil((opts.mapWaitMs == null ? MAP_WAIT_MS : opts.mapWaitMs) / pollMs));
  const maxAttempts = opts.maxAttempts == null ? MAX_ATTEMPTS : opts.maxAttempts;
  const findPid = opts.findPidFn || findGamePid;
  const focus = opts.focusFn || focusGame;
  const sendKey = opts.sendKeyFn || sendEscape;

  const settleStart = Date.now();
  for (;;) {
    const logs = readNow();
    if (mapEnteredIn(logs)) {
      console.log('Leader-screen Escape: already in the map, no Escape sent.');
      return { state: 'loaded', presses: 0 };
    }
    if (parkedIn(logs)) break;
    if (Date.now() - settleStart >= settleMs) {
      console.log('Leader-screen Escape: never parked at the Begin Game screen, no Escape sent.');
      return { state: 'not-waiting', presses: 0 };
    }
    await wait(pollMs);
  }
  console.log(`Leader-screen Escape: parked at the Begin Game screen (settled after ${Date.now() - settleStart} ms).`);

  let presses = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pid = await findPid();
    const focused = validPid(pid) ? await focus(pid) : false;
    console.log(`Leader-screen Escape: attempt ${attempt}/${maxAttempts} (game process ${pid == null ? 'not found' : pid}, focus ${focused ? 'ok' : 'failed'}).`);
    if (!focused) {
      console.log(`Leader-screen Escape: finished as needsManualClick after ${presses} Escape press(es).`);
      return { state: 'needsManualClick', presses, needsManualClick: LEADER_FOCUS_FAILED };
    }
    const sent = await sendKey(pid);
    console.log(`Leader-screen Escape: attempt ${attempt}/${maxAttempts} Escape send ${sent === false ? 'failed' : 'ok'}.`);
    if (sent === false) {
      console.log(`Leader-screen Escape: finished as needsManualClick after ${presses} Escape press(es).`);
      return { state: 'needsManualClick', presses, needsManualClick: LEADER_FOCUS_FAILED };
    }
    presses += 1;
    let logs = null;
    for (let i = 0; i < polls; i += 1) {
      await wait(pollMs);
      logs = readNow();
      if (mapEnteredIn(logs)) {
        console.log(`Leader-screen Escape: map entered after attempt ${attempt}, finished as loaded with ${presses} Escape press(es).`);
        return { state: 'loaded', presses };
      }
    }
    if (!parkedIn(logs)) {
      console.log(`Leader-screen Escape: left the Begin Game screen with no map markers after attempt ${attempt}, finished as unconfirmed with ${presses} Escape press(es).`);
      return { state: 'unconfirmed', presses };
    }
    console.log(`Leader-screen Escape: still parked after attempt ${attempt} (${presses} Escape press(es) so far).`);
  }
  console.log(`Leader-screen Escape: still parked after ${maxAttempts} attempt(s), finished as needsManualClick with ${presses} Escape press(es).`);
  return { state: 'needsManualClick', presses, needsManualClick: LEADER_MANUAL_CLICK };
}

module.exports = {
  LEADER_MANUAL_CLICK,
  LEADER_FOCUS_FAILED,
  isLeaderWaiting,
  escapeLeaderScreen,
  defaultReadLogs,
  pickGamePid,
  focusGame,
  sendEscape,
};
