# short-io

A Claude Code plugin for [Short.io](https://short.io), running under your own API key. It
gives Claude two surfaces over one set of credentials. Short.io's hosted MCP server supplies
the conversational tools, creating a link, editing one, searching the account and answering
every click question, and this plugin adds a local CLI for the work those tools do not do
well, enumerating every link on a domain past the 150 row page limit, checking what a slug
really points at rather than what a browser appears to show, creating many links from a
spreadsheet with duplicate detection, and deleting.

The judgement is the point. Short.io's create endpoint dedupes silently, answering 200 with
an existing record instead of an error, so anything that counts 200s as creations over-counts.
A short domain with a fallback configured redirects an unknown slug exactly like a real one,
so an HTTP status proves nothing about whether a link exists. The CLI is built around both
facts, it classifies every create as `created`, `exists`, `taken`, `duplicate` or `invalid`,
and it reports the configured destination before the live hop. If all you want is the vendor's
own command line tool wrapped as a skill, Short.io publishes a single-skill Claude Code plugin
in the [`Short-io/shortcm-cli`](https://github.com/Short-io/shortcm-cli) repository
(npm `@short.io/cli`), which is the lighter alternative and does not overlap with the gap
commands here.

## Install

Listed in the loadout and outfit catalogues since v0.1.0 (16 September 2026):

```
/plugin marketplace add juliandickie/ai-loadout
/plugin install short-io@loadout
/short-io:setup
```

Or install straight from this repository, which carries its own single-plugin marketplace:

```
/plugin marketplace add juliandickie/short-io-plugin
/plugin install short-io@short-io-plugin
/short-io:setup
```

One copy is enough. Installing from two marketplaces gives you two copies of the same skills.
A SessionStart hook installs the pinned `mcp-remote` into the plugin data dir on first run,
printing one line when it installs and staying silent afterwards. If that install fails the
MCP bridge is unavailable for the session and the CLI still works.

## Get a key

Open <https://app.short.io/settings/integrations/api-key> and create a key with the
"Public key" toggle OFF. A secret key starts with `sk_`. A public key starts with `pk_` and is
refused by both the REST API and the hosted MCP server, so the plugin checks the prefix before
it sends anything and tells you which kind you supplied.

Never paste the key into chat. Put it straight into one of the places below.

## Choose how the key is supplied

Both surfaces share one resolver, and the first method that answers wins.

| Method | How it is supplied | When to use it |
|---|---|---|
| Environment variable | `SHORT_IO_API_KEY` exported in the shell | CI and one-off shells. Beats the plugin field when both are set |
| Plugin config field | "Short.io API Key" in `/plugin manage`, stored as a sensitive value and delivered as an environment variable | A single interactive machine |
| Config file | `api_key` in `~/.config/short-io-plugin/config.toml`, mode 0600 | The unattended default, because nothing has to be exported first |
| 1Password reference | `op_ref = "op://Vault/Item/field"` in that file, or the "1Password Secret Reference" plugin field, read through the `op` CLI at start | A machine where the key should never sit on disk. Needs 1Password unlocked |

The config file is the recommended method. Create it with the right permissions before
writing anything into it.

```bash
mkdir -p ~/.config/short-io-plugin
touch ~/.config/short-io-plugin/config.toml
chmod 600 ~/.config/short-io-plugin/config.toml
```

```toml
api_key = "sk_..."
```

Or, instead of `api_key`, the 1Password pointer plus, when the `op` CLI is signed in to more
than one account, the account to read it from.

```toml
op_ref = "op://Vault/Item/field"
op_account = "yourteam.1password.com"
```

Then verify. `whoami` prints the key source and a row per domain, and never prints the key
itself.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io whoami
```

The source reads `env`, `file` or `op`. Because the plugin config field arrives as an
environment variable of its own, it and `SHORT_IO_API_KEY` both report as `env`, so that word
does not tell you which of the two answered. Unset one and re-run if it matters.

## More than one account

Give each account its own section in the config file. One-key setups need none of this and
keep working with no change.

```toml
default = "agency"

[accounts.agency]
api_key = "sk_..."

[accounts.clinic]
api_key = "sk_..."
folders = ["~/code/clinic-site", "~/code/clinic-shop"]
```

A section takes `api_key`, or `op_ref` with an optional `op_account`, plus an optional
`folders`, which is one string or a one-line array. `default` names the account for any folder
no account lists, and with one account it may be left out.

The two surfaces pick the account differently.

| Surface | How it picks | What that means |
|---|---|---|
| MCP tools | The account for the session's folder, else `default` | One account per session. A folder matches itself and everything under it, and the longest match wins |
| CLI | The account that owns the domain you give it | Every account, from any folder. `--account <name>` pins it to one |

So a link for the other account goes through the CLI. Statistics and edits have no CLI command,
so for those open a session in a folder of the account that owns the domain.

`whoami` prints every account, its key source, its folders and its domains, then the default
account and the account this folder's MCP tools use. The bridge writes the same answer to its
stderr when it starts. It works from the folder Claude Code starts it in, which is observed
behaviour rather than a documented contract, so check `whoami` when it matters.

**The settings fields must be empty.** A key in the plugin settings field or in
`SHORT_IO_API_KEY` beside named accounts is an error in both surfaces, because the two keys
could silently compete. The same goes for the 1Password fields and variables. The bridge
refuses to start and the CLI exits 2, and both say what to change.

These are errors too, each with the fix in the message.

- A top-level `api_key` or `op_ref` beside `[accounts.*]` sections.
- `default` naming an account that does not exist.
- A section with neither `api_key` nor `op_ref`.
- The same folder listed by two accounts, compared after resolving symlinks.
- A repeated section, or a key set twice in one section.
- A `folders` value that cannot be read, or an entry that is not a full path or `~/` path.
- Any section header other than `[accounts.<name>]` beside named accounts, because a mistyped
  header would drop that account and send its folders to the default.
- More than one account, no `default`, and a folder no account lists (the bridge only).

In a one-key file, a section header that looks like an account (`[account.x]`) is an error too.
Any other `[section]` there is skipped with a warning, and its keys are ignored. A listed folder
that does not exist gets a warning, so a typo cannot quietly send a session to the default.

To move from one key to two, put `[accounts.<name>]` above your existing `api_key` line, add
the second section and any `folders`, add `default = "<name>"` as the first line, clear the
plugin settings fields, then restart and run `whoami`. `/short-io:setup` has the steps.

## The bare-key gotcha

Short.io wants the key bare in the `authorization` header. The `Bearer` prefix that nearly
every other API expects is rejected, and the rejection says nothing about a prefix, so a
perfectly good key looks revoked.

| Header sent | Answer |
|---|---|
| `authorization: sk_...` | 200, the request works |
| `authorization: Bearer sk_...` | 401 `{"error":"Unauthorized"}` on REST, `Unauthorized: No API key provided` from the hosted MCP server |
| No `authorization` header at all | The same 401, with the same wording |
| `authorization: pk_...` | Refused, a public key is not accepted for the MCP server or for writes |

The two 401s are indistinguishable, which is why the setup skill treats
`Unauthorized: No API key provided` as a malformed header first and a bad key second. The same
`Bearer` mistake was published in Docker's mcp-registry entry for Short.io; the correction is
<https://github.com/docker/mcp-registry/pull/4622>.

## What you get - MCP tools

Fourteen tools on `https://ai-assistant.short.io/mcp`, 30 requests per minute, eleven
purpose-built and three that reach the REST API directly.

| Tool | What it does |
|---|---|
| `create-short-link` | Creates a link, with the UTM, A/B split and expiry fields. No duplicate check of its own |
| `edit-link` | Updates an existing link |
| `get-link-list` | Lists links on a domain, paged, 150 per call |
| `search-links` | Free text search across the account's links |
| `get-domains` | Lists domains with their numeric ids and hostnames |
| `update-domain-settings` | Changes settings on a domain |
| `link-statistics` | Clicks and breakdowns for one link |
| `domain-statistics` | Clicks and breakdowns for a whole domain |
| `top-column-statistics` | Top values of one column over a period |
| `top-by-interval-column` | A time series of one column over a period |
| `top-column-by-link-statistics` | Top values of one column for a single link |
| `list-api-endpoints` | Lists the REST endpoints the server can reach |
| `describe-api-endpoint` | The parameter schema for one endpoint |
| `call-api` | Executes any Short.io REST request as the user, DELETE and bulk endpoints included |

Because `call-api` exists, the MCP surface can do anything the REST API can, deletion
included. A `call-api` write takes effect immediately and has no dry run, so never repeat one
after a timeout without checking first whether it already landed.

## What you get - CLI

`${CLAUDE_PLUGIN_ROOT}/bin/short-io <command>`. Every command takes `--json` and
`--account <name>`.

| Command | The problem it solves |
|---|---|
| `whoami [--json]` | Proves each key works, says which of the four methods supplied it, and names the account this folder's MCP tools use |
| `domains [--json]` | The numeric id and the hostname together, because the read and statistics tools want the id and create wants the hostname. Names the account when the config file has named accounts |
| `links <domain\|id> [--json\|--csv] [--include-archived]` | Every link on the domain, paged past the 150 row limit to the true total, which the hosted list tool leaves you to page yourself |
| `check <domain/slug \| https://host/slug> [--json]` | What the slug is actually configured to do, the live hop, and whether the domain 404s or falls back, which no HTTP status can tell you |
| `create <domain> <url> [--path s] [--title t] [--tags a,b] [--allow-duplicate] [--json]` | A create that checks the slug and the destination first, so a silently returned existing record is reported as `exists`, never as new |
| `bulk create <file.csv\|file.json> --domain <d> [--yes] [--allow-duplicate] [--out results.csv]` | Many links unattended, with a dry-run scope table first, dedupe inside the file and against the account, pacing under the rate limit, and a results CSV |
| `delete <domain/slug> --yes [--json]` | A delete that resolves the `idString` from `domain/slug` itself and refuses to act without `--yes` |

Exit codes are 0 ok, 1 API or network error, 2 configuration or usage. `create` returns 0 for
`created` and `exists` and 1 for `taken`, `duplicate` and `invalid`. `bulk create` returns 1
when any row failed. `check` has six verdicts, `ok`, `free`, `free-but-redirects`,
`free-but-served`, `mismatch` and `not-resolving`, and an `ok` may carry a `served` note of
`redirect`, `cloaked` or `password`. `free` means nothing is serving the slug (the live answer
was a 404, another status, or a probe that failed); `free-but-redirects` and `free-but-served`
mean the slug is unclaimed but the domain answers anyway, by redirect or by a 200 page.
The bulk results CSV columns are `row,url,path,action,short_url,id,note`.

## Skills

| Skill | What it does |
|---|---|
| `short-io` | Overview and router - the two ways in, which surface for which job, the id rules, the quirks |
| `/short-io:setup` | First-run setup - create a secret key, choose how it is supplied, add a second account, clear a stale MCP entry, verify with `whoami` |
| `create-link` | One link with duplicate checks, titles, tags and UTM fields, then a destination verification |
| `bulk-links` | Many links from a CSV or JSON file, dry run first, then create with counts and a results CSV |
| `audit-links` | Every link on a domain, what one or many slugs really point at, and a reconcile of a destination list against the account |
| `link-stats` | Clicks, countries, referrers, browsers and campaigns for a link or a whole domain over a period |
| `short-io-api` | Reference for the endpoints, the tool arguments, the rate limits and the exit codes. Loaded automatically, not user invocable |

## Quirks worth knowing

- Short.io identifies a domain two ways and the surfaces disagree. `create-short-link` and the
  REST API take `domain` as a hostname string; `get-link-list` and every statistics tool take
  the numeric `domainId`. A link is identified by its `idString`, not by its slug. Run
  `${CLAUDE_PLUGIN_ROOT}/bin/short-io domains` once and carry both.
- The search parameter on `search-links` is `q`, not `query`.
- Any unknown property sent to a hosted MCP tool answers HTTP 500, so send only the documented
  arguments.
- `get-link-list` returns at most 150 links per call and pages by `beforeDate`, set to the
  oldest `createdAt` of the previous page. The `count` field carries the true total.
- On a domain with a default fallback configured, an unknown slug answers a redirect exactly
  like a real one, so a 200 or a 302 from the short domain proves nothing. Only `expand`,
  which `check` uses, tells the truth.
- `POST /links` dedupes silently. Repeat a destination and the API answers 200 with the
  existing record rather than creating anything.
- REST rate limits are per endpoint family, 1000 for listing, 50 for link creation and 20 for
  link info and delete. The hosted MCP endpoint's 30 per minute is a separate budget.

## Troubleshooting

| Symptom | What it actually means |
|---|---|
| `Unauthorized: No API key provided` | The header was malformed or the value was empty, so the key itself may be fine. Check for a `Bearer ` prefix and for an empty config value |
| A message about a `pk_` key | A public key was supplied. Create a secret key with the "Public key" toggle OFF |
| `no API key configured` | None of the four methods answered. Re-check the key section above, then re-run `whoami` |
| The MCP tools do not start, with a message about `[accounts.*]` sections and the settings field | A key is in the plugin settings field or the environment beside named accounts. Move it into a section and clear the field |
| `get-domains` does not list a domain you own | The domain belongs to another account, and the MCP tools serve this folder's account only. Use the CLI, or open a session in that account's folder |
| `No account owns domain` | No configured key can see that domain. The message lists each account and its domains |
| `mcp-remote is not installed` | The SessionStart hook has not run or failed. Run `scripts/install-deps.sh` from the plugin directory, then restart |
| The MCP tools are missing but the CLI works | Desktop sessions sometimes do not spawn plugin MCP servers. The CLI is the fallback, not a reason to stop |
| Duplicate `short-io` tools | An MCP server of the same name was added by hand in an earlier session. `claude mcp remove short-io -s user`, and the same at project scope |
| A config file warning about permissions | The file is readable by other users. `chmod 600 ~/.config/short-io-plugin/config.toml` |
| `limit must be <= 150` | Something asked for a bigger page than Short.io allows. The CLI pages for you |
| A create reported as `exists` rather than `created` | The API returned an existing record for that slug and destination. Nothing was created, and nothing is wrong |

## Development

```bash
npm test                    # node --test test/*.test.js
claude plugin validate .
```

`npm test` is the gate for behaviour. `claude plugin validate .` validates the plugin and
marketplace manifests, nothing more.

ESM, Node 22 or newer, built-ins only, no runtime dependencies beyond the pinned `mcp-remote`
the hook installs. Every module in `lib/` takes its side effects (fs, exec, fetch, clock) as
injectable parameters and is unit tested without network access. The launcher test asserts the
security contract, that the key is written to a 0600 header file, never appears in argv, and is
stripped from the child environment.

| Path | Holds |
|---|---|
| `lib/` | The library modules - config, client, links, check, bulk, csv, cli |
| `bin/short-io` | The CLI entry point |
| `scripts/` | `run-mcp.mjs` (the bridge launcher), `install-deps.sh` (the SessionStart hook) and `bridge-smoke.mjs` (a release check that drives the bridge over stdio and calls a tool) |
| `hooks/hooks.json` | The SessionStart hook registration |
| `skills/` | The seven skills |
| `test/` | One test file per library module plus the launcher contract |
| `dev-docs/` | Tracked, dated, additive logs - the API audit, smoke records, the release checklist |
| `.claude-plugin/` | `plugin.json` and `marketplace.json` only |

`docs/` is gitignored and local only. Release steps are in
[dev-docs/release-checklist.md](dev-docs/release-checklist.md). The home of this plugin is
<https://github.com/juliandickie/short-io-plugin>.

## Licence

MIT. See [LICENSE](LICENSE).
