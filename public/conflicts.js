'use strict';

// The conflicts view: two read-only diagnostics for the active profile.
//
// This page READS. Both reports are expensive enough to matter (replay runs
// thousands of statements into a disposable copy), so nothing here runs on page
// load: the enumeration and the replay each run only when their button is
// clicked. Both routes are GETs; there is no POST anywhere under
// /api/conflicts, and no control on this page that writes anything.

const cfState = {
  shadow: null,   // last /api/conflicts/shadowing answer
  replay: null,   // last /api/conflicts/replay answer
  running: false,
};

function cfSetRunning(running, label) {
  cfState.running = running;
  $('cfRunShadow').disabled = running;
  $('cfRunReplay').disabled = running;
  $('cfFkMode').disabled = running;
  if (label) $('cfReplayEnv').textContent = label;
}

function cfClaimantHtml(c) {
  const val = c.value === null || c.value === undefined ? 'no declared order' : `LoadOrder ${esc(n(c.value))}`;
  return `<div class="lo-row"><span class="lo-mod">${renderCivText(c.name)}</span>`
    + `<span class="lo-type">${esc((c.sources || []).join('+'))}</span>`
    + `<span class="lo-detail">${esc(val)}</span></div>`;
}

function cfShadowPathHtml(d) {
  if (d.status === 'decided' && d.winner) {
    return `<div class="lo-band"><div class="lo-bandhead"><span class="lo-value">${esc(d.path)}</span>`
      + `<span class="lo-bandnote">winner: ${renderCivText(d.winner.name)} at ${esc(n(d.winner.value))}</span></div>`
      + `${d.claimants.map(cfClaimantHtml).join('')}</div>`;
  }
  const reason = d.reason === 'tie'
    ? `tie at ${esc(n(d.value))} — the game picks arbitrarily, so no winner is named`
    : 'no claimant declares an order — nothing decides this path';
  return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${esc(d.path)}</span>`
    + `<span class="lo-bandnote">undefined: ${reason}</span></div>`
    + `${d.claimants.map(cfClaimantHtml).join('')}</div>`;
}

function cfRenderShadow() {
  const d = cfState.shadow;
  if (!d || !d.ok) return;
  $('cfShadowCount').textContent = n(d.envelope.contested);
  $('cfShadowEnv').innerHTML = `<p>${esc(d.envelopeLine)} — profile “${esc(d.profile.name)}”. `
    + 'A winner is named only when exactly one claimant declares the strictly greatest LoadOrder.</p>';
  $('cfShadowList').innerHTML = d.contested.length
    ? d.contested.map(cfShadowPathHtml).join('')
    : '<p class="note">No contested paths: every UI file is claimed by exactly one enabled mod.</p>';
}

async function cfRunShadowing() {
  if (cfState.running) return;
  cfSetRunning(true);
  $('cfShadowList').innerHTML = '<p class="note">Enumerating…</p>';
  try {
    cfState.shadow = await api('/api/conflicts/shadowing');
    if (!cfState.shadow.ok) throw new Error(cfState.shadow.error || 'enumeration failed');
    cfRenderShadow();
  } catch (err) {
    $('cfShadowList').innerHTML = `<div class="alert warn"><b>Can’t enumerate shadowing.</b> ${esc(err.message)}</div>`;
  } finally {
    cfSetRunning(false);
  }
}

function cfWhoHtml(w) {
  return `${renderCivText(w.modId)} / ${esc(w.fileLabel)} #${esc(n(w.stmtIndex))}`;
}

function cfCollisionHtml(c) {
  const flag = c.fidelityLimited && c.fidelityLimited.length
    ? ` <span class="lo-tag lo-unknown">fidelity-limited: ${esc(c.fidelityLimited.join(', '))}</span>` : '';
  return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${esc(c.table)} · ${esc(String(c.pk))} · ${esc(c.column)}</span>`
    + `<span class="lo-bandnote">${esc(n(c.writes))} writes${flag}</span></div>`
    + `<div class="lo-row"><span class="lo-mod">winner: ${cfWhoHtml(c.winner)}</span></div>`
    + `${c.losers.map((w) => `<div class="lo-row"><span class="lo-mod">loser: ${cfWhoHtml(w)}</span></div>`).join('')}</div>`;
}

function cfRenderReplay() {
  const d = cfState.replay;
  if (!d || !d.ok) return;
  $('cfReplayCount').textContent = n(d.collisions.length);
  const bits = [`${esc(d.envelopeLine)}`, 'replayed in a disposable copy',
    `foreign-key checks ${esc(d.fkMode)}${String(d.fkMode).toLowerCase() === 'on' ? ' — strict, stops each file at the first missing reference' : ' — game-like, keeps going when references are missing'}`, `profile “${esc(d.profile.name)}”`];
  if (d.limitationFlags.length) bits.push(`limited by: ${esc(d.limitationFlags.join(', '))}`);
  if (d.unreadable.length) bits.push(`${esc(n(d.unreadable.length))} unreadable file(s) skipped`);
  if (d.skippedGated) bits.push(`${esc(n(d.skippedGated))} statement(s) gated out`);
  $('cfReplayEnv').innerHTML = `<p>${bits.join(' · ')}</p>`;
  $('cfReplayCollisions').innerHTML = d.collisions.length
    ? d.collisions.map(cfCollisionHtml).join('')
    : '<p class="note">No collisions: no cell was written by two statements in this replay.</p>';
  const gated = [];
  for (const g of d.gatedOut) {
    gated.push(`<div class="lo-row"><span class="lo-mod">${renderCivText(g.modId)} / ${esc(g.fileLabel)}</span>`
      + `<span class="lo-detail">skipped — ${esc(g.reason)}</span></div>`);
  }
  for (const g of d.gatedUnknown) {
    gated.push(`<div class="lo-row"><span class="lo-mod">${renderCivText(g.modId)} / ${esc(g.fileLabel)}</span>`
      + `<span class="lo-detail">ran, but its gate cannot be decided here</span></div>`);
  }
  for (const u of d.unreadable) {
    gated.push(`<div class="lo-row"><span class="lo-mod">${renderCivText(u.modId)} / ${esc(u.file)}</span>`
      + `<span class="lo-detail">unreadable — ${esc(u.reason)}</span></div>`);
  }
  const aborted = d.perFile.filter((f) => f.status === 'aborted');
  for (const f of aborted) {
    gated.push(`<div class="lo-row"><span class="lo-mod">${renderCivText(f.modId)} / ${esc(f.fileLabel)}</span>`
      + `<span class="lo-detail">aborted at statement ${esc(n(f.failedAt))} — ${esc(f.error)}</span></div>`);
  }
  $('cfReplayGated').innerHTML = gated.length
    ? gated.join('')
    : '<p class="note">Nothing gated out, unreadable, or aborted.</p>';
  const diff = d.differential;
  let diffHtml;
  if (!diff || !diff.available) {
    diffHtml = `<p class="note">No differential: ${esc((diff && diff.reason) || 'Database.log is unavailable')}.</p>`;
  } else {
    const rows = [];
    for (const a of diff.agreements) {
      rows.push(`<div class="lo-row"><span class="lo-mod">agree: ${esc(a.fileLabel)} #${esc(n(a.stmtIndex))}</span>`
        + `<span class="lo-detail">matches Database.log line ${esc(n(a.logLine))}</span></div>`);
    }
    for (const r of diff.replayOnly) {
      rows.push(`<div class="lo-row"><span class="lo-mod">replay-only: ${esc(r.fileLabel)} #${esc(n(r.stmtIndex))}</span>`
        + `<span class="lo-detail">${esc(r.replayError)}</span></div>`);
    }
    for (const l of diff.logOnly) {
      rows.push(`<div class="lo-row"><span class="lo-mod">log-only: ${esc(l.fileLabel || '(unattributed)')} #${l.stmtIndex == null ? '?' : esc(n(l.stmtIndex))}</span>`
        + `<span class="lo-detail">Database.log line ${esc(n(l.logLine))}: ${esc(l.logText)}</span></div>`);
    }
    diffHtml = rows.length ? rows.join('') : '<p class="note">Replay and Database.log agree: no errors on either side.</p>';
  }
  $('cfReplayDiff').innerHTML = diffHtml;
}

async function cfRunReplay() {
  if (cfState.running) return;
  cfSetRunning(true, 'Replaying…');
  $('cfReplayCollisions').innerHTML = '<p class="note">Replaying the profile in a disposable copy…</p>';
  $('cfReplayGated').innerHTML = '';
  $('cfReplayDiff').innerHTML = '';
  try {
    const fk = $('cfFkMode').value === 'on' ? 'on' : 'off';
    cfState.replay = await api(`/api/conflicts/replay?fk=${fk}`);
    if (!cfState.replay.ok) throw new Error(cfState.replay.error || 'replay failed');
    cfRenderReplay();
  } catch (err) {
    $('cfReplayEnv').innerHTML = `<div class="alert warn"><b>Can’t replay.</b> ${esc(err.message)}</div>`;
  } finally {
    cfSetRunning(false);
  }
}

// Page entry: reset the outputs and leave the buttons armed. Nothing fetches
// here - the reports run only on click, never on page load.
function cfShowConflicts() {
  cfState.shadow = null;
  cfState.replay = null;
  $('cfShadowCount').textContent = '';
  $('cfShadowEnv').innerHTML = '<p>Enumerates every UI path claimed by more than one enabled mod. '
    + 'Runs only when you click — never on page load.</p>';
  $('cfShadowList').innerHTML = '';
  $('cfReplayCount').textContent = '';
  $('cfReplayEnv').innerHTML = '<p>Replays the profile’s database files in load order inside a disposable copy — never the live game database — '
    + 'and names the winner of every contested cell. Runs only when you click.</p>';
  $('cfReplayCollisions').innerHTML = '';
  $('cfReplayGated').innerHTML = '';
  $('cfReplayDiff').innerHTML = '';
}

$('cfRunShadow').addEventListener('click', () => { cfRunShadowing().catch((err) => toast(err.message, 'err')); });
$('cfRunReplay').addEventListener('click', () => { cfRunReplay().catch((err) => toast(err.message, 'err')); });

pages['conflicts'] = { show: cfShowConflicts };
