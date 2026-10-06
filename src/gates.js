'use strict';

// Criteria gating behind the load order view: which actions will run in a
// profile, and how sure the toolkit is. Pure functions - no database, no
// store, no writes. Split out of src/loadorder.js (facade re-export there);
// this module owns DECIDABLE and MISSPELLINGS, everyone else requires them.

const { splitCommaList, leaderTail, isAsserted } = require('./gamesetup');
const { normId } = require('./modinfo');

// The two real misspellings in the wild, read but never written. A mod that
// ships `LaodOrder` has told us its position, and refusing to look at it would
// leave reset with nothing to go back to and the view unable to say what the
// author declared. Reading it is not the same as touching it: writeValue only
// ever writes the correctly spelled row.
const MISSPELLINGS = ['LaodOrder', 'LoadingOrder'];

// The six criterion types in a real library, measured:
//
//   ModInUse                   604   a mod with this GUID is switched on in the
//                                        ACTIVE profile. 225 of them are inverted.
//   RuleSetInUse               318   a game ruleset
//   ConfigurationValueMatches  215   a config value
//   LeaderPlayable             150   which leaders are playable
//   GameCoreInUse               68   which game core
//   ModIsEnabled                 1   a mod is switched on in the profile
//
// ModInUse was measured in game rather than inferred, and the answer settled
// more than the question asked. A probe action gated on ModInUse of a mod that
// was installed, switched OFF in the active profile and switched ON in eleven
// others did NOT run. So it is not "subscribed and present" - the eleven
// profiles rule that out - and it is not "on in any profile" either, because
// the criterion was still false. It is scoped to the active profile, and it
// behaves the same as ModIsEnabled.
//
// The first plan assumed the opposite and was wrong. It proposed warning that
// switching profile would stop 214 of Harmony in Diversity's 222 actions
// running, on the strength of "ModInUse is the commonest, 604 uses" - true
// across the library and misleading about the one mod it was cited for. HiD's
// dominant gate is RuleSetInUse, at 213 rows against 97, and a game ruleset
// does not change when you switch profile.
const DECIDABLE = new Set(['ModInUse', 'ModIsEnabled']);

// The author's position: the correctly spelled row, else a misspelling, else
// nothing. Mirrors currentValue, so the view and the write path cannot disagree
// about what the mod asked for.
function declaredValueOf(declared, componentRowId) {
  const row = declared.get(componentRowId);
  if (!row) return null;
  if (row.LoadOrder !== undefined) return row.LoadOrder;
  for (const m of MISSPELLINGS) if (row[m] !== undefined) return row[m];
  return null;
}

// Whether this action will run, and how sure we are. true or false only where
// it is provable; null where the toolkit cannot tell.
//
// Sound but incomplete beats complete but unsound. This view exists to stop a
// user concluding "my load order is fine" when it is not, so a row that
// over-reports costs a glance and one that under-reports recreates the exact
// confusion being removed. Every branch below is chosen with that asymmetry in
// mind, and two of them exist because the first version got them wrong.
const MAYBE = null;

// Why this view cannot read a condition, in the words that help someone looking at
// the row. "Depends on something this view cannot see" reads like a fault in the
// row; the specific reason shows it is merely unanswerable here, which is a very
// different thing to someone deciding whether to worry.
//
// These are measurements, not guesses, and one of them corrected me.
//
// I first wrote that nothing on disk holds these values, having searched for
// GAMEMODE_ as a VALUE. That search was wrong: DebugConfiguration.sqlite has a
// `Parameters` table (75 rows) and DebugGameplay.sqlite has `GlobalParameters`
// (476 rows), and neither is keyed by the column I was matching. Checked properly,
// across every ConfigurationId-bearing table:
//
//   Parameters        75 rows  1 of the 41 ids appears: RULESET
//   QueryParameters   23 rows  9 rows, all the same id: RULESET
//   ParameterDependencies, ParameterCriteria, the Domain/Value* columns: 0
//
// So one of the forty-one ids the library names is known to the game at all, and
// that one row has DefaultValue NULL - the game recording that it has no default,
// which is the clearest statement available that the value is chosen at game start.
// The other forty appear in no game database on this machine.
//
// No verdict is available from any of this, and none is claimed. What it buys is a
// reason a user can check, which is the difference between a row that looks broken
// and a row that is merely unanswerable here.
function unreadableWhy(c) {
  const v = c.value;
  switch (c.type) {
    case 'ConfigurationValueMatches':
      return `needs ${(c.props && c.props.ConfigurationId) || 'a game option'} to be ${v}`
        + ' - a game option picked in the main menu, so it is not known until the game starts';
    case 'RuleSetInUse':
      return `needs the ${v} ruleset - the game records RULESET with no default value`
        + ' precisely because you choose it when you start a game';
    case 'GameCoreInUse':
      return `needs the ${v} game core - that is a matter of which DLC is installed`;
    case 'LeaderPlayable':
      return `needs ${v} to be playable - which depends on who is in the game, not on the profile`;
    default:
      return `depends on ${c.type}, which this view cannot see`;
  }
}

// Assumed game setup: which store keys satisfy one undecidable condition.
//
// The store (src/gamesetup.js) holds KIND:BODY keys - RULESET:<id>, CORE:<id>,
// LEADER:<id>, GAMEMODE:<id>, CONFIG:<Group>/<ConfigurationId>=<Value> - and
// asserting one marks matching RuleSetInUse / GameCoreInUse / LeaderPlayable /
// ConfigurationValueMatches conditions satisfied. Nothing else is readable
// here, and ModInUse / ModIsEnabled measurement is untouched by design.
//
// A non-matching assertion proves nothing: one ruleset asserted does not prove
// another ruleset is off for verdict purposes, so only an exact match satisfies
// and everything else stays undecided. The inverted form of a match (NOT X
// where X is asserted) is the one assumed false.
//
// Comma lists read as OR: one condition naming "Expansion1,Expansion2" yields
// one key per single (LeaderPlayable singles reduce to their leader tail, the
// same reduction the catalog mines), and isAssumedMatch below satisfies the
// condition when ANY listed single is asserted.
function setupKeysFor(c) {
  if (!c) return [];
  if (c.type === 'RuleSetInUse' || c.type === 'GameCoreInUse' || c.type === 'LeaderPlayable') {
    if (c.value == null) return [];
    const kind = c.type === 'RuleSetInUse' ? 'RULESET' : c.type === 'GameCoreInUse' ? 'CORE' : 'LEADER';
    const out = [];
    for (const s of splitCommaList(c.value)) {
      const single = c.type === 'LeaderPlayable' ? leaderTail(s) : s;
      if (!single) continue;
      out.push(`${kind}:${single}`);
    }
    return [...new Set(out)];
  }
  if (c.type === 'ConfigurationValueMatches') {
    const p = c.props || {};
    if (p.Group == null || p.ConfigurationId == null || p.Value == null) return [];
    const g = String(p.Group).trim();
    const cid = String(p.ConfigurationId).trim();
    if (!g || !cid) return [];
    const out = [];
    for (const single of splitCommaList(p.Value)) {
      out.push(`CONFIG:${g}/${cid}=${single}`);
      // Game-mode shorthand: the library gates modes as ConfigurationValueMatches
      // with Group Game, ConfigurationId GAMEMODE_*, Value 1. Asserting
      // GAMEMODE:<id> satisfies that enable triple, so a catalog that lists modes
      // by id still matches. A triple asking for another value (e.g. 0) is not
      // satisfied by the mode being on - only the exact triple is.
      if (single === '1' && (g === 'Game' || cid.startsWith('GAMEMODE_'))) {
        out.push(`GAMEMODE:${cid}`);
      }
    }
    return [...new Set(out)];
  }
  return [];
}

// Whether an asserted store holds a key satisfying this condition. The store
// reader never throws (a hand-edit typo answers false), and a Set or array of
// keys is accepted as well as the readSetup view or raw map, so callers and
// tests can pass whichever they hold. Null or empty asserts nothing.
function isAssumedMatch(c, asserted) {
  if (!asserted) return false;
  const keys = setupKeysFor(c);
  if (!keys.length) return false;
  for (const k of keys) {
    try {
      if (isAsserted(asserted, k)) return true;
    } catch (_) { /* isAsserted never throws; a typo answers false */ }
    if (asserted instanceof Set && asserted.has(k)) return true;
    if (Array.isArray(asserted) && asserted.includes(k)) return true;
  }
  return false;
}

// One condition, three ways: satisfied, not satisfied, or not something this
// view can read. Never a guess, and an inverted condition is inverted here
// rather than skipped - skipping it made "NOT ModInUse(X)" read as satisfied
// whenever X was on, which is the one case where the old code reported an
// action as running that provably does not.
function evalCondition(c, ctx) {
  if (!DECIDABLE.has(c.type)) {
    // `needs`, not `why`: verdictOf reads one key off every branch, and a branch
    // that spells it differently yields a reason of undefined - which is a row
    // saying "cannot tell" with nothing after it.
    //
    // Assumed setup, read-only: a matching assertion satisfies the condition,
    // flagged assumed so the verdict can label it. Anything else stays
    // undecided with byte-identical wording, so measured verdicts never move
    // when nothing is asserted.
    if (ctx && ctx.asserted && isAssumedMatch(c, ctx.asserted)) {
      if (c.inverse) return { sat: false, needs: unreadableWhy(c), assumed: true };
      return { sat: true, needs: null, assumed: true };
    }
    return { sat: MAYBE, needs: unreadableWhy(c), assumed: false };
  }
  const target = ctx.installed.get(normId(c.value));
  if (!target) {
    // Nothing installed, so nothing switched on, whichever way the type is
    // meant - the case that was decidable before the probe too. Inverted, the
    // absence is exactly what is being asked for.
    return c.inverse
      ? { sat: true, needs: null, assumed: false }
      : { sat: false, needs: `needs ${c.value}, which is not installed`, assumed: false };
  }
  // ModInUse and ModIsEnabled come to the same test, which is what the probe
  // measured rather than assumed. They stay separate names so the code says
  // what the database says.
  const on = ctx.on.has(target.modId);
  return {
    sat: c.inverse ? !on : on,
    needs: c.inverse
      ? `needs ${target.name} to be off in this profile`
      : `needs ${target.name} to be on in this profile`,
    assumed: false,
  };
}

function verdictOf(entry, ctx) {
  if (!entry || entry.items.length === 0) return { willRun: true, reason: null, unknown: [], assumed: false };

  const unknown = [];
  const unmet = [];
  let read = 0;
  let met = 0;
  let metAssumed = 0;
  let metMeasured = 0;
  let unmetAssumed = 0;
  let unmetMeasured = 0;
  for (const c of entry.items) {
    const r = evalCondition(c, ctx);
    if (r.sat === MAYBE) { unknown.push({ type: c.type, why: r.needs }); continue; }
    read++;
    if (r.sat) {
      met++;
      if (r.assumed) metAssumed++;
      else metMeasured++;
    } else {
      unmet.push(r.needs);
      if (r.assumed) unmetAssumed++;
      else unmetMeasured++;
    }
  }

  // Criteria.Any is the author's own declaration and means what it says. Measured
  // over every multi-condition set whose .modinfo is on disk: stored Any=1 exactly
  // when the modinfo declares any= - 2 sets with a declaration, 278 without one, no
  // exceptions. (104 further sets belong to base-game and DLC mods with no
  // .modinfo on disk, and the column holds the value the game recorded either way.)
  //
  // An earlier note here called the flag unreadable, on the strength of "5 mods
  // declare any=1 but 82 sets have it". That count was of declaration sites rather
  // than sets and had ignored the 104, so the flag was never the mystery it looked
  // like - the measurement was.
  //
  // Three-valued, because a condition this view cannot read is not false: an OR
  // needs one met condition however the rest read, and an AND is defeated by one
  // unmet condition however the rest read. Every path that leaves willRun undecided
  // has at least one entry in `unknown`, so a row never says "cannot tell" without
  // saying what it could not tell.
  let willRun = MAYBE;
  if (entry.any) {
    if (met > 0) willRun = true;
    else if (read > 0 && unknown.length === 0) willRun = false;
  } else {
    if (unmet.length > 0) willRun = false;
    else if (read > 0 && unknown.length === 0) willRun = true;
  }

  // Assumed verdicts: true only where the outcome relies on an assertion -
  // removing the asserted values would leave a different willRun. An OR runs
  // when one met condition carries it, so it depends on assumed only when no
  // measured condition is met; an AND runs only when every decided condition
  // is met with nothing unread, so any assumed met means without it the row
  // would be undecided. The false cases mirror: an OR is false only when every
  // decided condition is unmet with nothing unread, so any assumed unmet makes
  // it dependent, while an AND is defeated by one unmet, so it depends on
  // assumed only when no measured unmet defeats it alone. Undecided rows are
  // never flagged: fewer unknowns is not running.
  let assumed = false;
  if (willRun === true) {
    assumed = entry.any ? (metAssumed > 0 && metMeasured === 0) : metAssumed > 0;
  } else if (willRun === false) {
    assumed = entry.any ? unmetAssumed > 0 : (unmetAssumed > 0 && unmetMeasured === 0);
  }

  if (willRun === true) return { willRun: true, reason: null, unknown, assumed };
  if (willRun === false) return { willRun: false, reason: unmet.join('; ') || 'a condition is not met', unknown, assumed };
  return { willRun: null, reason: null, unknown, assumed: false };
}

module.exports = {
  DECIDABLE, MISSPELLINGS, MAYBE,
  declaredValueOf, unreadableWhy, setupKeysFor, isAssumedMatch, evalCondition, verdictOf,
};
