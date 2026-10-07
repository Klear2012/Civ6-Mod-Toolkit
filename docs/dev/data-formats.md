# Data formats — `.Civ6Cfg` binary layout

Promoted from `FINDINGS.md` Phase 0 (the lab notebook stays where it is).
Read this to edit configs; read `FINDINGS.md` to challenge how we learned it.

## Container

`.Civ6Cfg` uses the typed-marker binary format of a `.Civ6Save` **header**
(magic `CIV6`) with **no trailing compressed game-state blob**. Everything is
plain typed records — no zlib/64KB-chunk decompression.

Records are `marker(4) type(4) payload`. Known types: `1` = bool, `2` = int,
`5` = ascii-string, `6` = utf16-string, `0x0A`/`0x0B` = arrays.

## Where the mod list lives

Mods are stored in **two parallel `0x0B` arrays**, marked `MOD_BLOCK_4`
(`bb 5e 30 88`) and `MOD_BLOCK_2` (`c8 d1 8c 1b`). Both hold the same mod list.

Each block: `marker(4) 0B(4) + 8 filler + count(uint32 LE) + N elements`.
Each element starts with `0x0A`, then holds a `MOD_ID` (`54 5f c4 04`, the
GUID string) and a `MOD_TITLE` (`72 e1 34 30`, localized-name JSON), ending in
a terminator entry whose value is the string `"1"`.

GUIDs appear uppercase (official DLC), lowercase (workshop/local mods) and
brace-wrapped `{...}`. Matching is case-insensitive.

## Editing model (safe by construction)

Edits are **pure buffer splices** limited to the mod-block regions: to add a
mod we clone the last element, swap its `MOD_ID`/`MOD_TITLE`, append it, and
bump the count; to remove one we drop its element and decrement the count.
Every byte outside the edited blocks is preserved verbatim
(see `adr/ADR-002-buffer-splice-config-edits.md`).

## Proven on fixtures

- Block scan: `count` field matches actual element count in every block.
- Mod extraction: 45–46 mods listed correctly (DLC + user's workshop/local mods).
- Round-trip: `addMod` re-parses with count+1 in every block, and
  `addMod` → `removeMod` returns a **byte-identical** file.

Run: `npm run phase0`. Code: `src/civ6cfg.js`.
