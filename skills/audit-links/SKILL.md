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
${CLAUDE_PLUGIN_ROOT}/bin/short-io links go.example.com --csv > links.csv
```

The CSV columns are `path,originalURL,shortURL,title,tags,archived,idString,createdAt`. It
pages to the end of the domain, so the file is the whole account for that domain, not a first
page. Archived links are left out by default; add `--include-archived` to keep them, and
report the difference between the true total the command prints and the number of rows listed
as the archived count.

Without `--csv` it prints the hostname, the true total, the number listed, and a path plus
destination table. `--json` gives the same data structured, with `count`, `listed` and `links`.

## 2 Check a slug

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io check go.example.com/spring-sale
```

Four lines come back.

- `configured` - the destination Short.io holds for that slug, or `FREE (no link with this
  slug)`.
- `live` - the HTTP status from the short domain and the redirect target, if any.
- `fallback` - whether unknown slugs on this domain answer 404 or redirect somewhere, probed
  with one random unused slug.
- `verdict` - the summary.

| Verdict | Meaning |
|---|---|
| `ok` | A link exists and the live hop matches the configured destination. It may add a note like `(served as a cloaked)` or `(served as a password)` where the link serves its own page instead of redirecting, which is correct behaviour. |
| `free` | No link with that slug, and the domain 404s, so the slug is genuinely available. |
| `free-but-redirects` | No link with that slug, but the domain redirects anyway because of the fallback. The slug is still available; the redirect is the fallback, not a link. |
| `mismatch` | A link exists but the live hop goes somewhere other than the configured destination. |
| `not-resolving` | A link exists but the domain does not serve it. |

Add `--json` for the same result plus the link's `idString`, which the statistics tools need.
`https://go.example.com/spring-sale` works as the target as well as `go.example.com/spring-sale`.

For many slugs, loop the command, one slug per call, and collect the verdicts into a table.

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
