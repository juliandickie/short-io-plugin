# Changelog

## 0.2.2 - 2026-11-09

Changed - the settings error now says to unset a shell variable first, then to reinstall for the
plugin settings field. The CLI never sees that field, so a CLI user's variable always comes from
their shell.

## 0.2.1 - 2026-11-08

Fixed - the setup steps said to clear the plugin settings fields in `/plugin manage`, but Claude
Code keeps a sensitive field that is saved blank, so the API key field never cleared and the MCP
bridge kept refusing beside named accounts. The setup skill, the README and the error message
now say to reinstall the plugin with `--keep-data`, which is the step that cleared it, and to
check with `claude plugin configure short-io@<marketplace>`.

## 0.2.0 - 2026-11-05

Multi-account support, for anyone with more than one Short.io account. One-key setups keep
working with no change.

Added - named accounts in the config file (`[accounts.<name>]`, with `api_key` or `op_ref`, and
an optional `folders`), plus a `default`. The MCP bridge uses the account for the session's
folder, else the default, and names it on stderr. CLI commands that take a domain use the
account that owns it. `--account <name>` on every command. `whoami` and `domains` report every
account, and their JSON is additive.

Errors, each naming the fix - a key in the settings field or environment beside named accounts,
a top-level key beside sections, a `default` that names nothing, a section with no key, a folder
under two accounts, a repeated section or key, an unreadable `folders` value, a folder that is
not a full path, any section header other than `[accounts.<name>]` beside named accounts or
one that looks like an account in a one-key file, and (bridge only) no default with no matching
folder.

Fixed - the config parser merged every `[section]` into the top level, so the last `api_key` in
a file silently won. Keys now belong to their section. In a one-key file, any other section is
skipped with a warning.

Fixed - `create` and `bulk create` stopped with `links/multiple-by-url: No links found` for any
destination with no link on that domain yet, which is the normal case. The API answers 404
there, and the client treated it as an error. This was present since 0.1.0.

Changed - if you had keys under another `[section]` of the config file, they are now ignored.
Move them to the top level or into an account.

## 0.1.0 - 2026-09-16

First release. MCP bridge to Short.io's hosted server (14 tools) with four key methods (plugin
field, env, 0600 config file, 1Password reference). CLI - whoami, domains, links (full paging),
check (configured target, live hop, fallback probe), create (dedupe by slug and destination),
bulk create (dry run, --yes, results CSV), delete (--yes, read-back). Seven skills. Live API
audit recorded in dev-docs.
