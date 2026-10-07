# Developer docs

For contributors. Users start at `docs/user/` (screen how-tos) or the README.

## Map

| You want | Go to |
|---|---|
| 1-page orientation (entry, pipeline, verify) | `docs/ARCHITECTURE.md` |
| What finished when, what depends on what | `docs/TRACEABILITY.md` (local-only) |
| Why a choice was made | `docs/decisions/` (local-only) |
| Binary format of `.Civ6Cfg` | `data-formats.md` |
| Vocabulary used across the project | `glossary.md` |
| How module X works (1 file = 1 module in `src/`) | `modules/<x>.md` |
| Behavior contracts (the source of truth) | `openspec/specs/` |
| Binary-format lab notebook | `FINDINGS.md` (repo root) |

## Rules

- Behavior lives in `openspec/specs/`. Dev pages describe usage and internals
  and **point at the spec path** — they never copy requirements.
- Each module page opens with 3 lines (what it is, who calls it), then a
  reference table, then copy-pasteable examples.
- New page only when a question is asked twice, or a page passes ~250 lines
  and splits into independently readable parts. Otherwise append to the
  existing page.
- Writing style: active voice, present tense, address "you". Commands are
  imperatives. Links name their destination.
- Never reference `openspec/changes/`, `AGENTS.md`, or session mechanics here.
  This tree is committed; that history is local-only.
