---
name: setup
description: First-run setup for the Short.io plugin - create a SECRET API key, choose how it is supplied (SHORT_IO_API_KEY or the plugin config field, the 0600 config file for unattended use, or a 1Password reference), remove a stale user-scope MCP entry so tools do not double up, then verify with the plugin's short-io whoami.
disable-model-invocation: true
argument-hint: ""
---

# Short.io setup

Work through these in order. Steps 1 and 2 are the only ones that always apply.

## 1 Create a secret key

Open `https://app.short.io/settings/integrations/api-key` and create a key with the
"Public key" toggle OFF. A secret key starts with `sk_`. A public key starts with `pk_`
and is refused by both the REST API and the hosted MCP server, so if the plugin reports a
`pk_` key, go back and create a secret one.

Never paste the key into chat. Put it straight into one of the places below.

## 2 Choose how the key is supplied

The resolver checks these in order and takes the first that answers.

1. The environment, `SHORT_IO_API_KEY` first and then the plugin config field
   `short_io_api_key` set through `/plugin manage`, which arrives as an environment variable
   of its own. The env var wins if both are set. Use the plugin field for interactive work,
   where it is stored as a sensitive value, and the env var for CI and one-off shells.
2. The config file `~/.config/short-io-plugin/config.toml`, mode 0600. Best for unattended
   runs, because nothing has to be exported first.
3. A 1Password secret reference, read through the `op` CLI at start. Best when the key must
   never sit on disk in plain text.

`whoami` prints the source as `env`, `file` or `op`. Because the plugin config field is
supplied through the environment, both it and `SHORT_IO_API_KEY` report as `env`, so that
word does not tell you which of the two answered. If it matters, unset one and re-run.

The config file, for either the direct key or the 1Password pointer.

```toml
api_key = "sk_..."
```

Or, instead of `api_key`, the 1Password pointer and, when the `op` CLI is signed in to more
than one account, the account to read it from.

```toml
op_ref = "op://Vault/Item/field"
op_account = "yourteam.1password.com"
```

Create it with the right permissions before writing anything into it.

```bash
mkdir -p ~/.config/short-io-plugin && touch ~/.config/short-io-plugin/config.toml && chmod 600 ~/.config/short-io-plugin/config.toml
```

## 3 Remove a stale MCP entry

If a `short-io` MCP server was added by hand in an earlier session, the plugin's own server
and that one both register and the tools double up. Remove the hand-added entry.

```bash
claude mcp remove short-io -s user
```

If the same name is also registered at project scope, remove that too.

```bash
claude mcp remove short-io -s project
```

## 4 Restart the session

The plugin's SessionStart hook installs `mcp-remote`, which the hosted MCP bridge needs.
Restart Claude Code so the hook runs and the server starts with the key in place.

## 5 Verify

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io whoami
```

It prints the key source (`env`, `file` or `op`), then a row per domain with the numeric id, the hostname, the link
type and the link count. Then confirm the hosted tools are live by calling `get-domains` and
checking that the same domains come back. Both surfaces answering means the one key is
working on both.

## 6 Troubleshooting

| Message | What it actually means |
|---|---|
| `Unauthorized: No API key provided` | The header was malformed or the value was empty. The key itself may be fine. Check for a `Bearer ` prefix, which Short.io refuses, and for an empty config value. |
| `mcp-remote is not installed` | The SessionStart hook has not run or failed. Run `scripts/install-deps.sh` from the plugin directory, then restart. |
| A message about a `pk_` key | A public key was supplied. Create a secret key with the "Public key" toggle OFF. |
| `no API key configured` | None of the four sources answered. Re-check step 2, then re-run `whoami`. |

Exit code 2 from the CLI is a configuration or usage problem, exit code 1 is an API or
network error.
