import { parseArgs } from 'node:util';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKey as defaultResolveKey, loadAccounts as defaultLoadAccounts, routingOrder, ConfigError, dataDir, configPath } from './config.mjs';
import { ShortIoClient, ShortIoError } from './client.mjs';
import { parseTarget, resolveDomain, matchDomain, listDomainNames, listAllLinks, createOne, deleteBySlug } from './links.mjs';
import { checkSlug, kindOf } from './check.mjs';
import { loadSpecs, planBulk, runBulk, RESULT_COLUMNS } from './bulk.mjs';
import { toCsv } from './csv.mjs';

export const LINK_COLUMNS = ['path', 'originalURL', 'shortURL', 'title', 'tags', 'archived', 'idString', 'createdAt'];
const STRING_FLAGS = ['domain', 'path', 'title', 'tags', 'out', 'account'];
const BOOL_FLAGS = ['json', 'csv', 'yes', 'allow-duplicate', 'include-archived', 'help'];

export function usage() {
  return [
    'short-io - Short.io gap CLI (the hosted MCP tools cover create, edit, search and stats)',
    '',
    '  short-io whoami [--json]                         key source, domains, link counts',
    '  short-io domains [--json]',
    '  short-io links <domain|id> [--json|--csv] [--include-archived]   every link, paged to the end',
    '  short-io check <domain/slug | https://host/slug> [--json]        configured target, live hop, fallback probe',
    '  short-io create <domain> <url> [--path s] [--title t] [--tags a,b] [--allow-duplicate] [--json]',
    '  short-io bulk create <file.csv|file.json> --domain <d> [--yes] [--allow-duplicate] [--out results.csv]',
    '  short-io delete <domain/slug> --yes [--json]',
    '',
    'Every command takes --account <name>. Without it, a command that names a domain uses the account that owns the domain.',
    '',
    'Exit codes - 0 ok, 1 API or network error, 2 configuration or usage.',
    'Key - SHORT_IO_API_KEY or the plugin config field, then ~/.config/short-io-plugin/config.toml, then a 1Password op:// reference. See /short-io:setup.',
    'More than one account - [accounts.<name>] sections in that file, and the two environment routes must be empty. See /short-io:setup.',
  ].join('\n');
}

function parse(argv) {
  const options = {};
  for (const f of STRING_FLAGS) options[f] = { type: 'string' };
  for (const f of BOOL_FLAGS) options[f] = { type: 'boolean' };
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  return { flags: values, positionals };
}

// Every writer returns undefined on purpose - run() reads a command's return value as the exit
// code, and stdout.write answers true (or, on a collecting test stream, a number).
const emitJson = (ctx, obj) => { ctx.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); };
const table = (rows) => rows.map((r) => r.map((c, i) => String(c).padEnd(i === r.length - 1 ? 0 : 14)).join(' ')).join('\n');

const warnTo = (ctx) => (m) => ctx.stderr.write(`short-io: ${m}\n`);

async function loadModel(ctx, flags) {
  const model = await ctx.loadAccounts({ env: ctx.env, homedir: ctx.homedir, cwd: ctx.cwd, warn: warnTo(ctx) });
  if (flags.account !== undefined && !model.accounts.some((a) => a.name === flags.account)) throw new ShortIoError('usage', `No account "${flags.account}". Accounts: ${model.accounts.map((a) => a.name).join(', ')}`);
  return model;
}

async function openAccount(ctx, model, account) {
  const resolved = await ctx.resolveKey({ env: ctx.env, homedir: ctx.homedir, warn: warnTo(ctx), file: model.file, account });
  if (!resolved.key) throw new ConfigError(`no API key configured (checked env, plugin config, ${resolved.configPath ?? 'the config file'}, 1Password). Run /short-io:setup`);
  return { client: ctx.makeClient({ key: resolved.key, fetch: ctx.fetch, sleep: ctx.sleep }), source: resolved.source };
}

// With two or more accounts, every error says which one it came from. The single-key account
// keeps the messages 0.1.0 wrote.
async function inAccount(model, account, fn) {
  try { return await fn(); } catch (error) {
    if (model.named && error?.message) error.message = `account "${account.name}": ${error.message}`;
    throw error;
  }
}

// Finds the account for a command that names a domain. Any error while searching stops the
// command, because moving on to the next account could create the link in the wrong one. check
// and delete name a hostname already, so with one account they need no lookup and a slug on a
// domain outside the account can still be checked.
async function route(ctx, flags, target, { lookupWithOneAccount = true } = {}) {
  const model = await loadModel(ctx, flags);
  const only = flags.account !== undefined ? model.accounts.find((a) => a.name === flags.account) : model.accounts.length === 1 ? model.accounts[0] : null;
  if (only) {
    return inAccount(model, only, async () => {
      const { client } = await openAccount(ctx, model, only);
      if (model.accounts.length === 1 && !lookupWithOneAccount) return { client, domain: { hostname: target } };
      return { client, domain: await resolveDomain(client, target) };
    });
  }
  const searched = [];
  for (const account of routingOrder(model)) {
    const found = await inAccount(model, account, async () => {
      const { client } = await openAccount(ctx, model, account);
      const domains = await client.listDomains();
      return { client, domains, domain: matchDomain(domains, target) };
    });
    if (found.domain) return found;
    searched.push(`${account.name} - ${listDomainNames(found.domains)}`);
  }
  throw new ShortIoError('usage', `No account owns domain "${target}". Accounts: ${searched.join('; ')}`);
}

async function cmdWhoami(ctx, flags) {
  const model = await loadModel(ctx, flags);
  const { client, source } = await openAccount(ctx, model, model.accounts[0]);
  const domains = await client.listDomains();
  const rows = [];
  for (const d of domains) {
    const page = await client.listLinks({ domainId: d.id, limit: 1 });
    rows.push({ id: d.id, hostname: d.hostname, linkType: d.linkType, links: page.count ?? null });
  }
  const file = configPath({ env: ctx.env, homedir: ctx.homedir });
  const out = { key_source: source, config_path: file, data_dir: dataDir({ env: ctx.env, homedir: ctx.homedir }), domains: rows };
  if (flags.json) { emitJson(ctx, out); return; }
  ctx.stdout.write(`key source: ${source}\nconfig path: ${file}\n${table([['id', 'hostname', 'type', 'links'], ...rows.map((r) => [r.id, r.hostname, r.linkType, r.links ?? '?'])])}\n`);
}

async function cmdDomains(ctx, flags) {
  const model = await loadModel(ctx, flags);
  const { client } = await openAccount(ctx, model, model.accounts[0]);
  const domains = await client.listDomains();
  if (flags.json) { emitJson(ctx, domains); return; }
  ctx.stdout.write(`${table([['id', 'hostname', 'type', 'redirect404'], ...domains.map((d) => [d.id, d.hostname, d.linkType, d.redirect404 ?? '-'])])}\n`);
}

async function cmdLinks(ctx, flags, [target]) {
  if (!target) throw new ShortIoError('usage', 'links needs a domain hostname or id');
  const { client, domain } = await route(ctx, flags, target);
  const { count, links } = await listAllLinks(client, domain.id, { onPage: (p) => { if (!flags.json && !flags.csv) ctx.stderr.write(`short-io: fetched ${p.links?.length ?? 0} (of ${p.count})\n`); } });
  const kept = flags['include-archived'] ? links : links.filter((l) => !l.archived);
  const rows = kept.map((l) => ({ ...l, tags: Array.isArray(l.tags) ? l.tags.join(',') : (l.tags ?? '') }));
  if (flags.json) { emitJson(ctx, { domain: domain.hostname, id: domain.id, count, listed: rows.length, links: rows }); return; }
  if (flags.csv) { ctx.stdout.write(toCsv(LINK_COLUMNS, rows)); return; }
  ctx.stdout.write(`${domain.hostname} - ${count} links (${rows.length} listed)\n${table([['path', 'originalURL'], ...rows.map((l) => [l.path, l.originalURL])])}\n`);
}

const errorNote = (probe) => (probe.error ? ` (error: ${probe.error})` : '');

// Only a 404 proves the domain refuses unknown slugs. A probe that never reached the server
// says nothing about the domain's 404 behaviour, and a 2xx page is as silent a failure as a
// redirect, so each kind is spelled out rather than collapsed into "answers 404".
const NO_404 = '(no 404 on this domain, a typo fails silently)';
function fallbackText(fallback) {
  const kind = fallback.kind ?? kindOf(fallback.status);
  if (kind === 'redirect') return `unknown slugs redirect to ${fallback.location} ${NO_404}`;
  if (kind === 'page') return `unknown slugs answer HTTP 200 with a page ${NO_404}`;
  if (kind === 'error') return 'could not probe this domain';
  if (kind === 'other') return `unknown slugs answer HTTP ${fallback.status}`;
  return 'unknown slugs answer 404';
}

const VERDICT_NOTES = {
  ok: '',
  free: '',
  'free-but-redirects': '',
  'free-but-served': ' - no link with this slug, but the domain serves a page for it',
  mismatch: ' - the live hop does not match the configured destination',
  'not-resolving': ' - configured but the domain does not serve it',
};

async function cmdCheck(ctx, flags, [target]) {
  const t = parseTarget(target, flags.domain);
  const { client, domain } = await route(ctx, flags, t.domain, { lookupWithOneAccount: false });
  const out = await checkSlug(client, { domain: domain.hostname, path: t.path }, { fetch: ctx.fetch, random: ctx.random });
  if (flags.json) { emitJson(ctx, out); return; }
  const lines = [
    `${out.domain}/${out.path}`,
    `  configured: ${out.configured ?? 'FREE (no link with this slug)'}`,
    `  live:       HTTP ${out.live.status}${out.live.location ? ` -> ${out.live.location}` : ''}${errorNote(out.live)}`,
    `  fallback:   ${fallbackText(out.fallback)}${errorNote(out.fallback)}`,
    `  verdict:    ${out.verdict}${out.served ? ` (served as a ${out.served})` : ''}${VERDICT_NOTES[out.verdict] ?? ''}`,
  ];
  ctx.stdout.write(`${lines.join('\n')}\n`);
}

function createLine(out, target) {
  const where = out.link?.shortURL ?? (out.link?.path ? `${target.domain}/${out.link.path}` : target.slug);
  if (out.action === 'exists') return `exists - ${where} already points at ${out.link?.originalURL ?? target.url}`;
  if (out.action === 'taken') return `taken - ${where} points at ${out.link?.originalURL ?? 'a different destination'}`;
  if (out.action === 'duplicate') return `duplicate - ${target.url} is already shortened as ${where} (pass --allow-duplicate to create anyway)`;
  return `${out.action}${out.reason ? ` - ${out.reason}` : ''}`;
}

async function cmdCreate(ctx, flags, [domain, url]) {
  if (!domain || !url) throw new ShortIoError('usage', 'create needs <domain> <url>');
  const { client, domain: d } = await route(ctx, flags, domain);
  const out = await createOne(client, { domain: d.hostname, originalURL: url, path: flags.path, title: flags.title, tags: flags.tags }, { allowDuplicate: flags['allow-duplicate'] });
  const target = { domain: d.hostname, url, slug: flags.path ? `${d.hostname}/${flags.path}` : d.hostname };
  if (flags.json) emitJson(ctx, out);
  else if (out.action === 'created') ctx.stdout.write(`created ${out.link.shortURL} -> ${url}\n`);
  else ctx.stderr.write(`short-io: ${createLine(out, target)}\n`);
  return out.action === 'created' || out.action === 'exists' ? 0 : 1;
}

async function cmdBulkCreate(ctx, flags, [file]) {
  if (!file) throw new ShortIoError('usage', 'bulk create needs a CSV or JSON file');
  if (!flags.domain) throw new ShortIoError('usage', 'bulk create needs --domain');
  let text;
  try { text = await ctx.readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new ShortIoError('usage', `cannot read ${file} - no such file`);
    throw new ShortIoError('usage', `cannot read ${file}: ${error?.message ?? error}`);
  }
  const specs = loadSpecs(text, { format: file.toLowerCase().endsWith('.json') ? 'json' : 'csv' });
  const { client, domain: d } = await route(ctx, flags, flags.domain);
  const plan = await planBulk(client, specs, { domain: d.hostname });
  if (!flags.yes) {
    if (flags.json) {
      emitJson(ctx, {
        domain: d.hostname,
        dry_run: true,
        rows: specs.length,
        counts: plan.counts,
        items: plan.items.map((i) => ({
          row: i.row,
          action: i.action,
          path: i.path,
          url: i.url,
          duplicateOf: i.duplicateOf,
          existing: i.existing ? { path: i.existing.path ?? null, shortURL: i.existing.shortURL ?? null, originalURL: i.existing.originalURL ?? null, idString: i.existing.idString ?? null } : null,
          reason: i.reason,
        })),
      });
      return 0;
    }
    const countLines = Object.entries(plan.counts).map(([k, v]) => `  ${k.padEnd(18)}${v}`).join('\n');
    ctx.stdout.write(`Dry run for ${d.hostname} - ${specs.length} rows\n${countLines}\n\n${table([['row', 'action', 'path', 'url'], ...plan.items.map((i) => [i.row, i.action, i.path || '(random)', i.url])])}\n\nNothing created. Re-run with --yes to create the "create" rows${plan.counts.duplicate ? ' (and --allow-duplicate for the duplicate rows)' : ''}.\n`);
    return 0;
  }
  const outFile = flags.out ?? `${file.replace(/\.(csv|json)$/i, '')}-results.csv`;
  const result = await runBulk(client, plan, { domain: d.hostname, allowDuplicate: flags['allow-duplicate'], sleep: ctx.sleep, onItem: (r) => { if (!flags.json) ctx.stderr.write(`short-io: ${r.action} ${r.path || r.short_url || r.url}\n`); } });
  const countLines = Object.entries(result.counts).map(([k, v]) => `  ${k.padEnd(10)}${v}`).join('\n');
  try { await ctx.writeFile(outFile, toCsv(RESULT_COLUMNS, result.results)); }
  catch (error) {
    // The links are already created, so the counts are the only record the user has left.
    ctx.stderr.write(`${countLines}\n`);
    throw new ShortIoError('unknown', `cannot write ${outFile}: ${error?.message ?? error}`);
  }
  if (flags.json) emitJson(ctx, { ...result, results_file: outFile });
  else ctx.stdout.write(`${countLines}\nresults: ${outFile}\n`);
  return result.counts.failed ? 1 : 0;
}

async function cmdDelete(ctx, flags, [target]) {
  const t = parseTarget(target, flags.domain);
  if (!flags.yes) throw new ShortIoError('usage', `delete is permanent - re-run with --yes to delete ${t.domain}/${t.path}`);
  const { client, domain } = await route(ctx, flags, t.domain, { lookupWithOneAccount: false });
  const out = await deleteBySlug(client, domain.hostname, t.path);
  if (flags.json) { emitJson(ctx, out); return; }
  ctx.stdout.write(`deleted ${domain.hostname}/${t.path} (${out.deleted})\n`);
}

export async function run(argv, ctx = {}) {
  const c = {
    env: process.env, stdout: process.stdout, stderr: process.stderr, loadAccounts: defaultLoadAccounts, resolveKey: defaultResolveKey, fetch: globalThis.fetch, readFile: fsReadFile, writeFile: fsWriteFile,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), makeClient: (o) => new ShortIoClient(o), homedir: undefined, cwd: undefined, random: undefined, ...ctx,
  };
  let flags; let positionals;
  try { ({ flags, positionals } = parse(argv)); } catch (e) { c.stderr.write(`short-io: ${e.message}\n${usage()}\n`); return 2; }
  const [cmd, ...rest] = positionals;
  if (!cmd || cmd === 'help' || flags.help) { c.stdout.write(`${usage()}\n`); return 0; }
  try {
    let code;
    if (cmd === 'whoami') code = await cmdWhoami(c, flags);
    else if (cmd === 'domains') code = await cmdDomains(c, flags);
    else if (cmd === 'links') code = await cmdLinks(c, flags, rest);
    else if (cmd === 'check') code = await cmdCheck(c, flags, rest);
    else if (cmd === 'create') code = await cmdCreate(c, flags, rest);
    else if (cmd === 'bulk' && rest[0] === 'create') code = await cmdBulkCreate(c, flags, rest.slice(1));
    else if (cmd === 'delete') code = await cmdDelete(c, flags, rest);
    else { c.stderr.write(`short-io: Unknown command "${[cmd, ...rest].join(' ')}"\n${usage()}\n`); return 2; }
    return code ?? 0;
  } catch (error) {
    if (error instanceof ConfigError || error?.code === 'config' || error?.code === 'usage') { c.stderr.write(`short-io: ${error.message}\n`); return 2; }
    if (error instanceof ShortIoError) { c.stderr.write(`short-io: ${error.message}\n`); return 1; }
    c.stderr.write(`short-io: ${error?.message ?? String(error)}\n${c.env?.SHORT_IO_DEBUG && error?.stack ? `${error.stack}\n` : ''}`); return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
