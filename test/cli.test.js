import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, usage } from '../lib/cli.mjs';

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
  assert.equal(h.out.join('').includes('sk_T'), false);
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
