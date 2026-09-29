'use strict';

// The load order view: one profile's load order, as one flat list.
//
// This page READS. There is no control on it that changes a value, and the
// button that says "Manage overrides" navigates to a different screen. That is
// not a style choice - the handoff for this feature was explicit that the two
// problems it covers were conflated for a long time and must not be again:
//
//   problem 1, authoring:  which values are taken, which are free, where does
//                          mine go?                     <- this page
//   problem 2, reordering: this mod is in the wrong band, move it
//                                                          <- load-overrides
//
// The list is the answer rather than a dashboard about it. "Where does mine
// sit" is answered by its neighbours, so the useful thing is the ordered list
// itself, with the gaps in it.

const lo = {
  data: null,
  filter: '',
  compareWith: null,
  marked: null,   // a mod id, when arriving from the mod list
  hideOff: false, // rows that will not run are noise unless asked for
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const n = (v) => (v == null ? '' : Number(v).toLocaleString());

function loMatches(a, q) {
  if (!q) return true;
  return `${a.modName} ${a.type} ${a.id || ''}`.toLowerCase().includes(q);
}

// The note explaining the shape of the list. It is here rather than in a dialog
// because what needs explaining is why there are gaps in the thing you are
// looking at.
function noteHtml(s) {
  return `<p>Load order is declared per <b>action</b>, not per mod. Most actions
    declare nothing, and where two share a value the game picks arbitrarily and
    neither is first. <b>${esc(n(s.modsOn))}</b> mods are on here, carrying
    <b>${esc(n(s.actions))}</b> actions &mdash; <b>${esc(n(s.positioned))}</b>
    of them positioned across <b>${esc(n(s.distinctValues))}</b> values,
    ${esc(n(s.min))} to ${esc(n(s.max))}.</p>`;
}

function stateBadge(a) {
  if (a.state === 'overridden') return '<span class="lo-tag lo-override">overridden</span>';
  if (a.state === 'drifted') return '<span class="lo-tag lo-drift">drifted</span>';
  return '';
}

function conditionLine(a) {
  if (a.willRun === false) return `<span class="lo-cond lo-off">not run &mdash; ${esc(a.reason)}</span>`;
  if (a.willRun === null && a.unknown && a.unknown.length) return `<span class="lo-cond lo-unknown">? ${esc(a.unknown[0].why)}</span>`;
  return '';
}

function actionRow(a) {
  const bits = [];
  if (a.inCompare === false) bits.push('<span class="lo-diff lo-diff-rm">not in the compared profile</span>');
  if (a.inCompare === true) bits.push('<span class="lo-diff lo-diff-same">in both profiles</span>');
  if (a.willRun !== true) bits.push(conditionLine(a));
  if (a.override) {
    bits.push(stateBadge(a));
    if (a.state === 'drifted') {
      // Drifted means the author changed it, or the game re-derived it. Either
      // way the two numbers are worth seeing side by side.
      bits.push(`<span class="lo-ov">author declares ${esc(n(a.declared))}, the database has ${esc(n(a.effective))}</span>`);
    } else {
      bits.push(`<span class="lo-ov">author declares ${esc(n(a.declared))}, yours is ${esc(n(a.override.value))}</span>`);
    }
  }
  if (a.misspelled) bits.push('<span class="lo-tag lo-typo">the mod spells LoadOrder wrong</span>');
  if (!a.protected) bits.push('<span class="lo-tag lo-unprot">not protected</span>');

  return `<div class="lo-row${lo.marked === a.modId ? ' lo-mark' : ''}">
    <span class="lo-mod">${esc(a.modName)}</span>
    <span class="lo-type">${esc(a.type)}</span>
    <span class="lo-detail">${bits.filter(Boolean).join(' ')}</span>
  </div>`;
}

function bandHtml(b) {
  if (b.kind === 'free') {
    return `<div class="lo-band lo-free" data-free="1">
      <span class="lo-value">&mdash;</span>
      <span class="lo-bandnote">${esc(n(b.from))} to ${esc(n(b.to))} &mdash; ${esc(n(b.count))} values nothing claims</span>
    </div>`;
  }
  if (b.kind === 'headroom') {
    return `<div class="lo-band lo-free" data-free="1">
      <span class="lo-value">&mdash;</span>
      <span class="lo-bandnote">everything above ${esc(n(b.from - 1))} is free</span>
    </div>`;
  }
  return `<div class="lo-band${b.tie ? ' lo-tie' : ''}">
    <div class="lo-bandhead">
      <span class="lo-value">${esc(n(b.value))}</span>
      <span class="lo-bandnote">${b.actions.length} action${b.actions.length === 1 ? '' : 's'}${b.tie ? ' &mdash; a tie, the game picks arbitrarily' : ''}</span>
    </div>
    ${b.actions.map(actionRow).join('')}
  </div>`;
}

function renderList() {
  const d = lo.data;
  const list = $('loList');
  if (!d || !d.ok) { list.innerHTML = ''; return; }
  const q = lo.filter.trim().toLowerCase();

  let html = '';
  let shown = 0;
  for (const b of d.bands) {
    if (b.kind === 'free' || b.kind === 'headroom') { html += bandHtml(b); continue; }
    // A filter keeps the band and its value, so the list stays a list of
    // positions rather than collapsing to a list of matching actions.
    const keep = b.actions.filter((a) => loMatches(a, q) && (!lo.hideOff || a.willRun !== false));
    if (q && !keep.length) continue;
    const visible = q ? keep : b.actions;
    shown += visible.length;
    html += bandHtml({ ...b, actions: visible, tie: visible.length > 1 });
  }
  list.innerHTML = html || '<p class="note">Nothing matches that filter.</p>';
  $('loShown').textContent = q ? `${shown} of ${d.summary.actions} actions` : '';
}

function renderUndeclared() {
  const d = lo.data;
  const ok = d && d.ok;
  $('loUndeclaredCount').textContent = ok ? n(d.undeclaredTotal) : '';
  $('loUndeclaredNote').innerHTML = ok
    ? `<p><b>${esc(n(d.undeclaredTotal))}</b> of the <b>${esc(n(d.summary.actions))}</b> actions
       in this profile declare no LoadOrder at all. Their order is whatever the game
       decides &mdash; not yours, and not ours. A mod with a long list here is relying on
       ordering nobody controls.</p>`
    : '';
  $('loUndeclared').innerHTML = ok && d.undeclared.length
    ? d.undeclared.map((m) => `<div class="lo-row"><span class="lo-mod">${esc(m.name)}</span><span class="lo-detail">${esc(n(m.count))} actions</span></div>`).join('')
    : '<p class="note">Every action in this profile declares a position.</p>';
}

function renderUnmatched() {
  const d = lo.data;
  const panel = $('loUnmatchedPanel');
  if (!d || !d.ok || !d.unmatched.length) { panel.hidden = true; return; }
  panel.hidden = false;
  $('loUnmatchedCount').textContent = d.unmatched.length;
  $('loUnmatched').innerHTML = d.unmatched.map((u) => `<div class="lo-row">
      <span class="lo-mod">${esc(u.modId)}</span>
      <span class="lo-type">${esc(u.state)}</span>
      <span class="lo-detail">${u.state === 'ambiguous'
        ? `${u.candidates} actions in that mod match this key, so the toolkit will not choose between them`
        : 'no action in that mod matches this key any more'}</span>
    </div>`).join('');
}

function renderAlerts() {
  const d = lo.data;
  const alerts = [];
  if (d && !d.ok) alerts.push(`<div class="alert warn"><b>Can't read the load order.</b> ${esc(d.error || '')}</div>`);
  if (d && d.stale && d.stale.stale && d.stale.stale.length) {
    alerts.push(`<div class="alert warn"><b>${d.stale.stale.length} mod${d.stale.stale.length === 1 ? '' : 's'} updated since your last sync.</b>
      Open the toolkit before playing, so your overrides are re-applied first.</div>`);
  }
  if (d && d.labelsError) {
    alerts.push(`<div class="alert warn"><b>Problem with your load order overrides.</b> ${esc(d.labelsError)} Showing none until it is fixed.</div>`);
  }
  $('loAlerts').innerHTML = alerts.join('');
}

function renderHeader() {
  const d = lo.data;
  const s = d && d.ok ? d.summary : null;
  $('loSummary').textContent = s
    ? [`${n(s.modsOn)} mods on`, `${n(s.actions)} actions`,
       s.willNotRun ? `${n(s.willNotRun)} will not run` : null,
       s.unknown ? `${n(s.unknown)} cannot be decided` : null,
       s.unmatched ? `${n(s.unmatched)} override${s.unmatched === 1 ? '' : 's'} no longer match` : null]
      .filter(Boolean).join(' · ')
    : '';
  $('loNote').innerHTML = s ? noteHtml(s) : '';

  const sel = $('loProfile');
  if (d) sel.innerHTML = d.groups.map((g) => `<option value="${g.id}"${d.profile && g.id === d.profile.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('');

  const cmp = d && d.compare;
  $('loCompare').hidden = !cmp;
  $('loCompare').textContent = cmp ? `Comparing with "${cmp.name}" — clear` : 'Clear comparison';
}

function render() {
  renderAlerts();
  renderHeader();
  renderList();
  renderUndeclared();
  renderUnmatched();
  markScroll();
}

// Arriving from a mod row marks that mod's rows rather than filtering to them.
// A filtered list would show only that mod, which answers none of the question
// the user clicked it to ask.
function markScroll() {
  if (!lo.marked) return;
  const el = document.querySelector('#loList .lo-mark');
  if (el) el.scrollIntoView({ block: 'center' });
}

async function loadLoOrder() {
  const params = new URLSearchParams();
  if (lo.compareWith != null) params.set('compare', lo.compareWith);
  try {
    lo.data = await api(`/api/load-order${params.toString() ? `?${params}` : ''}`);
  } catch (err) {
    lo.data = { ok: false, error: err.message, groups: [], bands: [], summary: {}, undeclared: [] };
  }
  render();
}

$('loFilter').addEventListener('input', (e) => { lo.filter = e.target.value; renderList(); });
$('loProfile').addEventListener('change', (e) => {
  const q = new URLSearchParams({ profile: e.target.value });
  if (lo.compareWith != null) q.set('compare', lo.compareWith);
  if (lo.marked) q.set('mark', lo.marked);
  location.hash = `#/load-order?${q}`;
});
$('loManage').addEventListener('click', () => { location.hash = '#/load-overrides'; });
$('loUnmatchedManage').addEventListener('click', () => { location.hash = '#/load-overrides'; });
$('loCompare').addEventListener('click', () => {
  lo.compareWith = null;
  const q = new URLSearchParams();
  if (lo.data && lo.data.profile) q.set('profile', lo.data.profile.id);
  location.hash = `#/load-order${q.toString() ? `?${q}` : ''}`;
});
$('loJump').addEventListener('click', (e) => {
  const kind = e.target.dataset && e.target.dataset.jump;
  if (!kind) return;
  if (kind === 'nextoff') { lo.hideOff = true; renderList(); return; }
  const free = document.querySelector('#loList .lo-free');
  if (free) free.scrollIntoView({ block: 'center' });
});

pages['load-order'] = {
  show(params) {
    lo.marked = params.get('mark');
    const cmp = params.get('compare');
    lo.compareWith = cmp != null && /^\d+$/.test(cmp) ? Number(cmp) : null;
    lo.filter = '';
    $('loFilter').value = '';
    return loadLoOrder();
  },
};

window.civ6LoadOrder = lo;
