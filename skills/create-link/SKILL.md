---
name: create-link
description: Create one short link with duplicate checks - refuse a taken slug, report an existing link with the same destination, add title, tags and UTM fields, then verify the configured destination. Use when the user says shorten this, make a short link, give me a slug for, create a vanity link, or add UTMs to a link.
argument-hint: "<domain> <url> [--path slug] [--title t] [--tags a,b]"
---

# Create one short link

The CLI goes first because it checks for duplicates before it posts. The hosted MCP
`create-short-link` tool does not check anything, and the API answers 200 with an existing
record rather than an error, so an MCP-first create can silently report an old link as new.

## 1 Confirm the domain

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io domains
```

Take the hostname for the create call and note the numeric id in case stats come next.

## 2 Create

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io create go.example.com https://example.com/spring-sale --path spring-sale --title "Spring sale" --tags campaign,spring --json
```

Every flag after the URL is optional. Without `--path`, the domain generates a random slug.

## 3 Read the action

The `action` field in the JSON is the whole answer. Exit code 0 covers `created` and
`exists`; every other action exits 1.

| Action | What it means | What to do |
|---|---|---|
| `created` | A new link exists | Report the `shortURL` |
| `exists` | The slug was already there, pointing at this exact destination | Report it as already existing, do not claim a create |
| `taken` | The slug is held by a different destination | Propose another slug, never overwrite |
| `duplicate` | This destination already has a short link on the domain | Show the existing slug and ask whether a second one is really wanted, then re-run with `--allow-duplicate` |
| `invalid` | The URL is not an http or https URL | Fix the URL and re-run |

## 4 UTM and A and B fields

The CLI does not carry UTM, split-test, device or expiry flags in v0.1. When the user wants
any of those, confirm the slug is available first with `check` (a verdict of `free` or
`free-but-redirects` means nothing holds it), then make the link with the hosted
`create-short-link` tool, passing `domain` as the hostname plus `originalURL`,
`path`, `title`, `tags`, and whichever of `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`,
`utmContent`, `splitURL`, `splitPercent`, `androidURL`, `iphoneURL`, `expiresAt`,
`clicksLimit` apply. Send nothing else; an unknown property answers HTTP 500.

## 5 Verify

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io check go.example.com/spring-sale
```

Read the `configured` line, not the live status. A verdict of `ok` means the live hop matches
the configured destination. On a domain with a fallback, an unknown slug also answers a
redirect, so the HTTP status alone proves nothing.

## Slug rules

Lowercase, hyphens between words, no spaces, no underscores. Keep it under 30 characters.
Make it readable out loud. Never reuse a slug that ever pointed somewhere else, because old
links in the wild will land on the new destination.
