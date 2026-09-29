'use strict';

// The load order overrides screen: problem 2.
//
// A separate page from the load order view, on purpose. The view answers "where
// is there room" and must stay read-only; this answers "move this one" and is
// where a value is allowed to change. The handoff for this feature was explicit
// that the two had been conflated before and must not be again.
//
// It is a page rather than a dialog because the person who has twenty overrides
// is the person writing a sub-mod - which is the same person the view is built
// for - and because an orphaned override has no mod row to live in: the action
// it named is gone.

const lov = { data: null };

const STATE_TEXT = {
  applied: 'in place',
  drifted: 'drifted — the database has a different value',
  orphaned: 'orphaned — nothing in that mod matches this key any more',
  ambiguous: 'ambiguous — more than one action matches this key',
};

function keyLabel(o) {
  // The key is a readable string on purpose. A mod author looking at "why did
  // my override stop matching" should be able to see what it names.
  const parts = String(o.key).split('\n');
  const files = parts.slice(2);
  return `${parts[0]}${parts[1] ? ` · ${parts[1]}` : ''}${files.length ? ` · ${files.length} file${files.length === 1 ? '' : 's'}` : ''}`;
}

function rowHtml(o) {
  const editable = o.state === 'applied' || o.state === 'drifted';
  const warn = o.state === 'drifted' ? 'lo-drift' : o.state === 'applied' ? 'lo-override' : 'lo-lost';
  return `<div class="lo-row lov-row" data-mod="${esc(o.modId)}" data-key="${esc(o.key)}">
    <span class="lo-mod">${esc(o.modName)}</span>
    <span class="lo-type">${esc(o.type || o.state)}</span>
    <span class="lo-detail">
      <span class="lo-tag ${warn}">${esc(STATE_TEXT[o.state] || o.state)}</span>
      <span class="lo-ov">at ${esc(n(o.value))}${o.declared !== null ? ` · author declares ${esc(n(o.declared))}` : ''}</span>
      <span class="lo-key">${esc(keyLabel(o))}</span>
      ${o.reason ? `<span class="lo-cond">${esc(o.reason)}</span>` : ''}
      ${o.protected ? '' : '<span class="lo-tag lo-unprot">not protected — its .modinfo is not on disk</span>'}
    </span>
    <span class="lov-actions">
      ${editable ? `<button type="button" class="secondary small" data-act="edit">Change…</button>
                    <button type="button" class="secondary small" data-act="reset">Reset</button>` : ''}
      <button type="button" class="secondary small" data-act="discard">Discard</button>
    </span>
  </div>`;
}

function renderOverrides() {
  const d = lov.data;
  const alerts = [];
  if (d && !d.ok) alerts.push(`<div class="alert warn"><b>Can't read your overrides.</b> ${esc(d.error || '')}</div>`);
  if (d && d.unusable) alerts.push(`<div class="alert warn"><b>Your overrides file cannot be read.</b> ${esc(d.error || '')} Nothing will be written until it is fixed or deleted.</div>`);
  if (d && d.stale && d.stale.stale && d.stale.stale.length) {
    alerts.push(`<div class="alert warn"><b>${d.stale.stale.length} mod${d.stale.stale.length === 1 ? '' : 's'} updated since your last sync.</b> Re-apply before playing.</div>`);
  }
  $('lovAlerts').innerHTML = alerts.join('');

  $('lovCount').textContent = d && d.ok ? n(d.count) : '';
  $('lovMeta').textContent = d && d.ok
    ? (d.stale && d.stale.stale && d.stale.stale.length
        ? `${d.stale.stale.length} mod${d.stale.stale.length === 1 ? '' : 's'} waiting to be re-applied`
        : 'Everything is in place')
    : '';
  $('lovList').innerHTML = d && d.ok && d.overrides.length
    ? d.overrides.map(rowHtml).join('')
    : '<p class="note">No overrides. The load order view is read-only on purpose — an override is set from here.</p>';
}

async function load() {
  try {
    lov.data = await api('/api/load-overrides');
  } catch (err) {
    lov.data = { ok: false, error: err.message, overrides: [], count: 0 };
  }
  renderOverrides();
}

async function post(path, body) {
  const d = await postJson(path, body);
  lov.data = d;
  renderOverrides();
  return d;
}

// Change… asks for the value in a dialog rather than a prompt(), so the author
// can see the declared value and the current one while deciding.
function askValue(o) {
  const current = String(o.value);
  const declared = o.declared === null ? '' : String(o.declared);
  const msg = `${o.modName}\n\ncurrently ${o.value}${declared !== '' ? `, author declares ${declared}` : ''}\n\nNew LoadOrder (whole number):`;
  // eslint-disable-next-line no-alert
  const answer = window.prompt(msg, current);
  if (answer === null) return null;
  const trimmed = answer.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    toast('a load order has to be a whole number', 'err');
    return null;
  }
  return Number(trimmed);
}

$('lovList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.lov-row');
  const modId = row.dataset.mod;
  const key = row.dataset.key;
  const entry = (lov.data.overrides || []).find((o) => o.modId === modId && o.key === key);
  if (!entry) return;

  try {
    if (btn.dataset.act === 'edit') {
      const v = askValue(entry);
      if (v === null) return;
      if (v >= 10000000 && !confirm(`Load order ${v} means "load last, override everything" in Civ6. The author may have meant that. Carry on?`)) return;
      const d = await post('/api/load-overrides', { modId, key, value: v });
      if (d.sentinels && d.sentinels.length) toast('applied — and that value means "load last"');
      else toast('applied');
    } else if (btn.dataset.act === 'reset') {
      if (!confirm(`Put this action back to the author's value (${entry.declared})?`)) return;
      await post('/api/load-overrides/reset', { modId, key });
      toast('back to the author\'s value');
    } else if (btn.dataset.act === 'discard') {
      // Discarding forgets the intent but leaves the value where the last apply
      // put it. Saying so is the whole point - it is not a reset.
      if (!confirm('Forget this override?\n\nThe value stays where it was last written. Use Reset if you want the author\'s value back.')) return;
      await post('/api/load-overrides/discard', { modId, key });
      toast('override discarded');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('lovSync').addEventListener('click', async () => {
  try {
    const d = await post('/api/load-overrides/sync', {});
    const s = d.sync || {};
    if (!s.changed) toast('nothing needed re-applying');
    else toast(`re-applied ${s.applied} override${s.applied === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message, 'err');
  }
});

pages['load-overrides'] = { show: load };
