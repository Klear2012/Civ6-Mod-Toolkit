'use strict';

// User-defined labels for mods ("favourites", "needs-testing"), in one JSON
// file beside civ6-paths.json. Labels are global, not per profile: the same
// set applies whichever mod group is active.
//
// Keys are modinfo.normId() output - the mod's own GUID from its .modinfo,
// lowercased and unbraced - and NOT ModRowId, which the game renumbers on every
// rescan. Anything keyed by ModRowId loses every label the next time Civ6
// launches.
//
// Reading never throws and never writes. A file we wrote ourselves that we can
// no longer parse must degrade to "no labels with a message", never take the
// mod list down with it.

const fs = require('fs');
const path = require('path');
const { normId } = require('./modinfo');

const VERSION = 1;
// The same cap cleanName() applies to profile names in modsdb.
const MAX_NAME = 100;

// Where the file lives. Overridable, for tests and for a relocated install.
function labelsFile() {
  return process.env.CIV6_LABELS_FILE || path.join(__dirname, '..', 'mod-labels.json');
}

// Trimmed, non-empty, and no longer than MAX_NAME. A label is typed by hand
// into a text field, so it is user input like any other.
function cleanLabel(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw new Error('a label cannot be empty');
  if (n.length > MAX_NAME) throw new Error(`a label cannot be longer than ${MAX_NAME} characters`);
  return n;
}

// The file's own text -> { labels, error }. Two levels of failure, and the
// difference matters: a file that is not the shape we write is unusable as a
// whole, while one bad entry among good ones costs only that entry. Neither is
// allowed to take the rest of the file down.
function parse(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { labels: {}, error: `mod-labels.json is not valid JSON (${e.message})` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { labels: {}, error: 'mod-labels.json does not contain an object' };
  }
  // A missing version is treated as the current one, so a file written before
  // the field existed still loads. A different one we did not write, and whose
  // shape we cannot vouch for, is refused rather than half-understood.
  if (raw.version !== undefined && raw.version !== VERSION) {
    return { labels: {}, error: `mod-labels.json is version ${JSON.stringify(raw.version)}; this toolkit reads version ${VERSION}` };
  }
  if (raw.labels === undefined || raw.labels === null) return { labels: {}, error: null };
  if (typeof raw.labels !== 'object' || Array.isArray(raw.labels)) {
    return { labels: {}, error: 'mod-labels.json has no "labels" object' };
  }

  const labels = {};
  let dropped = 0;
  for (const [id, value] of Object.entries(raw.labels)) {
    const key = normId(id);
    if (!key || !Array.isArray(value)) { dropped++; continue; }
    const names = value.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim());
    if (names.length) labels[key] = names;
  }
  return {
    labels,
    error: dropped ? `${dropped} entr${dropped === 1 ? 'y' : 'ies'} in mod-labels.json could not be read and ${dropped === 1 ? 'was' : 'were'} ignored` : null,
  };
}

// Everything the mod manager needs, derived from the map: the per-mod map, the
// counts the filter chips show, and the alphabetical list the editor offers.
function view(labels, error, pruned) {
  const counts = new Map();
  for (const names of Object.values(labels)) {
    // A mod that somehow lists the same name twice counts once, or the chip
    // would promise more mods than carry it.
    for (const name of new Set(names)) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return {
    labels,
    counts: [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name)),
    names: [...counts.keys()].sort((a, b) => a.localeCompare(b)),
    error: error || null,
    pruned,
  };
}

// Read the file, pruning ids that `known` does not contain.
//
// `known` is the set of mod ids the caller can actually see, or null when it
// cannot vouch for the set - the mod database would not read, or the game is
// part-way through a rescan. Pruning against an incomplete set would delete
// real labels, so those reads prune nothing. Pruned entries are dropped in
// memory and counted in `pruned`; the next write persists the pruned form.
// Nothing is written here, ever.
function readLabels(file = labelsFile(), known = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // No file is the normal state. Having no labels is not a failure.
    if (e.code === 'ENOENT') return view({}, null, 0);
    return view({}, `mod-labels.json could not be read (${e.message})`, 0);
  }
  if (!text.trim()) return view({}, null, 0); // an empty file is no labels

  const { labels, error } = parse(text);
  let pruned = 0;
  if (known) {
    for (const key of Object.keys(labels)) {
      if (!known.has(key)) { delete labels[key]; pruned++; }
    }
  }
  return view(labels, error, pruned);
}

module.exports = { VERSION, MAX_NAME, labelsFile, cleanLabel, readLabels };
