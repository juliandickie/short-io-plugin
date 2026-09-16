---
name: bulk-links
description: Create many short links from a CSV or JSON file unattended - dry-run scope table first, then create with dedupe by slug and by destination, paced under the rate limit, with a results CSV and counts. Use when the user says bulk, batch, create all of these, the whole spreadsheet, or the link list.
disable-model-invocation: true
argument-hint: "<file.csv|file.json> --domain <d> [--yes] [--allow-duplicate]"
---

# Bulk link creation

## Input format

A CSV with the header `url,path,title,tags`. Only `url` is required; leave `path` blank to let
the domain generate a random slug. Multiple tags go comma-separated inside one quoted cell.

```
url,path,title,tags
https://example.com/spring-sale,spring-sale,Spring sale landing page,"campaign,spring"
https://example.com/guide.pdf,guide,Buyer guide PDF,"resource"
```

`bulk-template.csv` in this skill folder is that file, ready to copy.

JSON input works too, an array of `{url, path, title, tags}` objects, chosen by a `.json`
file extension.

## 1 Dry run

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io bulk create links.csv --domain go.example.com
```

Without `--yes` nothing is created. It prints the row count, a count per action, and a table
of every row with its action, path and url, then a line saying nothing was created.

The actions are `create` (will be made), `exists` (that slug already points at that exact
destination), `taken` (that slug points somewhere else), `duplicate` (that destination already
has a short link on the domain), `duplicate-in-file` (an earlier row in the same file claims
that slug or destination), and `invalid` (not an http or https URL).

Add `--json` for the same plan as structured data, with `rows`, `counts` and an `items` array
carrying `row`, `action`, `path`, `url`, `duplicateOf`, `existing` and `reason`.

## 2 Show the scope and wait

Put the scope table in front of the user verbatim, counts first. Do not run the create until
they say go. If the counts include `duplicate` rows the user wants made anyway, that go has to
cover `--allow-duplicate` explicitly.

## 3 Create

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io bulk create links.csv --domain go.example.com --yes
```

Add `--allow-duplicate` only when the user approved the duplicate rows. Add `--out
results.csv` to choose the results path; the default is the input filename with `-results.csv`
appended. Creates are paced apart so the run stays under the link creation rate limit.

## 4 Report the counts

The run prints `created`, `skipped` and `failed`, then the results file path. The results CSV
has the columns `row,url,path,action,short_url,id,note`.

Read that file and report the three counts, then every failed row with its note. Notes worth
translating for the user.

| Note | Meaning |
|---|---|
| `API returned the existing record` | The slug was already there with that destination |
| `API returned an existing record for this destination` | The API deduped silently, nothing was created |
| `slug held by a different destination` | The slug is taken, pick another |
| `the API rejected this row as invalid` | Bad destination URL |
| `duplicate of row N in this file` | The input file repeats itself |
| Anything starting with an error code | The row failed, it is in the `failed` count |

The command exits 1 if any row failed, 0 otherwise.

## 5 Spot-check

```bash
${CLAUDE_PLUGIN_ROOT}/bin/short-io check go.example.com/spring-sale
```

Check two of the created slugs and confirm the verdict is `ok`.

## Rule

Never say the bulk run is done without the counts line. A skipped row is not a created row,
and the `API returned an existing record for this destination` note means the API deduped
behind the plugin's back, so the user has fewer new links than rows.
