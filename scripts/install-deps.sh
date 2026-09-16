#!/usr/bin/env bash
# SessionStart hook - installs mcp-remote into the persistent plugin data dir (never the
# plugin root, which is replaced on update). Quiet and idempotent - prints one line only
# when it installs, and never fails the session start.
set -uo pipefail
ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$ROOT" ]; then echo "short-io: CLAUDE_PLUGIN_ROOT is not set; skipping dependency check" >&2; exit 0; fi
# Same precedence as dataDir() in lib/config.mjs - the override wins, then the plugin data
# dir, then the default location.
DATA="${SHORT_IO_PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/short-io}}"
WANT="$(ROOT="$ROOT" node -p "require(process.env.ROOT + '/package.json').shortIoPlugin.mcpRemoteVersion" 2>/dev/null || echo "")"
if [ -z "$WANT" ]; then echo "short-io: could not read the pinned mcp-remote version from package.json" >&2; exit 0; fi
HAVE=""
if [ -f "$DATA/node_modules/mcp-remote/package.json" ]; then
  HAVE="$(DATA="$DATA" node -p "require(process.env.DATA + '/node_modules/mcp-remote/package.json').version" 2>/dev/null || echo "")"
fi
# The version alone is not proof of a usable install - the launcher runs dist/proxy.js, so a
# half-unpacked or pruned tree needs reinstalling even when package.json reads right.
if [ "$HAVE" = "$WANT" ] && [ -f "$DATA/node_modules/mcp-remote/dist/proxy.js" ]; then exit 0; fi
mkdir -p "$DATA"
if [ ! -f "$DATA/package.json" ]; then printf '{ "name": "short-io-plugin-data", "private": true }\n' > "$DATA/package.json"; fi
if npm install --prefix "$DATA" --no-audit --no-fund --no-package-lock --ignore-scripts --loglevel=error "mcp-remote@$WANT" >/dev/null 2>"$DATA/install.log"; then
  echo "short-io: installed mcp-remote $WANT into the plugin data dir"
else
  echo "short-io: mcp-remote install failed (see $DATA/install.log); the Short.io MCP bridge is unavailable this session, the short-io CLI still works" >&2
fi
exit 0
