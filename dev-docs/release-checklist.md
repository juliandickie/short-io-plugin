# Release checklist

1. `npm test` green (`node --test test/*.test.js`), `claude plugin validate .` passes.
2. Re-run the install hook cold against the real data dir (`rm -rf` the data dir's
   `node_modules` first) and confirm one install line then silence on the second run.
3. Bump the four version copies together - `.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json` (both the metadata version and the plugin entry's),
   `package.json`, `CHANGELOG.md` (move the unreleased section under the version and date).
4. Commit on main. Pushing, tagging (`vX.Y.Z`, annotated), and listing in the outfit and
   ai-loadout catalogues (both marketplace.json files and both README tables, same order)
   are separate actions each needing the maintainer's go.
5. After a listing change, reinstall locally and confirm the cache version, then run the
   installed CLI from a terminal session and confirm the MCP tools appear (desktop sessions
   may not spawn plugin servers). The CLI is not on PATH, and the cache path rotates with
   every version and session, so glob it at run time and never pin it.

   ```bash
   "$(ls -d ~/.claude/plugins/cache/*/short-io/*/ | tail -1)bin/short-io" whoami
   ```

   Inside a Claude Code session the same command is
   `${CLAUDE_PLUGIN_ROOT}/bin/short-io whoami`.
6. Release smoke - one real slug through `${CLAUDE_PLUGIN_ROOT}/bin/short-io create`, then
   `check`, then `delete` on the maintainer's account, recorded in
   `dev-docs/smoke-<date>.md` with the account identifiers redacted.
