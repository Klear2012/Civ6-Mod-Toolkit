# Verify command (single owner; `AGENTS.md` + `openspec/config.yaml` link here, never re-copy)

- Command: `npm run check:release` (defined in `package.json` `scripts.check:release`).
- Runs: all `test:*` stdlib `node:test` mirrors over `tests/`, `phase9-selfcheck`, `phaseclean`, `lint:comments`.
- CI binding: `.github/workflows/release.yml` runs the same command as the release gate, so the gate cannot drift out of step with it.
- Scratch discipline: any run touching store files must set `CIV6_*_FILE` overrides pointing at `Temp\opencode\`, so default store paths never materialize repo-root JSON (the `phaseclean` gate fails the release on stray artifacts).
