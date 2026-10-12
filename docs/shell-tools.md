# shell-tools reference (template: init copies this to `docs/shell-tools.md`)

Per-user installs via scoop (`~/scoop/shims` on PATH). Git Bash only.
Source of truth: this file in `base/`. Per-project copies are snapshots.

_Synced from workflow base `a650d60` on 2026-10-12._

## Proficient defaults (one line each, no reference needed)

- `rg <pat> [path]` instead of `grep -rn`. Respects `.gitignore` by default.
- `fd <pat>` instead of `find -iname`. Add `-H -I` when hidden or gitignored files must be included.
- `gh <cmd> --json f1,f2 --jq '...'` for anything scripted.
- `just --list` to discover recipes; `just --dump --dump-format json` for machine-readable output.
- `gojq` exactly like `jq`; YAML via `gojq --yaml-input '.a' file.yaml`.

## Confusion-prone (read before first use)

- `sd` is NOT `sed`. It writes in place with no backup. Always preview first:
  `sd -p 'before' 'after' file`, then repeat without `-p` to write.
  Literal (non-regex) match: `sd -F`. Typing `sed` semantics into `sd` is the classic miss.
- `yq` is mikefarah v4, not kislyuk: `yq eval '.a.b = "x"' -i file.yaml`;
  JSON output: `yq eval -o=json '.' file.yaml`.
- `duf --json --only local` for filesystem table; `dust -j <path>` for directory tree as JSON.
- `procs` runs once (`procs --sortd cpu`, `procs --sortd mem`). Never `-w/--watch`: it blocks the agent.
- `hyperfine --export-json out.json 'cmd1' 'cmd2'` for benchmarks (multi-run by design).
  Single timing: shell `time`.

## Git Bash notes

Quote paths containing spaces or set the tool `workdir`. MSYS `/c/` vs `C:\` in output
passed to native Windows tools. Avoid TUI/pager flags in agent runs
(`--watch`, `--pager`, `--interactive`); prefer `--json`/`--color=never`.
