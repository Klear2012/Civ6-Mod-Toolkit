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
  diffFilter: '',        // exact-match mod search over differential groups
  hideUnattributed: false,
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

function cfWarningHtml(w) {
  if (w.kind === 'split-brain') {
    return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${esc(w.luaPath)} + ${esc(w.xmlPath)}</span>`
      + `<span class="lo-bandnote">split pair — the screen and its layout come from different winners</span></div>`
      + `<div class="lo-row"><span class="lo-mod">${esc(w.luaPath)} loads from ${renderCivText(w.luaWinner.name)}</span></div>`
      + `<div class="lo-row"><span class="lo-mod">${esc(w.xmlPath)} loads from ${renderCivText(w.xmlWinner.name)}</span></div>`
      + `<div class="lo-row"><span class="lo-detail">The game loads each file from its named winner, so the two halves can disagree. Keep the pair in one mod, or open both files and check they still fit together.</span></div></div>`;
  }
  const where = w.scope === 'frontend' ? 'a front-end action' : 'an in-game action';
  const what = w.dir === 'gameplay-in-frontend'
    ? 'a gameplay script, which only runs inside a loaded game — in the menu shell it never runs. Move it to an in-game action.'
    : w.dir === 'script-in-data-action'
      ? 'a script file where the game reads database content, so it fails to load as data. Move it to a script action, or drop it from the action.'
      : 'a database file where the game loads a script, so it fails to load as code. Move it to a database action.';
  const action = w.actionId == null ? esc(w.actionType) : `${esc(w.actionType)} “${esc(w.actionId)}”`;
  return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${renderCivText(w.name)} — ${action} in ${where}</span>`
    + `<span class="lo-bandnote">wrong context — ${esc(w.dir)}</span></div>`
    + `${(w.files || []).map((f) => `<div class="lo-row"><span class="lo-mod">${esc(f)}</span></div>`).join('')}`
    + `<div class="lo-row"><span class="lo-detail">This is ${what}</span></div></div>`;
}

function cfRenderShadow() {
  const d = cfState.shadow;
  if (!d || !d.ok) return;
  $('cfShadowCount').textContent = n(d.envelope.contested);
  $('cfShadowEnv').innerHTML = `<p>${esc(d.envelopeLine)} — profile “${esc(d.profile.name)}”. `
    + 'A winner is named only when exactly one claimant declares the strictly greatest LoadOrder.</p>';
  const warns = (d.envelope && d.envelope.warnings) || [];
  const warnHtml = warns.length
    ? `<p class="note">${esc(n(warns.length))} pairing/placement warning${warns.length === 1 ? '' : 's'} — every row names a real problem, but a clean report does not mean the profile is clean.</p>`
      + warns.map(cfWarningHtml).join('')
    : '';
  $('cfShadowList').innerHTML = warnHtml + (d.contested.length
    ? d.contested.map(cfShadowPathHtml).join('')
    : '<p class="note">No contested paths: every UI file is claimed by exactly one enabled mod.</p>');
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

function cfResponsibleHtml(row) {
  const name = (row && (row.responsibleModName || row.responsibleModId)) || null;
  return name ? renderCivText(name) : esc('Mod unknown');
}

// Plain words, never backend jargon: the raw strengths (context-proven,
// hint-matched, bracket-approximate) mean nothing to a player, so each maps
// to a short tag whose tooltip says what to do next. An unattributed row
// never carries an attributing label, whatever the backend sent.
function cfStrengthTag(row) {
  if (!row) return '';
  const attributed = !!(row.responsibleModId || row.responsibleModName);
  if (!attributed) {
    const attr = row.attribution || {};
    if (attr.kind === 'bracket-ambiguous' && Array.isArray(attr.candidates) && attr.candidates.length) {
      return ' <span class="lo-tag lo-unknown" title="Two or more mods were loading at the same moment, so no single mod can be named — open each candidate file and check.">several possible</span>';
    }
    return ' <span class="lo-tag lo-unknown" title="Neither the game log nor the replay could name the mod behind this — read the statement text for clues, then check your mod files.">no mod named</span>';
  }
  if (row.strength === 'replay') return ' <span class="lo-tag" title="The replay raised this and the game log stayed silent — open the file at the named statement.">found by replay</span>';
  if (row.strength === 'context-proven') return ' <span class="lo-tag" title="The game log names this mod’s file at the same moment — open that file and check the statement.">traced to this mod</span>';
  if (row.strength === 'hint-matched') return ' <span class="lo-tag" title="Only the file name points here — open the file and check it belongs to this mod.">matched by file name</span>';
  if (row.strength === 'bracket-approximate') {
    return ' <span class="lo-tag" title="No file was named, so this is the mod loading nearest in time — treat it as a lead, not proof.">best guess</span>'
      + (row.approximate ? ' <span class="lo-tag lo-unknown" title="This is a rough guess, not proof — open the named file before changing anything.">approximate</span>' : '');
  }
  if (!row.strength || row.strength === 'unattributed') return '';
  return ` <span class="lo-tag">${esc(row.strength)}</span>`;
}

// Backend reason codes in average-player words. Unknown codes pass through
// escaped rather than dropped, so a new reason reads raw instead of silent.
function cfPlainReason(reason) {
  const r = String(reason == null ? '' : reason);
  if (!r) return '';
  if (r === 'no-loading-precedes') return 'nothing was loading just before, so there is nothing to guess from';
  if (r === 'no-log-entry') return 'the game log has no matching line';
  if (r === 'no-source-path') return 'the log names no file';
  if (r === 'path-not-mapped') return 'the file path matches no installed mod';
  if (r === 'file-hint-only') return 'the log names a file but no mod';
  if (r === 'same-ms-ambiguity') return 'two or more mods were loading at the same moment';
  if (r === 'no-error-timestamp') return 'the log line carries no timestamp to match on';
  const w = /^workshop-id-not-installed:(.+)$/.exec(r);
  if (w) return `that workshop item (${w[1]}) is not installed`;
  return r;
}

function cfAttributionNote(row) {
  const attr = (row && row.attribution) || {};
  if (attr.kind === 'bracket-ambiguous' && Array.isArray(attr.candidates) && attr.candidates.length) {
    const names = attr.candidates.map((c) => renderCivText(
      (c && c.attribution && (c.attribution.modName || c.attribution.modId)) || (c && c.path) || '?')).join(', ');
    return ` — could be ${names}: they were loading at the same moment, so open each file and check`;
  }
  if (attr.loadingPath) {
    return ` — seen while the game was loading ${esc(attr.loadingPath)}: a lead, not proof`;
  }
  if ((attr.kind === 'hint' || attr.fileHint) && !row.responsibleModId) {
    return ' — file name only, no mod proven: open the file and check which mod owns it';
  }
  if (!row.responsibleModId && attr.reason) return ` — ${esc(cfPlainReason(attr.reason))}`;
  return '';
}

function cfCalibrationHtml(cal) {
  if (!cal) return '';
  if (!cal.available) {
    return `<p class="note">No load-order calibration: ${esc((cal && cal.reason) || 'the game’s loading log is unavailable')}.</p>`;
  }
  const divs = cal.divergences || [];
  if (!divs.length) {
    return '<p class="note">Load-order calibration: the replay order matches the game-observed order — no divergences.</p>';
  }
  return `<p class="note">${esc(n(divs.length))} load-order divergence${divs.length === 1 ? '' : 's'}: `
    + 'the game loaded these files in the opposite order to the replay assumption.</p>'
    + divs.map((dv) => `<div class="lo-row"><span class="lo-mod">order differs: ${esc(dv.assumedFirst)} / ${esc(dv.assumedSecond)}</span>`
      + `<span class="lo-detail">${esc(dv.assumedOrder)} — but ${esc(dv.observedOrder)}</span></div>`).join('');
}

// The differential as one list: agreements, replay-only, and log-only rows
// together, so grouping below sees every row.
function cfDiffRows() {
  const d = cfState.replay && cfState.replay.differential;
  if (!d || !d.available) return null;
  const rows = [];
  for (const a of d.agreements || []) rows.push({ ...a, side: 'agree' });
  for (const r of d.replayOnly || []) rows.push({ ...r, side: 'replay-only' });
  for (const l of d.logOnly || []) rows.push({ ...l, side: 'log-only' });
  return rows;
}

// Same side plus same failure text: one mod failing the same way in several
// files (three language files, one missing table) reads as one finding.
function cfDiffFailureKey(row) {
  const msg = row.side === 'replay-only' ? (row.replayError || '')
    : (row.logText || row.replayError || row.message || '');
  return `${row.side}|${String(msg).trim().toLowerCase()}`;
}

function cfCollapseDiffRows(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    const k = cfDiffFailureKey(row);
    if (!seen.has(k)) seen.set(k, { first: row, rows: [] });
    seen.get(k).rows.push(row);
  }
  return [...seen.values()];
}

// Markup-free display name for searching and sorting. Local regex rather
// than stripCivText so grouping never depends on another script loading.
function cfPlainModName(name) {
  return String(name == null ? '' : name).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Groups keyed by responsible mod, attributed first, then A–Z; the unattributed
// group always sorts last.
function cfDiffGroups() {
  const rows = cfDiffRows();
  if (!rows) return null;
  const byMod = new Map();
  for (const row of rows) {
    const key = row.responsibleModId || ' unattributed';
    if (!byMod.has(key)) byMod.set(key, { modId: row.responsibleModId || null, name: row.responsibleModName || null, rows: [] });
    byMod.get(key).rows.push(row);
  }
  const groups = [...byMod.values()].map((g) => ({ ...g, findings: cfCollapseDiffRows(g.rows) }));
  groups.sort((a, b) => {
    const au = a.modId ? 0 : 1;
    const bu = b.modId ? 0 : 1;
    if (au !== bu) return au - bu;
    return cfPlainModName(a.name).toLowerCase().localeCompare(cfPlainModName(b.name).toLowerCase());
  });
  return groups;
}

// Exact-match mod search, reusing the load-order pattern: the full display
// name or nothing. The unattributed group never matches a typed name.
function cfDiffGroupVisible(g, q) {
  if (!q) return true;
  if (!g.modId) return false;
  return cfPlainModName(g.name || g.modId).toLowerCase() === q;
}

function cfDiffSideLabel(side) {
  if (side === 'agree') return 'Replay and log agree';
  if (side === 'replay-only') return 'Replay only';
  return 'Game log only';
}

function cfDiffRowHtml(f) {
  const r = f.first;
  const files = [...new Set(f.rows.map((x) => x.fileLabel || '(no file hint)'))];
  const stmt = r.stmtIndex == null ? '' : `, statement ${esc(n(r.stmtIndex))}`;
  const what = files.length > 1
    ? `${esc(n(files.length))} files, same error — ${files.map((x) => esc(x)).join(', ')}${stmt}`
    : `${esc(files[0])}${stmt}`;
  let detail = '';
  if (r.side === 'agree') {
    const logNote = (r.logModId && r.responsibleModId && r.logModId !== r.responsibleModId)
      ? ` — log points to ${renderCivText(r.logModName || r.logModId)}` : '';
    detail = `matches game-log line ${esc(n(r.logLine))}${logNote}`;
  } else if (r.side === 'replay-only') {
    detail = esc(r.replayError);
  } else {
    detail = `game-log line ${esc(n(r.logLine))}: ${esc(r.logText)}${cfAttributionNote(r)}`;
  }
  const tip = r.side === 'agree'
    ? 'Both sides report this — open the file at the named statement.'
    : r.side === 'replay-only'
      ? 'Only the replay raised this — open the file at the named statement and check it.'
      : 'Only the game log reports this — read the line, then open the named file if there is one.';
  return `<div class="lo-row" title="${tip}"><span class="lo-mod">${esc(cfDiffSideLabel(r.side))}: ${what}</span>${cfStrengthTag(r)}`
    + `<span class="lo-detail">${detail}</span></div>`;
}

function cfDiffGroupHtml(g) {
  const count = `${esc(n(g.findings.length))} finding${g.findings.length === 1 ? '' : 's'}`;
  const head = g.modId
    ? `<span class="lo-value">${renderCivText(g.name || g.modId)}</span><span class="lo-bandnote">${count}</span>`
    : `<span class="lo-value" title="These errors name no mod — read the statement text for clues, then check your mod files.">Mod unknown</span>`
      + `<span class="lo-bandnote">${count} no mod could be named for</span>`;
  return `<div class="lo-band"><div class="lo-bandhead">${head}</div>`
    + `${g.findings.map(cfDiffRowHtml).join('')}</div>`;
}

// Differential section only, so the search box and the toggle re-render it
// without touching the collisions or the gated-out lists.
function cfRenderDiff() {
  const d = cfState.replay;
  if (!d || !d.ok) return;
  const diff = d.differential;
  let html;
  let note = '';
  if (!diff || !diff.available) {
    html = `<p class="note">No comparison: ${esc((diff && diff.reason) || 'the game log is unavailable')}.</p>`;
  } else {
    const q = (cfState.diffFilter || '').trim().toLowerCase();
    const all = cfDiffGroups() || [];
    const total = all.reduce((s, g) => s + g.findings.length, 0);
    const hidden = cfState.hideUnattributed
      ? all.filter((g) => !g.modId).reduce((s, g) => s + g.findings.length, 0) : 0;
    const groups = all
      .filter((g) => !(cfState.hideUnattributed && !g.modId))
      .filter((g) => cfDiffGroupVisible(g, q));
    const shown = groups.reduce((s, g) => s + g.findings.length, 0);
    if (!all.length) {
      html = '<p class="note">Replay and the game log agree: no errors on either side.</p>';
    } else if (!groups.length) {
      html = q
        ? '<p class="note">No mod is named exactly that — the mod filter matches whole names only.</p>'
        : '<p class="note">Everything here names no mod — untick “Hide unnamed findings” to see it.</p>';
    } else {
      html = groups.map(cfDiffGroupHtml).join('');
    }
    const bits = [];
    if (q) bits.push(`${n(shown)} of ${n(total)} findings — matching the filter`);
    if (hidden) bits.push(`${n(hidden)} unnamed finding${hidden === 1 ? '' : 's'} hidden`);
    note = bits.join(' · ');
  }
  html += cfCalibrationHtml(d.calibration);
  $('cfReplayDiff').innerHTML = html;
  const noteEl = $('cfDiffNote');
  if (noteEl) noteEl.textContent = note;
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
    gated.push(`<div class="lo-row" title="Its conditions were not met, so the replay skipped it — change the profile and replay to include it."><span class="lo-mod">${renderCivText(g.modName || g.modId)} / ${esc(g.fileLabel)}</span>`
      + `<span class="lo-detail">not run — ${esc(g.reason)}</span></div>`);
  }
  for (const g of d.gatedUnknown) {
    gated.push(`<div class="lo-row" title="The replay ran this file, but its conditions need the running game — check them in-game if it matters."><span class="lo-mod">${renderCivText(g.modName || g.modId)} / ${esc(g.fileLabel)}</span>`
      + `<span class="lo-detail">ran anyway — its conditions cannot be decided here</span></div>`);
  }
  for (const u of d.unreadable) {
    gated.push(`<div class="lo-row" title="The file is missing or outside the mod folder — put it back (or remove the action) and replay."><span class="lo-mod">${renderCivText(u.modName || u.modId)} / ${esc(u.file)}</span>`
      + `<span class="lo-detail">could not be read — ${esc(u.reason)}</span></div>`);
  }
  const aborted = d.perFile.filter((f) => f.status === 'aborted');
  for (const f of aborted) {
    gated.push(`<div class="lo-row" title="Nothing after that statement ran — open the file at that statement and fix it."><span class="lo-mod">${renderCivText(f.modName || f.modId)} / ${esc(f.fileLabel)}</span>`
      + `<span class="lo-detail">stopped at statement ${esc(n(f.failedAt))} — ${esc(f.error)}</span></div>`);
  }
  $('cfReplayGated').innerHTML = gated.length
    ? gated.join('')
    : '<p class="note">Nothing gated out, unreadable, or aborted.</p>';
  cfRenderDiff();
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
  cfState.diffFilter = '';
  cfState.hideUnattributed = false;
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
  const df = $('cfDiffFilter');
  if (df) df.value = '';
  const hu = $('cfHideUnattributed');
  if (hu) hu.checked = false;
  const dn = $('cfDiffNote');
  if (dn) dn.textContent = '';
}

$('cfRunShadow').addEventListener('click', () => { cfRunShadowing().catch((err) => toast(err.message, 'err')); });
$('cfRunReplay').addEventListener('click', () => { cfRunReplay().catch((err) => toast(err.message, 'err')); });
$('cfDiffFilter').addEventListener('input', (e) => { cfState.diffFilter = e.target.value; cfRenderDiff(); });
$('cfHideUnattributed').addEventListener('change', (e) => { cfState.hideUnattributed = !!e.target.checked; cfRenderDiff(); });

pages['conflicts'] = { show: cfShowConflicts };
