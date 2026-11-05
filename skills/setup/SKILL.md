---
name: setup
description: First-run setup for the Short.io plugin - create a SECRET API key, choose how it is supplied (SHORT_IO_API_KEY or the plugin config field, the 0600 config file for unattended use, or a 1Password reference), add a second account with its own key and folders, remove a stale user-scope MCP entry so tools do not double up, then verify with the plugin's short-io whoami.
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

## 3 Add a second account

Skip this step if you have one key. A one-key setup keeps working with no change.

Give each account its own section in the config file. `default` names the account for any
folder that no account lists.

```toml
default = "agency"

[accounts.agency]
api_key = "sk_..."

[accounts.clinic]
api_key = "sk_..."
folders = ["~/code/clinic-site", "~/code/clinic-shop"]
```

A section takes `api_key`, or `op_ref` with an optional `op_account`, plus an optional
`folders`. `folders` is one string or a one-line array of double-quoted strings, each a full
path or starting with `~/`. An account name uses letters, digits, `_` and `-`. With one
account, `default` may be left out.

Each surface picks its account in its own way.

1. The MCP tools use the account for the session's folder. An account matches when one of its
   folders is the session's folder or a parent of it, and the longest match wins. No match
   means `default`. So the tools serve one account per session.
2. The CLI uses the account that owns the domain you give it, whichever folder you are in.
   It tries the folder's account, then `default`, then the rest of the file in order.
3. `--account <name>` makes any CLI command use that account only.

To move from one key to two, follow these steps.

1. Open `~/.config/short-io-plugin/config.toml`.
2. Add a line `[accounts.<name>]` directly above the existing `api_key` line.
3. Add a second `[accounts.<name>]` section below it, with the second `api_key`.
4. Add a `folders` line to each account that owns a folder.
5. Add `default = "<name>"` as the first line of the file, above every section.
6. Clear all three Short.io fields in `/plugin manage`, and unset `SHORT_IO_API_KEY` in your
   shell. **Warning** - the CLI stops and the MCP bridge refuses to start while any of them is
   set beside named accounts, because two keys could silently compete.
7. Restart the session.
8. Run the `whoami` command in the Verify step, and read which account each domain is under.

## 4 Remove a stale MCP entry

If a `short-io` MCP server was added by hand in an earlier session, the plugin's own server
and that one both register and the tools double up. Remove the hand-added entry.

```bash
claude mcp remove short-io -s user
```

If the same name is also registered at project scope, remove that too.

```bash
claude mcp remove short-io -s project
```

## 5 Restart the session

The plugin's SessionStart hook installs `mcp-remote`, which the hosted MCP bridge needs.
Restart Claude Code so the hook runs and the server starts with the key in place.

## 6 Verify

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io whoami
```

It prints the key source (`env`, `file` or `op`), then a row per domain with the numeric id, the hostname, the link
type and the link count. Then confirm the hosted tools are live by calling `get-domains` and
checking that the same domains come back. Both surfaces answering means the one key is
working on both.

With two or more accounts, `whoami` prints that block for every account, then the default
account and the account this folder's MCP tools use. `get-domains` should answer the domains
of that one account.

## 7 Troubleshooting

| Message | What it actually means |
|---|---|
| `Unauthorized: No API key provided` | The header was malformed or the value was empty. The key itself may be fine. Check for a `Bearer ` prefix, which Short.io refuses, and for an empty config value. |
| `mcp-remote is not installed` | The SessionStart hook has not run or failed. Run `scripts/install-deps.sh` from the plugin directory, then restart. |
| A message about a `pk_` key | A public key was supplied. Create a secret key with the "Public key" toggle OFF. |
| `no API key configured` | None of the four sources answered. Re-check step 2, then re-run `whoami`. |
| `... is set ... while ... has [accounts.*] sections` | A key is in the plugin settings field or the environment beside named accounts. Move it into an `[accounts.<name>]` section and clear the field. The message names the variable, never its value. |
| `No account for <folder>` | There is more than one account, no `default`, and no account lists this folder, so the bridge will not start here. Add `default`, or add the folder to an account. |
| `No account owns domain` | No configured key can see that domain. The message lists each account and its domains. |
| `No domain X on this account` with `--account` | The named account does not own that domain. Drop `--account` to let the CLI find the owner. |
| `folders must be a string or a one-line array` | A `folders` value could not be read, often an array split over several lines. Put it on one line. |

Exit code 2 from the CLI is a configuration or usage problem, exit code 1 is an API or
network error.
