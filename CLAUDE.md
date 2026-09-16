# short-io-plugin

## What This Plugin Does

This plugin bridges Claude Code to Short.io link management under the user's own API key. It combines two access paths, Short.io's hosted MCP server for the interactive tools (create, edit, search, and measure short links) and a local REST gap CLI for the operations the hosted MCP does not cover, full link enumeration on a domain, destination checks on a slug, deduplicated bulk creation from a CSV, and deletion. The two paths share one configured API key so the user sets credentials once and gets both surfaces.

## Repo Layout Rules

The repo follows the file map set out in the task plan, a `.claude-plugin/` directory for the plugin and marketplace manifests, `.mcp.json` for the hosted MCP bridge configuration, `hooks/` for the SessionStart dependency installer, `scripts/` for the installer and the MCP launcher, `skills/short-io/` for the router skill, and `test/` for the automated tests. Each area stays scoped to that one responsibility so a change to the CLI, the MCP bridge, or the packaging never spills into the others.

## Build and Test

There is no build step, the plugin runs directly from source under Node >=22 in ESM mode with zero runtime dependencies. `npm test` runs `node --test test/*.test.js` for the unit and integration tests, and `claude plugin validate .` checks the plugin manifest, hook, and skill structure. Both are expected to pass before any commit that touches plugin behavior.

## Versioning

The plugin version is tracked in four places that move together, the `version` field in `package.json`, the `version` field in `.claude-plugin/plugin.json`, the `version` field in `.claude-plugin/marketplace.json`, and the `version` field on the plugin entry inside that marketplace manifest's `plugins` array. A version bump updates all four in the same commit so the packaged plugin, the marketplace listing, and the installed package never disagree about which release is current.
