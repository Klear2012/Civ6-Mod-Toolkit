# `ROUTES` table — API dispatch in `src/server.js`

What it is: the first-match dispatch table that maps every API route to its
handler (`src/server.js`, `ROUTES`). Who calls it: `handleApi` — first match
wins, in table order. Handlers are thin: one per route, owning modules do the
work. See `adr/ADR-011-route-table-shape.md`.

## Reference (route groups)

| Group | Routes | Role |
|---|---|---|
| Load order | `GET /api/load-order`, `GET /api/action-files`, `GET /api/load-overrides`, `POST /api/load-overrides`, `/bulk`, `/reset`, `/discard`, `/reset-mod`, `/discard-mod`, `/sync`, `GET /api/load-overrides/export`, `POST /api/load-overrides/import` | Order view, overrides CRUD, block moves, set transfer |
| Conflicts | `GET /api/conflicts/shadowing`, `/replay`, `/packaging` | UI shadowing, DB replay, packaging |
| Mods | `GET /api/mods`, `/details`, `POST /api/mods/labels`, `/rename`, `/delete`, `/apply`, `/open-folder`, `/remove`, `POST /api/sync` | Listing, labels, apply, removal |
| Profiles | `GET /api/modgroups`, `/preview`, `/export`, `POST /api/modgroups/` (prefix) | Groups CRUD plus export/import |
| Setup | `GET /api/game-setup`, `POST /api/game-setup`, `/clear`, `GET /api/dashboard`, `GET /api/state`, `GET /api/game` | Assumed setup, dashboard, liveness |
| Config | `GET /api/config`, `POST /api/paths`, `/save`, `/delete`, `POST /api/ping`, `/shutdown` | `.Civ6Cfg` editing, paths, lifecycle |

## How-to: add a route

1. Write a thin `handle*` function next to the others.
2. Add one `ROUTES` row (`method`, `match`, `handler`; `kind: 'prefix'` only
   for the modgroups action route).
3. Put the logic in the owning module — never in the handler.

## What it does not do

No logic lives here: dispatch only, no validation, no writes. Route order
matters (first match wins) — the modgroups prefix row must stay after the
exact modgroups `GET` rows.

## Tests

No dedicated mirror. Every `tests/*.test.js` suite exercises its routes
through the API; see `tests.md` for the full list.
