# Decision: retire OpenSpec spec contracts from git tracking

## Summary

**Status:** Accepted
**Date:** 2026-10-07
**Scope:** git-tracking status of `openspec/specs/**` and `openspec/config.yaml`
**Applies to:** `proposal grounding`, `fresh-clone setup`, `sync/archive bookkeeping`
**Change:** Tier 1 direct execution at owner direction; no OpenSpec change involved

**Decision:** Spec contracts leave git tracking. They stay on disk for local OpenSpec use but are ignored by git; standing knowledge is the code plus `tests/*.test.js` mirrors plus `adr/` plus `docs/dev/`.

**Trade-offs:**

- Accepted: proposals ground on ADRs + test mirrors + history instead of standing specs, so there is one contract source instead of two.
- Accepted: fresh clones lose `openspec list --specs` inventory until the files are restored from git history.
- Cost: spec text remains only in git history and local working trees; anyone who wants it back must restore it explicitly.

## Context

The toolkit's behavior contract is already carried by runnable artifacts: product code under `src/` with stdlib `node:test` mirrors under `tests/`, durable decisions in `adr/`, and usage pages in `docs/dev/`. The standing specs duplicated what the mirrors assert, and every behavior change had to be synced in two places or the spec rotted. Owner decision: devs rely on code + tests + docs, so the duplicated layer leaves tracking rather than risking rot.

## Options Considered

### Keep specs tracked and sync on every behavior change

- Pros: standing `openspec list --specs` inventory on fresh clones; proposals keep citing specs.
- Cons: every behavior edit pays a second sync edit, and a missed sync silently rots the contract the next reader trusts.
- Rejected because: the mirrors already assert the behavior and run green; the duplicate adds cost with no independent signal.

### Untrack specs but keep them on disk (chosen)

- Pros: local OpenSpec workflow keeps working unchanged; no product, test, or behavior change; history retains full restore.
- Cons: fresh clones lose spec inventory and local-only project context until restored.
- Rejected because: n/a — chosen. The loss is bounded (restore from history) and the workflow impact is nil.

### Delete specs from disk as well as tracking

- Pros: no stale text anywhere to mislead.
- Cons: destroys the local workflow's reference material and the cheapest restore path for no tracking benefit — git already forgets untracked files.
- Rejected because: keeping them on disk costs nothing and preserves local use plus restore.

## Consequences

Proposals ground on ADRs + test mirrors + history instead of standing specs. Fresh clones lose `openspec list --specs` output (empty inventory, not an error) and the local-only project context until restored from git history, where every spec remains recoverable. The changes workflow itself is unaffected locally: draft, implement, and archive proceed as before, with delta content staying local-only. If the team ever wants tracked contracts back, restore the files from history and revert the ignore rules — one decision, no migration.

## Change

Executed directly as Tier 1 owner-directed work: untracked `openspec/specs/` and `openspec/config.yaml` (kept on disk), ignored them in `.gitignore`, recorded this decision.
