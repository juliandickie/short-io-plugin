---
name: short-io
description: Overview and router for the Short.io plugin. Use when the user mentions Short.io, short links, a branded short domain, a slug, a vanity link, UTM-tagged links, bulk link creation, or link click stats. Explains the two ways in (hosted MCP tools for create, edit, search and statistics; the short-io CLI for full enumeration, destination checks, bulk with dedupe, and delete), the id rules, and the quirks.
argument-hint: ""
---

# Short.io

Short.io link management under the user's own API key. Two surfaces share that one key, the
hosted MCP server and this plugin's CLI. Set the key up once with the `setup` skill, then use
whichever surface the job needs.

## Two ways in

The hosted MCP tools are the first choice for conversational, single-link work and for every
statistic. They create a link, edit one, search for one, list domains, and answer every click
question. They run over `https://ai-assistant.short.io/mcp`, 30 requests per minute.

The CLI is the gap filler. Use it whenever the job needs every link on a domain, the truth about
what a slug really points at, a file on disk, duplicate detection before creating, or a delete.
It talks to the REST API directly and is invoked as
`${CLAUDE_PLUGIN_ROOT}/bin/short-io <command>`.

| Job | Surface |
|---|---|
| Create one link, conversationally, with UTM or A/B fields | MCP `create-short-link` |
| Create one link with a duplicate check first | CLI `create` |
| Edit an existing link | MCP `edit-link` |
| Find a link by a word in its title, slug or destination | MCP `search-links` (param is `q`) |
| Every link on a domain, with the true total | CLI `links` |
| What does this slug actually point at | CLI `check` |
| Many links from a CSV or JSON file | CLI `bulk create` |
| Delete a link | CLI `delete` (the MCP server has no delete tool) |
| Clicks, countries, referrers, campaigns | MCP statistics tools |

## Which skill

| The user asks | Skill |
|---|---|
| Set up the key, first run, key is not working | `setup` |
| Shorten this, make a short link, add UTMs, give me a slug | `create-link` |
| Bulk, batch, the whole spreadsheet, this list of links | `bulk-links` |
| Which slugs exist, is this live, what does this point at, reconcile this list | `audit-links` |
| How many clicks, where from, which links performed, a period report | `link-stats` |
| An endpoint, a parameter, a tool name, an exit code | `short-io-api` |

## Ids

Short.io identifies a domain two ways and the surfaces disagree about which they want.
`create-short-link` and the REST API take `domain` as a hostname string, for example
`go.example.com`. `get-link-list` and every statistics tool take the numeric `domainId`.
A link is identified by its `idString`, not its slug.

`${CLAUDE_PLUGIN_ROOT}/bin/short-io domains` prints both the numeric id and the hostname for
every domain on the account, so run it once and carry both.

## Quirks

The search parameter on `search-links` is `q`, not `query`. Any unknown property sent to a
hosted MCP tool answers HTTP 500, so send only the documented arguments.

`get-link-list` returns at most 150 links per call and pages by `beforeDate`, which you set to
the oldest `createdAt` of the previous page; the `count` field carries the true total.

On a domain with a default fallback configured, an unknown slug answers a redirect exactly like
a real one, so a 200 or a 302 from the short domain proves nothing. Only `expand`, which the CLI
`check` command uses, tells the truth.

`POST /links` dedupes silently. Repeat a destination and the API answers 200 with the existing
record rather than creating anything, so a script that counts 200s over-counts. The CLI
distinguishes `created` from `exists`, `taken`, `duplicate` and `invalid` for exactly this reason.

## Never

Never paste the API key into chat, a commit, or a file the user did not ask for.

Never read a slug's health from its HTTP status. Use `check` and read the configured destination.

Never claim a bulk run finished without quoting the counts line and the results CSV path.
