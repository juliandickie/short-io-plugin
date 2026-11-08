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

## 2026-11-05 - hosted MCP session lost, the app keeps reporting the bridge as connected

Seen in one client session. Every hosted MCP call returned `Bad
Request: No valid session ID provided` from mcp-remote, while the REST CLI worked with the
same machine and network. The app did not re-dial the server, because it still reported it as
connected. A fresh session's bridge answered `get-domains` normally the same day. Workaround -
open a new session, or use the CLI for the operation. Possible fix - have the launcher restart
mcp-remote when it reports a lost session, if mcp-remote exposes that; check upstream first.

## 2026-11-05 - the settings field and the config file can point at different accounts

The plugin settings field reaches only the MCP bridge (Claude Code passes it as
`SHORT_IO_API_KEY` to the bridge, never to the Bash tool), and the environment wins over the
config file. With one account's key in the settings field and another's in `config.toml`, the
MCP tools and the CLI in the same session write to different Short.io accounts with no
warning. Proved on the maintainer's machine - `get-domains` answered one account's domains and
`short-io whoami` the other's. The fix is the multi-account design (named accounts in
`config.toml`, the bridge picking its account by session folder, and an error when the settings
field is also set), planned for 0.2.0.

## 2026-11-05 - fixed in 0.2.0 - the settings field and the config file

Named accounts close the split in the entry above. Each account has its own key in
`config.toml`, and any Short.io setting in the environment beside them is an error.

A single-key setup can still split the same way, because its chain did not change. With one key
in the settings field and a different top-level `api_key` in the file, the MCP tools and the CLI
still use different accounts. The fix for that user is named accounts, or one key in one place.

## 2026-11-05 - fixed in 0.2.0 - create failed on any new destination

`create` and `bulk create` stopped with `links/multiple-by-url: No links found` whenever the
destination had no link on that domain yet. The by-URL lookup answers 404 in that case, and the
client treated it as an error. The 0.1.0 audit recorded only the case with a match, and its write
smoke used a destination that already had links, so neither saw it. The 0.2.0 dry run found it
on both accounts. Only the exact message counts as "no links", so a reworded message fails loud
and cannot create a duplicate link.

## 2026-11-08 - fixed in 0.2.1 docs - a blank settings field is not cleared

After 0.2.0 installed, the maintainer cleared the plugin settings fields in `/plugin manage`, and
every new session's bridge kept refusing for three days. `claude plugin configure` still listed
the API key field as "sensitive, set". Piping a blank value to `claude plugin configure
--values-stdin` answered "No configuration changes", and a null value is refused ("The input on stdin isn't a
JSON object of strings"). A
reinstall with `--keep-data` cleared it. The docs and the error message now give that step.
Possible plugin-side fix, not taken - ignore a settings key that equals one of the named accounts'
keys, which would reverse the rule that any setting beside named accounts is an error.
