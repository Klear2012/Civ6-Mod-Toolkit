'use strict';

// Detects whether Civilization VI is running. Changing the mod database while
// the game is open is unsafe, so the mod manager blocks writes in that case.

const { execFile } = require('child_process');

// CivilizationVI.exe, CivilizationVI_DX12.exe, ...
const GAME_EXE = /^civilizationvi(_dx12)?\.exe$/i;

/** Game processes as { name, pid }; known is false when tasklist cannot answer. */
function gameProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ known: false, processes: [] });
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ known: false, processes: [] });
      resolve({ known: true, processes: parseGameProcesses(out) });
    });
  });
}

/** Game rows of tasklist CSV output (`"Image","PID",...`). */
function parseGameProcesses(csv) {
  const processes = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m && GAME_EXE.test(m[1])) processes.push({ name: m[1], pid: Number(m[2]) });
  }
  return processes;
}

function gameStatus() {
  return gameProcesses().then(({ known, processes }) => {
    const names = [...new Set(processes.map((p) => p.name))];
    return { running: names.length > 0, known, processes: names };
  });
}

module.exports = { gameStatus, gameProcesses, parseGameProcesses };
