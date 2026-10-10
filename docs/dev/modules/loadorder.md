# Module `loadorder.js` — global load order + overrides

What it is: the single place that computes mod load order and applies user
overrides. Who calls it: `src/server.js` (pages + API), `src/loadorder-fit.js`
(fit geometry — split out, see its header).

## Reference (exported surface, grouped)

| Group | Functions | Role |
|---|---|---|
| Open | `openDb(dbPath, {readOnly})` | Open the mods database; read-only by default |
| Identity | `keyFor`, `actionKey`, `resolveAction`, `isModId` | Keys and component-row identity with server resolution |
| Read | `modFile`, `actionFiles`, `actionFilesOf`, `modActionFilesOf` | Which files a mod / action touches |
| Freshness | `stampFor`, `stampIsStale`, `staleMods` | Detect mods changed behind our back |
| Overrides I/O | `readOverrides`, `writeOverrides`, `setOverride`, `clearOverride`, `listOverrides`, `syncOverrides` | Persisted user overrides (`load-order-overrides.json`) |
| Apply | `applyOverrides`, `applyBulk`, `resetOverride`, `resetModOverrides`, `discardModOverrides` | Atomic apply with game guard; bulk capped at `MAX_BULK_ENTRIES` |
| Read model | `profileLoadOrder`, `installedMods`, `enabledMods`, `readProfile`, `groupsOf`, `activeGroupId` | Global order with profile as filter |
| Verdicts | `verdictOf`, `evalCondition`, `isAssumedMatch`, `setupKeysFor` | Will-run / assumed verdicts for gated actions |
| Geometry | `describeBlock`, `proposeBlock`, `occupiedOf`, `buildEvenSpacing`, `buildOverflow`, `buildManual`, `MIN_FREE_RUN` | Block fit math (implementation detail split toward `loadorder-fit.js`) |
| Markers | `VERSION`, `FIND`, `MISSING`, `AMBIGUOUS`, `SENTINEL` | Result markers, never shown raw to players (see UI-copy rules) |

## How-to: move a mod's actions as a block

1. Resolve the mod's actions (`resolveAction` per component row).
2. Propose the target (`proposeBlock` — anchor or free band).
3. Check fit (`occupiedOf`); on no-fit, surface the three paths, never invent an ordering.
4. Apply atomically (`applyOverrides`); refused while Civ6 runs (game guard).

## How-to: read the order for a profile

Call `profileLoadOrder(dbPath)` — it returns the global order filtered to the
active profile. Never build a per-profile order; see
`adr/ADR-003-global-order-profile-filter.md`.

## How-to: share an override set (import/export)

The overrides page offers Export (downloads the set as
`civ6-loadorder-overrides.json`) and Import next to Re-apply-all. Import
replaces the whole set, keeps the previous file as a same-directory backup
first, and lists entries that match nothing here instead of adding them; it
is refused while Civ6 runs, while export works while it runs. The logic lives
in `src/loadorder-transfer.js` (`exportOverrides`, `importOverrides`);
`src/server.js` keeps only the two thin handlers plus two `ROUTES` rows.
Contract: `tests/loadorder.test.js` Tests 20–21.
