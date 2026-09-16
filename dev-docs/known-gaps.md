# Known gaps, dated and additive

## 2026-09-16 - first session after install shows the bridge as closed

The plugin's MCP server is spawned at session start, at the same moment the SessionStart
hook installs mcp-remote into the plugin data dir. On the very first session after an
install the launcher can run before `dist/proxy.js` exists, exits 2 with the install hint,
and the session reports `plugin:short-io:short-io ... Connection closed`. Observed on the
maintainer's machine: install.log written 14:42:03, mcp-remote package.json 14:42:05, bridge
already attempted. The next session connects normally. Workaround - open a new session, or
run `scripts/install-deps.sh` with `CLAUDE_PLUGIN_ROOT` set before the first session.
Possible fix for 0.1.1 - have `run-mcp.mjs` run the installer itself when `proxy.js` is
missing, then continue, instead of exiting.
