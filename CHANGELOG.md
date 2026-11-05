# Changelog

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
not a full path, and (bridge only) no default with no matching folder.

Fixed - the config parser merged every `[section]` into the top level, so the last `api_key` in
a file silently won. Keys now belong to their section, and any section other than
`[accounts.<name>]` is skipped with a warning.

Changed - if you had keys under another `[section]` of the config file, they are now ignored.
Move them to the top level or into an account.

## 0.1.0 - 2026-09-16

First release. MCP bridge to Short.io's hosted server (14 tools) with four key methods (plugin
field, env, 0600 config file, 1Password reference). CLI - whoami, domains, links (full paging),
check (configured target, live hop, fallback probe), create (dedupe by slug and destination),
bulk create (dry run, --yes, results CSV), delete (--yes, read-back). Seven skills. Live API
audit recorded in dev-docs.
