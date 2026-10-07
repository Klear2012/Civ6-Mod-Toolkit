# Decision: .Civ6Cfg edits are pure buffer splices inside mod blocks

## Summary

**Status:** Accepted
**Date:** 2026-09-30
**Scope:** all capabilities that add, remove, or reorder mods in game configuration files
**Applies to:** `config-edit`

**Decision:** We will edit `.Civ6Cfg` files by splicing bytes inside the mod-block regions only (clone/swap/append elements, bump counts). Every byte outside the edited blocks is preserved verbatim.

**Trade-offs:**

- Accepted: round-trip safety by construction — customized settings survive mod edits
- Accepted: no format re-serialization risk
- Cost: editing logic is byte-level and tied to marker constants

## Context

`.Civ6Cfg` uses the typed-marker binary format of a `.Civ6Save` header
(magic `CIV6`) with no trailing compressed blob. Mods live in two parallel
`0x0B` arrays (`MOD_BLOCK_4`, `MOD_BLOCK_2`) holding `MOD_ID` + `MOD_TITLE`
elements. The project's purpose is adding/removing mods without recreating
hand-customized settings. Reused byte readers from pydt/civ6-save-parser
(MIT) could not be reused at top level: they anchor on a `GAME_SPEED` marker
absent in configs and break on `END_UNCOMPRESSED` byte patterns occurring
~52 times per config — so navigation is config-aware in `src/civ6cfg.js`.

## Options Considered

### Full parse-and-rewrite of the config file

- Pros: simpler editing code at the field level
- Cons: any serializer detail (padding, order, encoding) risks silent data loss across thousands of hand-tuned settings
- Rejected because: byte-identical round-trip (`addMod` then `removeMod`) is the core guarantee and rewriting cannot prove it

### Pure buffer splices limited to mod blocks

- Pros: preservation is structural, verified by byte-identical round-trip tests (count matches element count, 45–46 mods extracted, add-then-remove byte-identical on fixtures)
- Cons: byte-level code tied to marker constants
- Rejected because: n/a — chosen

## Consequences

`phase0-roundtrip.js` proves the guarantee on fixtures. All later editing
work builds on `src/civ6cfg.js` navigation rather than re-parsing.

## Change

Established pre-OpenSpec (FINDINGS.md Phase 0, repo root); relied upon by
openspec changes `game-setup` and `load-order-edit`, archived 2026-10-02
and 2026-09-30.
