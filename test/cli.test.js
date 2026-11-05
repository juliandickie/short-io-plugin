import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, usage } from '../lib/cli.mjs';
import { loadAccounts, resolveKey } from '../lib/config.mjs';
import { ShortIoError } from '../lib/client.mjs';

const DOMAINS = [{ id: 12345, hostname: 'go.example.com', linkType: 'eight-char', redirect404: null }];
function ctx(over = {}) {
  const out = []; const err = []; const files = {};
  const client = {
    listDomains: async () => DOMAINS,
    listLinks: async ({ pageToken }) => (pageToken ? { count: 2, links: [{ path: 'b', originalURL: 'https://example.com/b', idString: 'l2', shortURL: 'https://go.example.com/b', archived: false }] } : { count: 2, links: [{ path: 'a', originalURL: 'https://example.com/a', idString: 'l1', shortURL: 'https://go.example.com/a', archived: false }], nextPageToken: 'p2' }),
    expand: async (d, p) => (p === 'a' ? { idString: 'l1', originalURL: 'https://example.com/a' } : null),
    linksByUrl: async () => [],
    createLink: async (b) => ({ idString: 'l3', path: b.path, shortURL: `https://go.example.com/${b.path}`, createdAt: new Date().toISOString() }),
    deleteLink: async () => ({ success: true }),
    ...over.client,
  };
  return {
    c: {
      env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
      loadAccounts: async () => ({ named: false, accounts: [{ name: 'default', folders: [] }], default: 'default', folder: '/work', folderAccount: 'default', rule: 'single key' }),
      resolveKey: async () => ({ key: 'sk_T', source: 'file' }), makeClient: () => client,
      fetch: async (url) => ({ status: url.includes('zz-probe') || url.endsWith('/a') ? 302 : 404, headers: { get: (k) => (k === 'location' ? 'https://example.com/a' : null) } }),
      readFile: async (p) => files[p] ?? (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); })(),
      writeFile: async (p, text) => { files[p] = text; }, sleep: async () => {}, random: () => 'zz-probe',
      ...over.ctx,
    }, out, err, files,
  };
}

test('help and unknown command', async () => {
  const h = ctx(); assert.equal(await run(['help'], h.c), 0); assert.match(h.out.join(''), /whoami/);
  const u = ctx(); assert.equal(await run(['bogus'], u.c), 2); assert.match(u.err.join(''), /Unknown command/);
  assert.match(usage(), /bulk create/);
});

test('whoami reports the key source and the domains with counts, never the key', async () => {
  const h = ctx(); assert.equal(await run(['whoami', '--json'], h.c), 0);
  const j = JSON.parse(h.out.join(''));
  assert.equal(j.key_source, 'file'); assert.equal(j.domains[0].hostname, 'go.example.com'); assert.equal(j.domains[0].links, 2);
  assert.equal(typeof j.config_path, 'string'); assert.match(j.config_path, /short-io-plugin\/config\.toml$/);
  assert.equal(h.out.join('').includes('sk_T'), false);
  const t = ctx(); assert.equal(await run(['whoami'], t.c), 0);
  assert.match(t.out.join(''), /config path: .*short-io-plugin\/config\.toml/);
});

test('no key exits 2 with the setup hint', async () => {
  const h = ctx({ ctx: { resolveKey: async () => ({ key: null, source: 'none', configPath: '/cfg' }) } });
  assert.equal(await run(['domains'], h.c), 2); assert.match(h.err.join(''), /short-io:setup/);
});

test('links lists every page, as JSON or CSV, with the total', async () => {
  const j = ctx(); assert.equal(await run(['links', 'go.example.com', '--json'], j.c), 0);
  const parsed = JSON.parse(j.out.join('')); assert.equal(parsed.count, 2); assert.equal(parsed.links.length, 2);
  const c = ctx(); assert.equal(await run(['links', '12345', '--csv'], c.c), 0);
  assert.match(c.out.join(''), /^path,originalURL,shortURL,title,tags,archived,idString,createdAt\n/);
  assert.match(c.out.join(''), /\nb,https:\/\/example.com\/b/);
});

test('check prints configured destination, live hop, fallback and verdict', async () => {
  const h = ctx(); assert.equal(await run(['check', 'go.example.com/a', '--json'], h.c), 0);
  const j = JSON.parse(h.out.join('')); assert.equal(j.verdict, 'ok'); assert.equal(j.fallback.hasFallback, true);
  const f = ctx(); assert.equal(await run(['check', 'https://go.example.com/nope'], f.c), 0);
  assert.match(f.out.join(''), /free/); assert.match(f.out.join(''), /fallback/i);
});

test('check names what unknown slugs actually answer, a 200 page as well as a 404', async () => {
  const page = ctx({ ctx: { fetch: async () => ({ status: 200, headers: { get: () => null } }) } });
  assert.equal(await run(['check', 'go.example.com/nope'], page.c), 0);
  assert.match(page.out.join(''), /HTTP 200 with a page/);
  assert.equal(page.out.join('').includes('answer 404'), false);
  const missing = ctx({ ctx: { fetch: async () => ({ status: 404, headers: { get: () => null } }) } });
  assert.equal(await run(['check', 'go.example.com/nope'], missing.c), 0);
  assert.match(missing.out.join(''), /answer 404/);
});

test('create makes a link and reports exists/taken/duplicate without exit 1', async () => {
  const h = ctx(); assert.equal(await run(['create', 'go.example.com', 'https://example.com/z', '--path', 'z', '--tags', 'a,b', '--json'], h.c), 0);
  assert.equal(JSON.parse(h.out.join('')).action, 'created');
  const t = ctx(); assert.equal(await run(['create', 'go.example.com', 'https://example.com/other', '--path', 'a'], t.c), 1);
  assert.match(t.err.join(''), /taken/);
});

test('bulk create is a dry run by default and runs with --yes, writing a results file', async () => {
  const h = ctx(); h.files['/in.csv'] = 'url,path\nhttps://example.com/1,one\nhttps://example.com/2,two\n';
  assert.equal(await run(['bulk', 'create', '/in.csv', '--domain', 'go.example.com'], h.c), 0);
  assert.match(h.out.join(''), /create\s+2/); assert.match(h.out.join(''), /--yes/);
  assert.equal(Object.keys(h.files).length, 1);
  const r = ctx(); r.files['/in.csv'] = h.files['/in.csv'];
  assert.equal(await run(['bulk', 'create', '/in.csv', '--domain', 'go.example.com', '--yes'], r.c), 0);
  assert.match(r.files['/in-results.csv'], /^row,url,path,action,short_url,id,note\n/);
  assert.match(r.out.join(''), /created\s+2/);
});

test('delete requires --yes and confirms', async () => {
  const n = ctx(); assert.equal(await run(['delete', 'go.example.com/a'], n.c), 2); assert.match(n.err.join(''), /--yes/); assert.match(n.err.join(''), /permanent/);
  const y = ctx({ client: { expand: (() => { let n = 0; return async () => (n++ === 0 ? { idString: 'l1' } : null); })() } });
  assert.equal(await run(['delete', 'go.example.com/a', '--yes', '--json'], y.c), 0);
  assert.equal(JSON.parse(y.out.join('')).deleted, 'l1');
});

test('API errors exit 1 with the message and config errors exit 2', async () => {
  const { ShortIoError } = await import('../lib/client.mjs');
  const a = ctx({ client: { listDomains: async () => { throw new ShortIoError('auth', 'rejected'); } } });
  assert.equal(await run(['domains'], a.c), 1); assert.match(a.err.join(''), /rejected/);
  const { ConfigError } = await import('../lib/config.mjs');
  const c = ctx({ ctx: { resolveKey: async () => { throw new ConfigError('pk_ key'); } } });
  assert.equal(await run(['domains'], c.c), 2);
});

test('bulk create dry run emits JSON under --json and writes nothing', async () => {
  const h = ctx(); h.files['/in.csv'] = 'url,path\nhttps://example.com/1,one\nhttps://example.com/2,two\n';
  assert.equal(await run(['bulk', 'create', '/in.csv', '--domain', 'go.example.com', '--json'], h.c), 0);
  const j = JSON.parse(h.out.join(''));
  assert.equal(j.dry_run, true); assert.equal(j.rows, 2); assert.equal(j.counts.create, 2);
  assert.equal(j.domain, 'go.example.com'); assert.equal(j.items.length, 2);
  assert.equal(j.items[0].path, 'one'); assert.equal(j.items[0].existing, null);
  assert.equal(Object.keys(h.files).length, 1);
});

test('a missing input file is a usage error, not a stack dump', async () => {
  const h = ctx();
  assert.equal(await run(['bulk', 'create', '/nope.csv', '--domain', 'go.example.com'], h.c), 2);
  const err = h.err.join('');
  assert.match(err, /no such file/); assert.match(err, /nope\.csv/);
  assert.equal(err.includes('    at '), false);
});

test('an unexpected error prints its message only, with the stack behind SHORT_IO_DEBUG', async () => {
  const h = ctx({ client: { listDomains: async () => { throw new Error('boom'); } } });
  assert.equal(await run(['domains'], h.c), 1);
  assert.match(h.err.join(''), /boom/); assert.equal(h.err.join('').includes('    at '), false);
  const d = ctx({ client: { listDomains: async () => { throw new Error('boom'); } }, ctx: { env: { SHORT_IO_DEBUG: '1' } } });
  assert.equal(await run(['domains'], d.c), 1);
  assert.equal(d.err.join('').includes('    at '), true);
});

test('a results file that cannot be written still reports the counts and exits 1', async () => {
  const h = ctx({ ctx: { writeFile: async () => { throw new Error('EROFS: read-only file system'); } } });
  h.files['/in.csv'] = 'url,path\nhttps://example.com/1,one\n';
  assert.equal(await run(['bulk', 'create', '/in.csv', '--domain', 'go.example.com', '--yes'], h.c), 1);
  const err = h.err.join('');
  assert.match(err, /created\s+1/); assert.match(err, /cannot write \/in-results\.csv/); assert.match(err, /read-only file system/);
});

const TWO = ['default = "pm"', '', '[accounts.pm]', 'api_key = "sk_PM"', '', '[accounts.idd]', 'api_key = "sk_IDD"', 'folders = ["/srv/idd"]'].join('\n');
const DOMAINS_OF = { pm: [{ id: 1, hostname: 'pm.example', linkType: 'random', redirect404: null }], idd: [{ id: 2, hostname: 'idd.example', linkType: 'eight-char', redirect404: null }] };

function fakeClient(name, calls, over = {}) {
  const deleted = new Set();
  return {
    listDomains: async () => { calls.push(`${name}:listDomains`); return DOMAINS_OF[name]; },
    listLinks: async () => { calls.push(`${name}:listLinks`); return { count: 1, links: [{ path: 'a', originalURL: 'https://example.com/a', idString: `${name}-1`, archived: false }] }; },
    expand: async (d, p) => { calls.push(`${name}:expand:${d}`); return p === 'a' && !deleted.has(p) ? { idString: `${name}-1`, originalURL: 'https://example.com/a' } : null; },
    linksByUrl: async () => [],
    createLink: async (b) => { calls.push(`${name}:create:${b.domain}`); return { idString: `${name}-2`, path: b.path, shortURL: `https://${b.domain}/${b.path}`, createdAt: new Date().toISOString() }; },
    deleteLink: async (id) => { calls.push(`${name}:delete:${id}`); deleted.add('a'); return { success: true }; },
    ...over,
  };
}

// The real loader and resolver over fake file text, with one fake client per API key, so a test
// reads which account was opened and what was called on it.
function accounts({ cwd = '/work', config = TWO, pm = {}, idd = {}, env = {} } = {}) {
  const out = []; const err = []; const calls = []; const opened = []; const files = {};
  const clients = { sk_PM: fakeClient('pm', calls, pm), sk_IDD: fakeClient('idd', calls, idd) };
  return {
    c: {
      env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
      loadAccounts: (d) => loadAccounts({ ...d, homedir: () => '/home/tester', readFile: async () => config, stat: async () => ({ mode: 0o600 }), realpath: async (p) => p, cwd: () => cwd }),
      resolveKey,
      makeClient: ({ key }) => { opened.push(key); return clients[key]; },
      fetch: async () => ({ status: 404, headers: { get: () => null } }),
      readFile: async (p) => files[p], writeFile: async (p, text) => { files[p] = text; }, sleep: async () => {}, random: () => 'zz-probe',
    },
    out, err, calls, opened, files,
  };
}

test('create routes to the account that owns the domain', async () => {
  const h = accounts();
  assert.equal(await run(['create', 'idd.example', 'https://example.com/z', '--path', 'z', '--json'], h.c), 0);
  assert.equal(JSON.parse(h.out.join('')).action, 'created');
  assert.deepEqual(h.opened, ['sk_PM', 'sk_IDD']);
  assert.equal(h.calls.includes('idd:create:idd.example'), true);
  assert.equal(h.calls.some((call) => call.startsWith('pm:create')), false);
});

test('the working folder account is tried first, and the other key is never read', async () => {
  const h = accounts({ cwd: '/srv/idd/sub', config: TWO.replace('sk_PM', 'pk_WOULD_FAIL_IF_READ') });
  assert.equal(await run(['create', 'idd.example', 'https://example.com/z', '--path', 'z', '--json'], h.c), 0);
  assert.deepEqual(h.opened, ['sk_IDD']);
  assert.deepEqual(h.calls.filter((call) => call.endsWith('listDomains')), ['idd:listDomains']);
});

test('the default is tried before the rest of the file', async () => {
  const h = accounts({ config: TWO.replace('default = "pm"', 'default = "idd"') });
  assert.equal(await run(['links', 'idd.example', '--json'], h.c), 0);
  assert.deepEqual(h.opened, ['sk_IDD']);
});

test('--account uses that account only', async () => {
  const h = accounts();
  assert.equal(await run(['create', 'idd.example', 'https://example.com/z', '--path', 'z', '--account', 'idd', '--json'], h.c), 0);
  assert.deepEqual(h.opened, ['sk_IDD']);
});

test('a domain the named account does not own gets the No domain error, with no fallback', async () => {
  for (const args of [['create', 'pm.example', 'https://example.com/z'], ['links', 'pm.example'], ['check', 'pm.example/a'], ['delete', 'pm.example/a', '--yes']]) {
    const h = accounts();
    assert.equal(await run([...args, '--account', 'idd'], h.c), 2, args[0]);
    assert.match(h.err.join(''), /No domain "pm\.example" on this account/);
    assert.deepEqual(h.opened, ['sk_IDD'], args[0]);
  }
});

test('an unknown account is a usage error listing the names, before any key is read', async () => {
  for (const flag of [['--account', 'nope'], ['--account=']]) {
    const h = accounts();
    assert.equal(await run(['links', 'idd.example', ...flag], h.c), 2);
    assert.match(h.err.join(''), /Accounts: pm, idd/);
    assert.deepEqual(h.opened, []);
  }
});

test('a domain no account owns lists each account and its domains', async () => {
  const h = accounts();
  assert.equal(await run(['create', 'nope.example', 'https://example.com/z'], h.c), 2);
  const err = h.err.join('');
  assert.match(err, /nope\.example/);
  assert.match(err, /pm.*pm\.example \(1\)/s);
  assert.match(err, /idd.*idd\.example \(2\)/s);
  assert.equal(h.calls.some((call) => call.includes(':create')), false);
});

test('an API error while routing stops the command and never tries the next account', async () => {
  const h = accounts({ pm: { listDomains: async () => { throw new ShortIoError('auth', 'rejected'); } } });
  assert.equal(await run(['create', 'idd.example', 'https://example.com/z'], h.c), 1);
  assert.match(h.err.join(''), /account "pm".*rejected/s);
  assert.deepEqual(h.opened, ['sk_PM']);
  assert.equal(h.calls.some((call) => call.includes(':create')), false);
});

test('a key that fails to resolve while routing stops the command', async () => {
  const h = accounts({ config: TWO.replace('sk_PM', 'pk_BAD') });
  assert.equal(await run(['create', 'idd.example', 'https://example.com/z'], h.c), 2);
  assert.match(h.err.join(''), /account "pm".*Public key toggle/s);
  assert.equal(h.err.join('').includes('pk_BAD'), false);
  assert.deepEqual(h.opened, []);
});

test('links, by hostname or id, reads the owning account', async () => {
  const h = accounts();
  assert.equal(await run(['links', '2', '--json'], h.c), 0);
  assert.equal(JSON.parse(h.out.join('')).domain, 'idd.example');
  assert.equal(h.calls.includes('idd:listLinks'), true);
  assert.equal(h.calls.includes('pm:listLinks'), false);
});

test('check finds the owner before expand', async () => {
  const h = accounts();
  assert.equal(await run(['check', 'idd.example/a', '--json'], h.c), 0);
  assert.equal(JSON.parse(h.out.join('')).domain, 'idd.example');
  assert.deepEqual(h.calls, ['pm:listDomains', 'idd:listDomains', 'idd:expand:idd.example']);
});

test('bulk create routes its dry run and its run to the owner', async () => {
  const h = accounts();
  h.c.readFile = async () => 'url,path\nhttps://example.com/1,one\n';
  assert.equal(await run(['bulk', 'create', '/in.csv', '--domain', 'idd.example', '--json'], h.c), 0);
  assert.equal(JSON.parse(h.out.join('')).domain, 'idd.example');
  assert.equal(h.calls.some((call) => call.startsWith('pm:expand')), false);
  const r = accounts();
  r.c.readFile = h.c.readFile;
  assert.equal(await run(['bulk', 'create', '/in.csv', '--domain', 'idd.example', '--yes', '--out', '/r.csv'], r.c), 0);
  assert.equal(r.calls.includes('idd:create:idd.example'), true);
  assert.equal(r.calls.some((call) => call.startsWith('pm:create')), false);
});

test('delete routes to the owner and deletes there only', async () => {
  const h = accounts();
  assert.equal(await run(['delete', 'idd.example/a', '--yes', '--json'], h.c), 0);
  assert.equal(JSON.parse(h.out.join('')).deleted, 'idd-1');
  assert.equal(h.calls.includes('idd:delete:idd-1'), true);
  assert.equal(h.calls.some((call) => call.startsWith('pm:delete')), false);
});

test('with one account check and delete make no domain lookup, so an outside domain still answers', async () => {
  const noLookup = { listDomains: async () => { throw new Error('no lookup expected'); } };
  const single = ctx({ client: noLookup });
  assert.equal(await run(['check', 'outside.example/a', '--json'], single.c), 0);
  assert.equal(JSON.parse(single.out.join('')).domain, 'outside.example');
  const one = accounts({ config: '[accounts.pm]\napi_key = "sk_PM"', pm: noLookup });
  assert.equal(await run(['check', 'outside.example/a', '--json'], one.c), 0);
  const del = accounts({ config: '[accounts.pm]\napi_key = "sk_PM"', pm: noLookup });
  assert.equal(await run(['delete', 'outside.example/a', '--yes', '--json'], del.c), 0);
  assert.equal(del.calls.includes('pm:delete:pm-1'), true);
});

test('--account default selects the single key, and any other name is unknown', async () => {
  const yes = ctx(); assert.equal(await run(['links', 'go.example.com', '--account', 'default', '--json'], yes.c), 0);
  const no = ctx(); assert.equal(await run(['links', 'go.example.com', '--account', 'idd'], no.c), 2);
  assert.match(no.err.join(''), /Accounts: default/);
});

test('single-key messages stay as 0.1.0 wrote them, with no account prefix', async () => {
  const h = ctx();
  assert.equal(await run(['links', 'nope.example'], h.c), 2);
  assert.equal(h.err.join(''), 'short-io: No domain "nope.example" on this account. Domains: go.example.com (12345)\n');
  const a = ctx({ client: { listDomains: async () => { throw new ShortIoError('auth', 'rejected'); } } });
  assert.equal(await run(['links', 'go.example.com'], a.c), 1);
  assert.equal(a.err.join(''), 'short-io: rejected\n');
});

test('a key in the settings field beside named accounts stops the CLI too', async () => {
  const h = accounts({ env: { SHORT_IO_API_KEY: 'sk_ENV' } });
  assert.equal(await run(['links', 'idd.example'], h.c), 2);
  assert.match(h.err.join(''), /SHORT_IO_API_KEY.*settings field/s);
  assert.equal(h.err.join('').includes('sk_ENV'), false);
  assert.deepEqual(h.opened, []);
});

test('usage names the --account flag', () => {
  assert.match(usage(), /--account <name>/);
});

test('whoami --json keeps every 0.1.0 field for the folder account and adds the account view', async () => {
  const h = accounts({ cwd: '/srv/idd/x' });
  assert.equal(await run(['whoami', '--json'], h.c), 0);
  const j = JSON.parse(h.out.join(''));
  assert.equal(j.key_source, 'file');
  assert.deepEqual(j.domains, [{ id: 2, hostname: 'idd.example', linkType: 'eight-char', links: 1 }]);
  assert.match(j.config_path, /short-io-plugin\/config\.toml$/);
  assert.equal(typeof j.data_dir, 'string');
  assert.equal(j.default, 'pm');
  assert.equal(j.folder, '/srv/idd/x');
  assert.equal(j.folder_account, 'idd');
  assert.deepEqual(j.accounts, [
    { name: 'pm', key_source: 'file', folders: [], domains: [{ id: 1, hostname: 'pm.example', linkType: 'random', links: 1 }], error: null },
    { name: 'idd', key_source: 'file', folders: ['/srv/idd'], domains: [{ id: 2, hostname: 'idd.example', linkType: 'eight-char', links: 1 }], error: null },
  ]);
  assert.equal(h.out.join('').includes('sk_'), false);
});

test('whoami text names each account, the default and the folder account, never a key', async () => {
  const h = accounts({ cwd: '/srv/idd/x' });
  assert.equal(await run(['whoami'], h.c), 0);
  const text = h.out.join('');
  assert.match(text, /account: pm\nkey source: file\nfolders: none\n/);
  assert.match(text, /account: idd\nkey source: file\nfolders: \/srv\/idd\n/);
  assert.match(text, /pm\.example/);
  assert.match(text, /idd\.example/);
  assert.match(text, /default account: pm\n/);
  assert.match(text, /MCP tools here: idd \(folder \/srv\/idd matches \/srv\/idd\/x\)/);
  assert.ok(text.indexOf('account: idd') < text.indexOf('default account:'));
  assert.equal(text.includes('sk_'), false);
  assert.equal(h.err.join('').includes('sk_'), false);
});

test('whoami text says when no folder matched and the default answered', async () => {
  const h = accounts();
  assert.equal(await run(['whoami'], h.c), 0);
  assert.match(h.out.join(''), /MCP tools here: pm \(no folder matched, using the default\)/);
});

test('a failing account gets an error field, the others still report, and whoami exits 1', async () => {
  const h = accounts({ pm: { listDomains: async () => { throw new ShortIoError('auth', 'rejected'); } } });
  assert.equal(await run(['whoami', '--json'], h.c), 1);
  const j = JSON.parse(h.out.join(''));
  assert.match(j.accounts[0].error, /rejected/);
  assert.equal(j.accounts[0].key_source, 'file');
  assert.deepEqual(j.accounts[0].domains, []);
  assert.equal(j.accounts[1].error, null);
  assert.equal(j.accounts[1].domains[0].hostname, 'idd.example');
  const t = accounts({ pm: { listDomains: async () => { throw new ShortIoError('auth', 'rejected'); } } });
  assert.equal(await run(['whoami'], t.c), 1);
  assert.match(t.out.join(''), /account: pm\nkey source: file\nfolders: none\nerror: rejected\n/);
  assert.match(t.out.join(''), /idd\.example/);
});

test('a key that will not resolve is that account\'s error in whoami, never printed', async () => {
  const h = accounts({ config: TWO.replace('sk_PM', 'pk_BAD') });
  assert.equal(await run(['whoami', '--json'], h.c), 1);
  const j = JSON.parse(h.out.join(''));
  assert.match(j.accounts[0].error, /Public key toggle/);
  assert.equal(j.accounts[0].key_source, null);
  assert.equal(j.accounts[1].domains.length, 1);
  assert.equal(h.out.join('').includes('pk_BAD'), false);
});

test('whoami with no default and no matching folder says the bridge will not start', async () => {
  const config = TWO.replace('default = "pm"', '');
  const h = accounts({ config });
  assert.equal(await run(['whoami', '--json'], h.c), 0);
  const j = JSON.parse(h.out.join(''));
  assert.equal(j.default, null);
  assert.equal(j.folder_account, null);
  assert.equal(j.key_source, null);
  assert.deepEqual(j.domains, []);
  assert.equal(j.accounts.length, 2);
  const t = accounts({ config });
  assert.equal(await run(['whoami'], t.c), 0);
  assert.match(t.out.join(''), /default account: none/);
  assert.match(t.out.join(''), /MCP tools here: none .*will not start/);
});

test('whoami --account shows that account only', async () => {
  const h = accounts();
  assert.equal(await run(['whoami', '--account', 'idd', '--json'], h.c), 0);
  const j = JSON.parse(h.out.join(''));
  assert.deepEqual(j.accounts.map((a) => a.name), ['idd']);
  assert.equal(j.domains[0].hostname, 'idd.example');
  assert.equal(j.folder_account, 'pm');
  assert.deepEqual(h.opened, ['sk_IDD']);
});

test('single-key whoami adds the same JSON fields and keeps its text', async () => {
  const h = ctx();
  assert.equal(await run(['whoami', '--json'], h.c), 0);
  const j = JSON.parse(h.out.join(''));
  assert.equal(j.default, 'default');
  assert.equal(j.folder, '/work');
  assert.equal(j.folder_account, 'default');
  assert.deepEqual(j.accounts.map((a) => [a.name, a.key_source, a.folders, a.error]), [['default', 'file', [], null]]);
  const t = ctx();
  assert.equal(await run(['whoami'], t.c), 0);
  const lines = t.out.join('').split('\n');
  assert.equal(lines[0], 'key source: file');
  assert.match(lines[1], /^config path: /);
  assert.match(lines[2], /^id\s+hostname\s+type\s+links$/);
  assert.match(lines[3], /^12345\s+go\.example\.com\s+eight-char\s+2$/);
  assert.equal(t.out.join('').includes('account:'), false);
});

test('single-key whoami keeps its exit codes and messages', async () => {
  const { ConfigError } = await import('../lib/config.mjs');
  const c = ctx({ ctx: { resolveKey: async () => { throw new ConfigError('pk_ key'); } } });
  assert.equal(await run(['whoami'], c.c), 2);
  assert.equal(c.err.join(''), 'short-io: pk_ key\n');
  const a = ctx({ client: { listDomains: async () => { throw new ShortIoError('auth', 'rejected'); } } });
  assert.equal(await run(['whoami', '--json'], a.c), 1);
  assert.equal(a.err.join(''), 'short-io: rejected\n');
  assert.equal(a.out.join(''), '');
});

test('domains lists every account, with an account column and JSON field', async () => {
  const j = accounts();
  assert.equal(await run(['domains', '--json'], j.c), 0);
  assert.deepEqual(JSON.parse(j.out.join('')).map((d) => [d.account, d.hostname, d.id, d.linkType]), [['pm', 'pm.example', 1, 'random'], ['idd', 'idd.example', 2, 'eight-char']]);
  const t = accounts();
  assert.equal(await run(['domains'], t.c), 0);
  const lines = t.out.join('').split('\n');
  assert.match(lines[0], /^account\s+id\s+hostname\s+type\s+redirect404$/);
  assert.match(lines[1], /^pm\s+1\s+pm\.example/);
  assert.match(lines[2], /^idd\s+2\s+idd\.example/);
});

test('domains --account lists that account only', async () => {
  const h = accounts();
  assert.equal(await run(['domains', '--account', 'idd', '--json'], h.c), 0);
  assert.deepEqual(JSON.parse(h.out.join('')).map((d) => d.account), ['idd']);
  assert.deepEqual(h.opened, ['sk_IDD']);
});

test('a failing account is a row in domains, the others still list, and it exits 1', async () => {
  const fail = { listDomains: async () => { throw new ShortIoError('auth', 'rejected'); } };
  const j = accounts({ pm: fail });
  assert.equal(await run(['domains', '--json'], j.c), 1);
  const rows = JSON.parse(j.out.join(''));
  assert.equal(rows[0].account, 'pm');
  assert.match(rows[0].error, /rejected/);
  assert.equal(rows[1].hostname, 'idd.example');
  const t = accounts({ pm: fail });
  assert.equal(await run(['domains'], t.c), 1);
  assert.match(t.out.join(''), /^pm\s+error: rejected$/m);
  assert.match(t.out.join(''), /idd\.example/);
});

test('single-key domains keeps its table and adds account to the JSON', async () => {
  const t = ctx();
  assert.equal(await run(['domains'], t.c), 0);
  assert.match(t.out.join('').split('\n')[0], /^id\s+hostname\s+type\s+redirect404$/);
  const j = ctx();
  assert.equal(await run(['domains', '--json'], j.c), 0);
  assert.deepEqual(JSON.parse(j.out.join('')), [{ ...DOMAINS[0], account: 'default' }]);
});
