# short-io-plugin - AI Agent Context File

## What This Plugin Does

This plugin bridges Claude Code to Short.io link management under the user's own API key. It
combines two access paths, Short.io's hosted MCP server for the interactive tools (create,
edit, search, and measure short links) and a local REST gap CLI for the operations the hosted
MCP does not do well, full link enumeration on a domain, destination checks on a slug,
deduplicated bulk creation from a CSV, and deletion. The two paths share one configured key
resolver, so the user sets credentials once and gets both surfaces. Sibling plugins (Heyzine
for flipbooks, Scribe for Drive and Docs, wp-manager and the academy tooling for LearnDash)
are composed by capability reference in skill prose, never by importing their tools.

## Repo Layout Rules

Seven directories at the plugin root - `lib/` (the modules - config, client, links, check,
bulk, csv, cli), `bin/` (the `short-io` entry point), `scripts/` (`run-mcp.mjs` and
`install-deps.sh`), `hooks/` (hooks.json), `skills/` (the seven skills), `test/` (one file per
lib module plus the launcher contract), and `dev-docs/` (tracked, dated, additive logs - the
API audit, smoke records, the release checklist). `.claude-plugin/` holds only `plugin.json`
and `marketplace.json`, and `.mcp.json` sits at the root as the hosted MCP bridge
configuration. Use `${CLAUDE_PLUGIN_ROOT}` for bundled paths and `${CLAUDE_PLUGIN_DATA}` for
anything written at runtime. `docs/` is gitignored and local only (spec, plan, probe
artifacts). Each area stays scoped to one responsibility so a change to the CLI, the MCP
bridge, or the packaging never spills into the others.

## Build and Test

There is no build step, the plugin runs directly from source under Node >=22 in ESM mode with
zero runtime dependencies beyond the pinned `mcp-remote` the SessionStart hook installs.
`npm test` runs `node --test test/*.test.js` for the unit and integration tests, and
`claude plugin validate .` validates the plugin and marketplace manifests, and nothing beyond
them, so `npm test` is the gate for behavior. Every module
in `lib/` takes its side effects (fs, exec, fetch, clock) as injectable parameters and is unit
tested without network access. Both gates are expected to pass before any commit that touches
plugin behavior.

## Known API Limits (proven live, dev-docs/api-audit-2026-09-16.md)

`GET /api/links` caps `limit` at 150 and requires the numeric `domain_id`; a hostname answers
400, and `count` carries the true total on every page. `POST /links` dedupes silently, so an
existing path with the same destination, or a missing path with an already shortened
destination, answers 200 with the EXISTING record and creates nothing. On a domain with a
default fallback configured there is no 404, so an unknown slug redirects exactly like a real
one and only `GET /links/expand` tells the truth about a slug. Rate limits are per endpoint
family read from `x-ratelimit-limit`, 1000 for listing, 50 for link creation, 20 for link info
and delete, and the hosted MCP endpoint's 30 per minute is a separate budget. The key goes in
the `authorization` header bare; a `Bearer ` prefix answers the same 401 as no header at all.

## Versioning

MAJOR breaking skill or CLI change, MINOR new skill or command, PATCH fix. The plugin version
is tracked in four files that move together, `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json` (where two copies move as one, the `metadata` version and
the version on the plugin entry inside the `plugins` array), and the top heading in
`CHANGELOG.md`. A version bump updates all of them in the same commit so the packaged plugin, the marketplace listing, and the installed
package never disagree about which release is current. See `dev-docs/release-checklist.md`.
