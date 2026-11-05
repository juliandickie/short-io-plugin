---
name: link-stats
description: Click statistics for a short link or a whole domain over a period - totals, top countries, referrers, browsers, UTM campaigns, and top links, through the Short.io MCP statistics tools. Use when the user asks how many clicks, where the clicks came from, which links performed, or for a period report on a short domain.
argument-hint: "<domain or domain/slug> [--period 7d|30d|custom]"
---

# Link and domain statistics

Statistics live entirely on the hosted MCP tools. The CLI has no stats command and no
`--period` flag; the period in the argument hint describes the request, not a CLI argument.

With two or more accounts, the MCP tools serve only the account for this session's folder. If
`get-domains` does not list the domain, open a session in a folder of the account that owns it.

## Which tool for which question

| The question | Tool |
|---|---|
| How did this one link do | `link-statistics` |
| How did the whole domain do | `domain-statistics` |
| Where did the clicks come from, which campaign, which browser | `top-column-statistics` |
| How did it move over time | `top-by-interval-column` |
| The same breakdown but for one link only | `top-column-by-link-statistics` |

`top-column-statistics`, `top-by-interval-column` and `top-column-by-link-statistics` take a
column to group by. The useful ones are `country`, `referer`, `browser`, `os` and the UTM
columns such as `utm_campaign`, `utm_source` and `utm_medium`.

## Ids you need first

Every statistics tool takes the numeric `domainId`, never a hostname. Get it from the
`get-domains` tool, or from the CLI, which also names the account.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io domains
```

Per-link statistics also need the link's `idString`.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io check go.example.com/spring-sale --json
```

The `idString` field in that JSON is the one. `search-links` returns it too; its search
parameter is `q`, not `query`.

## Periods

Pass the period as ISO dates, a start and an end, rather than a relative phrase. Turn "last 7
days" into the two dates before you call, and state the dates you used in the report so the
numbers can be reproduced. Check the tool's own schema for the exact argument names before
the first call of a session, and send nothing outside it, because an unknown property answers
HTTP 500.

## Report shape

1. The period, as the two ISO dates, and the domain or link it covers.
2. Totals, total clicks and unique clicks where the tool returns both.
3. Top five per column that matters to the question, one line each, with the count and the
   share of total.
4. For a domain report, a table of the top links, slug, destination and clicks.
5. Anything that moved, if a time series was pulled.

Give each figure its own line rather than packing several into a sentence.

## Caveat to state in every report

Short.io counts raw clicks, bots included, unless the account has bot filtering switched on.
Say so in the report rather than presenting the number as verified human traffic. Check the
account's domain settings before claiming the number is filtered.

## Rate limit

The hosted MCP endpoint allows 30 requests per minute. A wide report, several columns across
several links, adds up quickly, so pull the domain-level breakdowns first and only go
per-link for the links the user actually asked about.
