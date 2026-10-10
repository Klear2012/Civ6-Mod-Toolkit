# Tuner bridge — `src/tuner.js`

What it is: the persistent TCP bridge to the running game's FireTuner port
(`localhost:4318`), reused for N commands on one connection. Who calls it:
library callers (`openBridge`, `executeRead`, `executeWrite`) and the thin CLI
on the same path (`node src/tuner.js "<lua>"`). Reads run in the GameCore
context; writes run only through the InGame context where the game accepts or
rejects each action. Database files are never opened. See
`adr/ADR-015-tuner-live-operation.md`.

## Reference (entry points)

| Entry | Role |
|---|---|
| `openBridge()` / `closeBridge(handle)` | One handshake (`APP:`, `LSQ:`), reused; bounded retry (3 attempts, 5 s handshake timeout) |
| `executeRead(handle, lua)` | GameCore context (read-only surface) |
| `executeWrite(handle, lua)` | InGame context (game-validated) |
| `node src/tuner.js "<lua>" [--write] [--state N]` | Same path as the library; prints JSON, exits 0/2/3/4 |

Snippets should `print()` what you want back; a sentinel print is added so
output ends. Needs Civ6 running windowed with `EnableTuner=1` (which disables
achievements for the session) and no FireTuner window (one connection only).

## How-to: run one snippet

1. Load or start a game first (menus expose no GameCore/InGame state).
2. Read: `node src/tuner.js "print(GameInfo ~= nil)"`.
3. Write: `node src/tuner.js "print(1+1)" --write`.
4. Menu screen: add `--state N` with an index from the handshake list.

## What it does not do

No database writes, no client-side Lua allow-listing, no per-command
connections. A write the game rejects stays rejected (surfaced, never
retried). Failure messages say the fix in plain words (game off, slot held,
missing `EnableTuner=1`, no loaded game).

## Tests

`npm run test:tuner` (`tests/tuner.test.js`, Temp loopback stub; live runs
recorded in the change findings, never assumed).
