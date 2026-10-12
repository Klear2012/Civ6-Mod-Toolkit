'use strict';

// Dashboard: mod / config counts and the folder setup.

const dash = { data: null };

function groupLabel(g) {
  if (!g) return '';
  return g.name === 'LOC_MODS_GROUP_DEFAULT_NAME' ? 'Default' : g.name;
}

function ratio(c, dbOk) {
  return dbOk ? `${c.enabled} / ${c.total}` : `? / ${c.total}`;
}

function folderRow(label, value, ok, note) {
  return `<div class="folder">
    <span class="folder-label">${esc(label)}</span>
    <code class="folder-path">${esc(value || '(not set)')}</code>
    <span class="chip ${ok ? 'good' : 'bad'}">${ok ? 'found' : 'not found'}</span>
    ${note ? `<span class="folder-note">${note}</span>` : ''}
  </div>`;
}

function renderDashboard() {
  const d = dash.data;
  const dbOk = d.modsDb.ok;
  $('appVersion').textContent = d.version ? ` v${d.version}` : '';
  $('cWorkshop').textContent = ratio(d.counts.workshop, dbOk);
  $('cLocal').textContent = ratio(d.counts.local, dbOk);
  $('cConfigs').textContent = d.counts.configs;
  $('cDlc').textContent = dbOk ? `${d.counts.dlc.enabled} / ${d.counts.dlc.total}` : '?';

  const alerts = [];
  // The counts below come from the folders we are actually reading, so if the
  // overrides file did not load these totals are of the wrong library entirely.
  // That is worth saying before the numbers, not after.
  if (d.pathsError) {
    alerts.push(`<div class="alert warn"><b>Mod locations are not being read.</b> ${esc(d.pathsError)} These counts are of the usual folders, not the ones you set.</div>`);
  }
  if (!dbOk) {
    alerts.push(`<div class="alert warn"><b>Can't read which mods are enabled.</b> ${esc(d.modsDb.error || '')}</div>`);
  }
  // Say what the last sync did, or what is still waiting. A sync never switches
  // anything on, so the wording never implies a mod is now active.
  const s = d.sync;
  if (s && s.error) {
    alerts.push(`<div class="alert warn"><b>Couldn't add new mods.</b> ${esc(s.error)}</div>`);
  } else if (s && s.skipped === 'civ6-running') {
    alerts.push(`<div class="alert warn"><b>Civ6 is running.</b> Close it, then rescan to add any new mods.</div>`);
  } else if (s && s.added.length) {
    const n = s.added.length;
    // renderCivText already returns HTML, so escaping it again is what turned a
    // mod's colour tags into visible "<span>" text.
    const names = s.added.slice(0, 4).map((m) => renderCivText(m.name)).join(', ')
      + (n > 4 ? ` and ${n - 4} more` : '');
    alerts.push(`<div class="alert info"><b>Added ${n} new mod${n > 1 ? 's' : ''}:</b> ${names}.
      They're switched off — tick ${n > 1 ? 'them' : 'it'} in the mod manager when you want ${n > 1 ? 'them' : 'it'}.</div>`);
  }
  if (s && s.failed && s.failed.length) {
    alerts.push(`<div class="alert warn"><b>${s.failed.length} mod${s.failed.length > 1 ? 's' : ''} couldn't be read:</b> ${
      s.failed.map((f) => `${esc(f.file)} (${esc(f.error)})`).join(', ')}</div>`);
  }
  if (d.gone && d.gone.removable) {
    const gone = d.gone.removed.filter((r) => r.removable);
    const names = gone.slice(0, 4).map((m) => renderCivText(m.name)).join(', ')
      + (gone.length > 4 ? ` and ${gone.length - 4} more` : '');
    alerts.push(`<div class="alert info"><b>${gone.length} mod${gone.length > 1 ? 's' : ''} no longer installed:</b> ${names}.
      The game still lists ${gone.length > 1 ? 'them' : 'it'}. Use <b>Remove mod</b> in the mod manager to clear
      ${gone.length > 1 ? 'them' : 'it'} out.</div>`);
  }
  if (d.needsSync.length) {
    const n = d.needsSync.length;
    const names = d.needsSync.slice(0, 4).map((m) => renderCivText(m.name)).join(', ')
      + (n > 4 ? ` and ${n - 4} more` : '');
    alerts.push(`<div class="alert info"><b>${n} mod${n > 1 ? 's' : ''} not added yet:</b> ${names}.
      Rescan to add ${n > 1 ? 'them' : 'it'} — they stay switched off until you tick ${n > 1 ? 'them' : 'it'}.</div>`);
  }
  $('dashAlerts').innerHTML = alerts.join('');

  const local = d.sources.filter((s) => s.type === 'local');
  const ws = d.sources.filter((s) => s.type === 'workshop');
  $('folderList').innerHTML = [
    ...local.map((s) => folderRow('Local mods', s.root, s.exists)),
    ...ws.map((s) => folderRow('Steam Workshop', s.root, s.exists)),
    folderRow('Configurations', d.saves.root, d.saves.exists),
    folderRow('Game logs', d.logs.root, d.logs.exists),
    folderRow('Game cache', d.cache.root, d.cache.exists),
    folderRow('Mod database', d.modsDb.path, d.modsDb.exists,
      d.modsDb.activeGroup ? `active mod group: ${esc(groupLabel(d.modsDb.activeGroup))}` : ''),
  ].join('');

  $('pathLocal').value = (local[0] || {}).root || '';
  $('pathWorkshop').value = ws.map((s) => s.root).filter(Boolean).join(';');
  $('pathSaves').value = d.saves.root || '';
  $('pathLogs').value = d.logs.root || '';
  $('pathCache').value = d.cache.root || '';
  $('pathModsDb').value = d.modsDb.path || '';
}

async function loadDashboard() {
  dash.data = await api('/api/dashboard');
  setGameStatus(dash.data.game);
  renderDashboard();
}

pages.dashboard = { show: loadDashboard };

$('editPaths').addEventListener('click', () => { $('pathsForm').hidden = !$('pathsForm').hidden; });
$('cancelPaths').addEventListener('click', () => { $('pathsForm').hidden = true; if (dash.data) renderDashboard(); });

$('pathsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const workshop = $('pathWorkshop').value.split(';').map((s) => s.trim()).filter(Boolean);
    await postJson('/api/paths', {
      localMods: $('pathLocal').value.trim() || undefined,
      workshop: workshop.length ? workshop : undefined,
      saves: $('pathSaves').value.trim() || undefined,
      logsDir: $('pathLogs').value.trim() || undefined,
      cacheDir: $('pathCache').value.trim() || undefined,
      modsDb: $('pathModsDb').value.trim() || undefined,
    });
    $('pathsMsg').textContent = 'Saved.';
    $('pathsForm').hidden = true;
    configPage.stale = true;
    await loadDashboard();
  } catch (err) { toast(err.message, 'err'); }
});

// Rescan is a write, not just a re-read: it adds any mod on disk that the game
// has not got yet. The button says so, and this says what happened.
$('rescan').addEventListener('click', async () => {
  const btn = $('rescan');
  btn.disabled = true;
  try {
    const r = await postJson('/api/sync', {});
    configPage.stale = true;
    await loadDashboard();
    if (r.error) toast(esc(r.error), 'err');
    else if (r.skipped === 'civ6-running') toast('Civ6 is running — close it and rescan to add new mods.', 'err');
    else if (r.added.length) {
      const n = r.added.length;
      toast(`Added ${n} new mod${n > 1 ? 's' : ''}, switched off.`, 'ok',
        r.backupPath ? `backup: ${esc(r.backupPath)}` : '');
    } else toast('Rescanned — nothing new to add.', 'ok');
  } catch (err) {
    toast(esc(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
});

// ---- Play from save ------------------------------------------------------
// Continue boots the latest autosave with no picker; Load from save offers
// names with turns and times. Both switch the enabled mods to the save's
// set first (put back afterwards via the banner), and both refuse while
// the game runs. Boot answers carry warnings, not throws, so these calls
// read the body instead of using api().

const playUi = {
  savesMode: 'single',
  rows: [],
  latest: null,
  skipAvailable: false,
  loaded: false,
  savesError: null,
  busy: false,
  dx: 'dx12',
  timers: [],
};
try { if (localStorage.getItem('playDx') === 'dx11') playUi.dx = 'dx11'; } catch (_) { /* storage blocked */ }

async function playCall(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

function playVariant() {
  return playUi.dx === 'dx11' ? 'dx11' : 'dx12';
}

function playTime(mtimeMs) {
  if (mtimeMs == null) return 'time unknown';
  try {
    return new Date(mtimeMs).toLocaleString();
  } catch (_) {
    return 'time unknown';
  }
}

function playPreviewText() {
  if (playUi.savesError) return `Could not look at the saves: ${playUi.savesError}`;
  const l = playUi.latest;
  if (!l) return 'No autosaves found — play a few turns first, then Continue will offer the latest one.';
  const turn = l.turn == null ? 'turn unknown' : `turn ${n(l.turn)}`;
  return `Will boot: ${l.name} · ${turn} · ${playTime(l.mtimeMs)}`;
}

function setPlayProgress(text) {
  $('playProgress').textContent = text || '';
}

function clearPlayTimers() {
  for (const t of playUi.timers) clearTimeout(t);
  playUi.timers = [];
}

function renderPlayDx() {
  for (const b of document.querySelectorAll('#playDxSeg button')) {
    b.classList.toggle('active', b.dataset.dx === playUi.dx);
  }
}

function renderPlay() {
  if (!playUi.loaded) return;
  renderPlayDx();
  $('playPreview').textContent = playPreviewText();
  // The intro tick only exists where the install has the key; elsewhere it
  // hides with its reason instead of writing a dead setting.
  $('playSkipWrap').hidden = !playUi.skipAvailable;
  $('playSkipNote').textContent = playUi.skipAvailable ? '' : 'Intro skip is not available — this install has no intro setting.';
  const running = game.running;
  const busy = playUi.busy;
  $('playContinue').disabled = busy || running || !playUi.latest;
  $('playPickerBtn').disabled = busy || running;
  if (running) setPlayProgress('The game is running — quit it first, then play from a save.');
  else if (!busy) setPlayProgress('');
  // A previous mod set waits to be put back: explicit click restores it.
  const banner = $('playRestoreBanner');
  const pending = dash.data && dash.data.modsSnapshotPending;
  if (pending && !running) {
    banner.hidden = false;
    banner.innerHTML = '<b>Your earlier mods are ready to put back.</b> '
      + '<button type="button" class="secondary small" id="playRestore" '
      + 'title="Switch your mods back to how they were before you played from the save">Put my earlier mods back</button>';
    $('playRestore').addEventListener('click', restorePlayMods);
  } else if (pending && running) {
    banner.hidden = false;
    banner.innerHTML = '';
    banner.textContent = 'Your earlier mods will be ready to put back once you quit the game.';
  } else {
    banner.hidden = true;
    banner.innerHTML = '';
  }
}

function playArmed() {
  return { variant: playVariant(), skipIntro: $('playSkipIntro').checked && playUi.skipAvailable, syncMods: true };
}

async function bootLatest() {
  if (playUi.busy || game.running || !playUi.latest) return;
  playUi.busy = true;
  $('playMissing').innerHTML = '';
  renderPlay();
  setPlayProgress('Preparing your save…');
  playUi.timers.push(setTimeout(() => setPlayProgress('Starting the game…'), 4000));
  playUi.timers.push(setTimeout(() => setPlayProgress('Waiting for the save to load — this takes a few minutes…'), 20000));
  try {
    const { body } = await playCall('/api/play-save/latest', playArmed());
    clearPlayTimers();
    settlePlayBoot(body);
  } catch (err) {
    clearPlayTimers();
    setPlayProgress(`Could not start the game: ${err.message}`);
  } finally {
    playUi.busy = false;
    renderPlay();
  }
}

function settlePlayBoot(body) {
  if (body && body.ok) {
    const name = String(body.save || '').split(/[\\/]/).pop() || 'save';
    let detail = `Loaded ${name}.`;
    if (body.modsSwitched) detail += ' Your mods were switched to the save\u2019s set — put them back from the Dashboard after you quit.';
    if (body.leaderEscape === 'unconfirmed') detail += ' An Escape key was sent, but the map is not confirmed yet — check the game window.';
    setPlayProgress(detail);
    toast(esc(detail), 'ok');
    if (body.needsManualClick) $('playMissing').innerHTML = `<div class="alert warn">${esc(body.needsManualClick)}</div>`;
    if (dash.data) dash.data.modsSnapshotPending = !!body.modsSwitched;
    renderPlay();
    return;
  }
  if (body && body.code === 'missing-mods') {
    const missing = body.missing || [];
    const names = missing.map((m) => renderCivText(m.title || m.id)).join(', ');
    const howMany = missing.length === 1 ? 'a mod you don\u2019t have' : `${missing.length} mods you don\u2019t have`;
    $('playMissing').innerHTML = `<div class="alert warn"><b>This save needs ${esc(howMany)}:</b> ${names}. `
      + 'Install them first, then try again. Nothing was changed.</div>';
    setPlayProgress('');
    return;
  }
  setPlayProgress(body && (body.error || body.warning)
    ? `Could not start the game: ${body.error || body.warning}`
    : 'Could not start the game — try again.');
}

async function loadPlayPicker() {
  const sel = $('playSaveSelect');
  try {
    const s = await api('/api/play-save/saves?saves=' + playUi.savesMode);
    playUi.rows = s.saves || [];
    if (!playUi.rows.length) {
      sel.innerHTML = '<option value="">No saves in this folder yet</option>';
      $('playPickedMeta').textContent = '';
      $('playBoot').disabled = true;
      return;
    }
    sel.innerHTML = playUi.rows.map((r) => {
      const turn = r.turn == null ? 'turn unknown' : `turn ${n(r.turn)}`;
      return `<option value="${esc(r.path)}">${esc(r.name)} — ${esc(turn)} — ${esc(playTime(r.mtimeMs))}</option>`;
    }).join('');
    $('playBoot').disabled = game.running;
    renderPlayPicked();
  } catch (err) {
    sel.innerHTML = '<option value="">Could not list saves</option>';
    $('playPickedMeta').textContent = err.message;
    $('playBoot').disabled = true;
  }
}

function renderPlayPicked() {
  const sel = $('playSaveSelect');
  const row = playUi.rows.find((r) => r.path === sel.value);
  if (!row) {
    $('playPickedMeta').textContent = '';
    return;
  }
  const mods = (row.mods || []).map((m) => renderCivText(m.title || m.id)).join(', ');
  $('playPickedMeta').innerHTML = mods
    ? `Needs: ${mods} — switched on before boot, put back after you quit.`
    : 'No mods needed — boots as-is.';
}

async function bootPicked() {
  const sel = $('playSaveSelect');
  if (playUi.busy || game.running || !sel.value) return;
  playUi.busy = true;
  $('playDialog').close();
  $('playMissing').innerHTML = '';
  renderPlay();
  setPlayProgress('Preparing your save…');
  playUi.timers.push(setTimeout(() => setPlayProgress('Waiting for the save to load — this takes a few minutes…'), 20000));
  try {
    const { body } = await playCall('/api/play-save/boot', { ...playArmed(), path: sel.value });
    clearPlayTimers();
    settlePlayBoot(body);
  } catch (err) {
    clearPlayTimers();
    setPlayProgress(`Could not start the game: ${err.message}`);
  } finally {
    playUi.busy = false;
    renderPlay();
  }
}

async function restorePlayMods() {
  try {
    const { body } = await playCall('/api/play-save/restore-mods', {});
    if (body && body.ok) {
      const skipped = body.skipped && body.skipped.length ? ` (${body.skipped.length} no longer there — left alone)` : '';
      toast(`Put ${body.restored} mod${body.restored === 1 ? '' : 's'} back${skipped}.`, 'ok');
      if (dash.data) dash.data.modsSnapshotPending = false;
    } else {
      toast(esc((body && body.error) || 'Could not put the mods back.'), 'err');
    }
  } catch (err) {
    toast(esc(err.message), 'err');
  }
  renderPlay();
}

async function loadPlay() {
  try {
    const s = await api('/api/play-save/saves?saves=single');
    playUi.latest = s.latest || null;
    playUi.skipAvailable = !!s.skipIntroAvailable;
    playUi.loaded = true;
  } catch (err) {
    playUi.loaded = true;
    playUi.latest = null;
    playUi.skipAvailable = false;
    playUi.savesError = err.message;
    renderPlay();
    return;
  }
  renderPlay();
}

$('playContinue').addEventListener('click', () => bootLatest().catch((err) => toast(err.message, 'err')));
$('playPickerBtn').addEventListener('click', () => {
  if (game.running) {
    toast('The game is running — quit it first, then play from a save.', 'err');
    return;
  }
  $('playDialog').showModal();
  loadPlayPicker().catch((err) => toast(err.message, 'err'));
});
$('playDialogClose').addEventListener('click', () => $('playDialog').close());
$('playSaveSelect').addEventListener('change', renderPlayPicked);
$('playBoot').addEventListener('click', () => bootPicked().catch((err) => toast(err.message, 'err')));
for (const id of ['playSavesSingle', 'playSavesMulti']) {
  $(id).addEventListener('change', (e) => {
    if (!e.target.checked) return;
    playUi.savesMode = e.target.value;
    loadPlayPicker().catch((err) => toast(err.message, 'err'));
  });
}
for (const b of document.querySelectorAll('#playDxSeg button')) {
  b.addEventListener('click', () => {
    playUi.dx = b.dataset.dx;
    try { localStorage.setItem('playDx', playUi.dx); } catch (_) { /* storage blocked */ }
    renderPlayDx();
  });
}
document.addEventListener('gamestatus', () => { if (dash.data && playUi.loaded) renderPlay(); });

const loadDashboardWithPlay = loadDashboard;
pages.dashboard.show = async function loadDashboardPlay() {
  await loadDashboardWithPlay();
  await loadPlay();
};
