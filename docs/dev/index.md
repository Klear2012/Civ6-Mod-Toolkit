# Developer docs

For contributors. Users start at the README.

## Map

| You want | Go to |
|---|---|
| 1-page orientation (entry, pipeline, verify) | `docs/ARCHITECTURE.md` |
| What finished when, what depends on what | `docs/TRACEABILITY.md` (local-only) |
| Why a choice was made | `adr/` (+ archived changes) |
| Binary format of `.Civ6Cfg` | `data-formats.md` |
| Vocabulary used across the project | `glossary.md` |
| How module X works (1 file = 1 module in `src/`) | `modules/<x>.md` |
| Behavior contracts (the source of truth) | `tests/*.test.js` mirrors + `adr/` |
| Binary-format lab notebook | `FINDINGS.md` (repo root) |

## Rules

- Behavior lives in `tests/*.test.js` mirrors + `adr/`. Dev pages describe usage and internals
  and **point at the test/ADR path** — they never copy requirements.
- Each module page opens with 3 lines (what it is, who calls it), then a
  reference table, then copy-pasteable examples.
- New page only when a question is asked twice, or a page passes ~250 lines
  and splits into independently readable parts. Otherwise append to the
  existing page.
- Writing style: active voice, present tense, address "you". Commands are
  imperatives. Links name their destination.
- Never reference `openspec/changes/`, `AGENTS.md`, or session mechanics here.
  This tree is committed; that history is local-only.
