# UI CSS variables — theming contract in `public/style.css`

What it is: the single theming contract for the browser UI — every color,
type size, and spacing value lives in `:root` variables at the top of
`public/style.css`, with light-mode overrides under
`prefers-color-scheme: light`. Who uses it: every page stylesheet rule
references these; add a value here rather than inlining a literal.

## Reference (variable groups)

| Group | Variables | Role |
|---|---|---|
| Surfaces | `--bg`, `--panel`, `--panel-2`, `--border` | Page, card, inset, and border colors |
| Text | `--text`, `--muted` | Body and secondary text |
| Accent | `--accent`, `--accent-dim` | Links, primary actions, highlights |
| State | `--add`, `--remove` | Enable/add vs disable/remove signals |
| Shape | `--radius` | Corner rounding |
| Type scale | `--font-xs` … `--font-card-value` | Fixed size steps (rows, filters, dialogs, cards) |
| Controls | `--btn-pad*`, `--btn-font*`, `--btn-control-h`, `--btn-icon*` | Button padding, type, height, icon sizes |
| Chips | `--chip-pad`, `--tag-pad`, `--lo-tag-pad` | Label, tag, and load order tag padding |

## How-to: theme a new control

1. Pick the nearest existing variable (accent for actions, muted for secondary
   text, panel for surfaces).
2. Only add a variable when no existing one fits — name it by role, not by
   value.
3. Check both color schemes: every dark variable you use needs its light
   override to still read.

## What it does not do

No behavior: variables carry no logic and no page reads them from script.
Player-facing wording still keeps raw internals out of tooltips and labels —
no file paths, ids, or markup keys in anything the player reads.

## Tests

No mirror — pure CSS. Script safety around it is covered by
`tests/browser-scripts.test.js`; see `tests.md`.
