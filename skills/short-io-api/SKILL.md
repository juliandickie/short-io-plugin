---
name: short-io-api
description: Reference for the Short.io REST endpoints the CLI uses, the hosted MCP server and its 14 tools with argument quirks, rate limits per endpoint family, error body shapes, the silent-dedupe behaviour of link creation, and the short-io CLI command table. Loaded when any skill or request needs an endpoint, a parameter, a tool name, or an exit code.
user-invocable: false
---

# Short.io API reference

Audited live against a real account on 16 September 2026. Base URL `https://api.short.io`.
The header is `authorization: <bare key>`. No header, or the key behind a `Bearer ` prefix,
both answer 401 `{"error":"Unauthorized"}`; the hosted MCP server answers the same mistake
with `Unauthorized: No API key provided`.

## Rate limits by endpoint family

Read from `x-ratelimit-limit`, with `x-ratelimit-remaining` and `x-ratelimit-reset` (seconds)
on every answer.

| Family | Limit | Endpoints |
|---|---|---|
| Listing | 1000 | `GET /api/domains`, `GET /api/links` |
| Link creation | 50 | `POST /links` |
| Link info and delete | 20 | `GET /links/expand`, `GET /links/:id`, `GET /links/multiple-by-url`, `DELETE /links/:id` |

The hosted MCP endpoint has its own budget, 30 requests per minute. That figure is not the
REST limit and the two do not share a counter.

## REST endpoints

| Endpoint | Answer and notes |
|---|---|
| `GET /api/domains` | 200, a JSON array. Per domain, `id` (number), `hostname`, `linkType` (`eight-char` or `random`), `redirect404` (null when unset), `state`. `GET /api/domains/:id` is not a route and answers 404. |
| `GET /api/links?domain_id=<number>&limit=<n>[&pageToken=<token>]` | 200 `{count, links[], nextPageToken}`. `domain_id` is required and numeric; sending `domain=<hostname>` answers 400 `must have required property domain_id`. `limit` maximum is 150, 151 answers 400. `count` is the true total on every page. `nextPageToken` is absent on the last page; pass it back as `pageToken`. |
| `GET /links/expand?domain=<hostname>&path=<slug>` | 200 with the record when the slug exists, 404 `{"error":"Link not found"}` when it is free or after a delete. Here `domain` is the hostname, not the id. This is the only endpoint that tells the truth about a slug. |
| `GET /links/multiple-by-url?domain=<hostname>&originalURL=<url-encoded>` | 200 `{links[]}`, every link on the domain whose destination matches exactly. This is the dedupe-by-destination check. Records also carry `slugSuggestions` and `tagSuggestions`. No `count`, no paging. |
| `GET /links/<idString>` | 200 with the record. |
| `POST /links` | Body `{domain, originalURL, path?, title?, tags?[]}`, `domain` is the hostname. See the create cases below. |
| `DELETE /links/<idString>` | 200 `{"success":true,"idString":...}`. A second delete answers 404. Expand after delete answers 404. |

Link record keys - `id, idString, path, displayPath, originalURL, shortURL, secureShortURL,
title, tags, archived, cloaking, hasPassword, skipQS, source, createdAt, updatedAt, DomainId,
OwnerId, User`.

## Create cases

| Case | Answer |
|---|---|
| New path | 200, the new record |
| Existing path, same `originalURL` | 200, the EXISTING record, no error, nothing created |
| Existing path, different `originalURL` | 409 `{"message":"Link already exists","statusCode":409,"success":false}` |
| No path, `originalURL` already shortened on the domain | 200, the EXISTING random-path record, nothing created |
| No path, new `originalURL` | 200, a new random path |
| `originalURL` not a URL | 400 `originalURL must pass "url" keyword validation` |
| Unknown domain | 404 `{"message":"Domain not found","statusCode":404,"success":false}` |

The API therefore dedupes silently on (path, destination) and on destination alone when no
path is given. Anything that treats a 200 as proof of creation over-counts. The CLI checks
`expand` first and compares `createdAt` against the request time, so a silently returned
existing record is reported as `exists`, never as `created`.

## Live redirect behaviour

On a domain with a default fallback configured, fetching `https://<domain>/<slug>` without
following redirects answers 302 to the fallback for an unknown slug AND for a real one. Some
domains serve a 200 page instead of redirecting, which hides a typo just as thoroughly. The
status code, and often the redirect target, cannot tell a working link from a typo. The CLI
`check` command reports the configured destination first, then the live answer, then probes
one random unused slug and names exactly what came back.

## Error body shapes

Three shapes appear and the client reads `message` first, then `error`.

1. `{"error": "..."}` - 401 on REST, 404 on expand and delete.
2. `{"message": "...", "statusCode": n, "success": false}` - 409, 400 validation, 404 domain.
3. Fastify validation - `{"statusCode", "code": "FST_ERR_VALIDATION", "error", "message"}`.

## Hosted MCP server

Endpoint `https://ai-assistant.short.io/mcp`, streamable HTTP, bare key in the header,
30 requests per minute. Fourteen tools, eleven purpose-built and three that reach the REST API
directly.

| Tool | What it does |
|---|---|
| `create-short-link` | Creates a link. No duplicate check of its own. |
| `edit-link` | Updates an existing link. |
| `get-link-list` | Lists links on a domain, paged. |
| `search-links` | Free text search across the account's links. |
| `get-domains` | Lists domains with their numeric ids and hostnames. |
| `update-domain-settings` | Changes settings on a domain. |
| `link-statistics` | Clicks and breakdowns for one link. |
| `domain-statistics` | Clicks and breakdowns for a whole domain. |
| `top-column-statistics` | Top values of one column over a period. |
| `top-by-interval-column` | A time series of one column over a period. |
| `top-column-by-link-statistics` | Top values of one column for a single link. |
| `list-api-endpoints` | Lists the REST endpoints the server can reach. Takes `service`, either `api` or `statistics`, and the optional `method`, `search` and `tag`. |
| `describe-api-endpoint` | The parameter schema for one endpoint. Takes `service`, `method`, `path`. |
| `call-api` | Executes any Short.io REST request as the user. Takes `service`, `method`, `path`, `query`, `body`. |

There is no dedicated delete tool, but `call-api` can delete, with `service` `api`, `method`
`DELETE` and `path` `links/<idString>`. It can reach every other endpoint too, bulk endpoints
included. The vendor's own MCP documentation claims both edit and delete are impossible; both
are in fact reachable, `edit-link` directly and delete through `call-api`.

A `call-api` write takes effect immediately and there is no dry run. Never repeat one after a
timeout or an ambiguous answer; check the current state first with `expand` or the CLI.

The CLI is still the better route for a delete inside a larger job, because it parses
`domain/slug` for you, resolves the `idString` itself, and refuses to act without `--yes`.

### Argument quirks

An unknown property answers HTTP 500, so send only documented arguments.

- `create-short-link` takes `domain` as a hostname string, plus `originalURL` and the
  optional `path`, `title`, `tags`, `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`,
  `utmContent`, `splitURL`, `splitPercent`, `androidURL`, `iphoneURL`, `expiresAt`,
  `clicksLimit`.
- Every read and statistics tool takes the numeric `domainId`, not a hostname.
- `call-api` takes the REST path without a leading slash, and `service` selects which API,
  `api` for links and domains, `statistics` for the stats endpoints. Run
  `list-api-endpoints` and then `describe-api-endpoint` before calling an endpoint you have
  not used, rather than guessing a parameter name.
- The search parameter on `search-links` is `q`, not `query`.
- `get-link-list` returns at most 150 links per call, carries the true total in `count`, and
  pages with `beforeDate` set to the oldest `createdAt` of the previous page.
- `splitURL` with `splitPercent` sets an A/B split; `expiresAt` and `clicksLimit` set the
  expiry conditions. None of these have CLI flags.

## CLI command table

Invoked as `${CLAUDE_PLUGIN_ROOT}/bin/short-io <command>`.

| Command | What it prints |
|---|---|
| `whoami [--json]` | per account - key source, folders, domains, link counts. Then the default account and the account this folder's MCP tools use |
| `domains [--json]` | id, hostname, type, redirect404 per domain, with an account column when the file has named accounts |
| `links <domain\|id> [--json\|--csv] [--include-archived]` | every link, paged to the end |
| `check <domain/slug \| https://host/slug> [--json]` | configured target, live hop, fallback probe, verdict |
| `create <domain> <url> [--path s] [--title t] [--tags a,b] [--allow-duplicate] [--json]` | the action and the link |
| `bulk create <file.csv\|file.json> --domain <d> [--yes] [--allow-duplicate] [--out results.csv]` | a dry-run table, or counts plus a results CSV |
| `delete <domain/slug> --yes [--json]` | the deleted slug |

Every command takes `--account <name>`. Without it, `links`, `check`, `create`, `bulk create`
and `delete` use the account that owns the domain, trying the folder's account, then the
default, then the rest of the file. Each account tried costs one listing call. With one account
`check` and `delete` make no lookup. An API error or a key failure while searching stops the
command and never moves on to the next account.

`whoami --json` keeps `key_source`, `config_path`, `data_dir` and `domains`, describing this
folder's account or the `--account` one, and adds `default`, `folder`, `folder_account` and
`accounts: [{ name, key_source, folders, domains, error }]`. `domains --json` adds `account` to
each domain object, and a failing account is a row of `{ account, error }`. Both commands
report every account and exit 1 if any failed.

Exit codes - 0 ok, 1 API or network error, 2 configuration or usage. `create` additionally
returns 0 for the actions `created` and `exists`, and 1 for `taken`, `duplicate` and
`invalid`. `bulk create` returns 1 when any row failed.

`check` verdicts - six of them, `ok`, `free`, `free-but-redirects`, `free-but-served`,
`mismatch`, `not-resolving`. An `ok` verdict may carry a `served` note of `redirect`,
`cloaked` or `password`, because cloaked and password-protected links answer 2xx with a page
of their own instead of redirecting. With no record behind the slug, a live redirect reads as
`free-but-redirects`, a live 2xx as `free-but-served`, and a 404, any other status, or a
failed probe as plain `free`.

The fallback probe reports a `kind` of `notfound`, `redirect`, `page`, `other` or `error`,
and `hasFallback` is true for `redirect` and `page` alike - a domain that answers a page for
an unknown slug has no 404 either, so a typo fails just as silently there.

`bulk create` result CSV columns - `row,url,path,action,short_url,id,note`.

## Other Short.io tooling

The official `shortio` CLI, published by the vendor, covers surfaces this plugin does not,
including QR code generation, geo and device targeting rules, and archiving. Reach for it
when a request needs one of those.

`@short.io/client-node` is the vendor's Node client, licensed under the Functional Source
License. Check the licence terms before depending on it in anything distributed.

The vendor also publishes a single-skill Claude Code plugin in the `Short-io/shortcm-cli`
repository. It wraps their CLI rather than the REST API and does not overlap with this
plugin's gap commands.
