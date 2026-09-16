---
name: audit-links
description: Audit a short domain - list every link with the true total, check what one or many slugs really point at (configured destination, live hop, whether the domain has a 404 or a silent fallback), and reconcile a list of destinations against the account to find which already have short links. Use when the user says which slugs exist, is this link live, what does this slug point to, find the short link for, audit the domain, or reconcile this list.
argument-hint: "<domain> [check <slug...>] [reconcile <urls file>]"
---

# Audit a short domain

## Warning

On a domain with a default fallback configured, an unknown slug answers a redirect exactly
like a real one. Opening a short link in a browser, or reading its HTTP status, cannot tell a
working link from a typo. Only the configured record tells the truth, which is what `check`
reports first. Never grade a slug by opening it.

## 1 List every link

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io links go.example.com --json > links.json
```

Read the audit from the JSON. It carries `domain`, `id`, `count` (the true total Short.io holds
for the domain), `listed` (how many came back after filtering) and `links` (the records, each
with `path`, `originalURL`, `shortURL`, `title`, `tags`, `archived`, `idString`, `createdAt`).
The command pages to the end of the domain, so this is the whole domain, not a first page.

Archived links are filtered out by default, so the archived count is `count - listed`. Report
both numbers. Add `--include-archived` to keep them in, after which `listed` should equal
`count`.

`--csv` writes the same records as a flat file with the columns
`path,originalURL,shortURL,title,tags,archived,idString,createdAt` and no totals line, so use
it only when the user wants a spreadsheet.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io links go.example.com --csv > links.csv
```

With neither flag it prints the hostname, the true total, the number listed, and a path plus
destination table, with per-page progress on stderr.

## 2 Check a slug

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io check go.example.com/spring-sale
```

Five lines come back. The first is the `domain/slug` header, then four fields.

- `configured` - the destination Short.io holds for that slug, or `FREE (no link with this
  slug)`.
- `live` - the HTTP status from the short domain and the redirect target, if any.
- `fallback` - whether unknown slugs on this domain answer 404 or redirect somewhere, probed
  with one random unused slug.
- `verdict` - the summary.

| Verdict | Meaning |
|---|---|
| `ok` | A link exists and it behaves as configured. It always carries a `served` note saying how, `(served as a redirect)` on an ordinary link whose live hop matches the configured destination, and `(served as a cloaked)` or `(served as a password)` where the link answers 2xx with a page of its own instead of redirecting, which for those links is correct. |
| `free` | No link with that slug, and the domain 404s, so the slug is genuinely available. |
| `free-but-redirects` | No link with that slug, but the domain redirects anyway because of the fallback. The slug is still available; the redirect is the fallback, not a link. |
| `mismatch` | A link exists but the live hop goes somewhere other than the configured destination. |
| `not-resolving` | A link exists but the domain does not serve it. |

Add `--json` for the same result plus the link's `idString`, which the statistics tools need.
`https://go.example.com/spring-sale` works as the target as well as `go.example.com/spring-sale`.

For a handful of slugs, loop the command, one slug per call, and collect the verdicts into a
table.

Mind the budget. Every `check` spends an `expand` call from the link info and delete family,
which is limited to 20 per window, plus two live HTTP probes. Past roughly 20 slugs the loop
will start hitting the limit. For a list that long, read the domain once with `links --json`
and answer from the file, comparing each slug against the `path` field and each destination
against `originalURL`, then spend real `check` calls only on the slugs whose answer actually
matters, the ones that look wrong or that the user named.

## 3 Reconcile a list of destinations

Read the user's list of destination URLs. Match each one against the `originalURL` column of
`links.csv`, first exactly, then again with a trailing slash removed and the query string
stripped, and report the looser match as a near match rather than an exact one.

Report two lists, found (destination, slug, short URL) and missing (destination only), with
counts for both. Say which matches were exact and which were normalised, because a link whose
destination differs only by a UTM query string is a different link.

## 4 Hand the missing list on

Write the missing destinations to a CSV with the header `url,path,title,tags`, one row per
missing destination, and run the `bulk-links` skill over it. Leave `path` blank where the user
has not chosen a slug.
