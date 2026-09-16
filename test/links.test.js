import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, resolveDomain, listAllLinks, classifyCreate, createOne, deleteBySlug, normaliseTags } from '../lib/links.mjs';
import { ShortIoError } from '../lib/client.mjs';

const DOMAINS = [{ id: 12345, hostname: 'go.example.com', linkType: 'eight-char', redirect404: null }];
const fake = (over = {}) => ({
  calls: [],
  listDomains: async () => DOMAINS,
  listLinks: async ({ domainId, pageToken }) => (pageToken ? { count: 3, links: [{ path: 'c' }] } : { count: 3, links: [{ path: 'a' }, { path: 'b' }], nextPageToken: 'page_2' }),
  expand: async () => null,
  linksByUrl: async () => [],
  createLink: async (body) => ({ idString: 'link_new', path: body.path ?? 'rnd', originalURL: body.originalURL, createdAt: '2026-09-16T00:00:10.000Z' }),
  deleteLink: async () => ({ success: true }),
  ...over,
});

test('parseTarget accepts domain/slug, a short URL and a bare slug with --domain', () => {
  assert.deepEqual(parseTarget('go.example.com/spring'), { domain: 'go.example.com', path: 'spring' });
  assert.deepEqual(parseTarget('https://go.example.com/spring?x=1'), { domain: 'go.example.com', path: 'spring' });
  assert.deepEqual(parseTarget('spring', 'go.example.com'), { domain: 'go.example.com', path: 'spring' });
  assert.throws(() => parseTarget('spring'), /domain/);
  assert.throws(() => parseTarget('go.example.com/'), /slug/);
});

test('resolveDomain matches hostname or numeric id and fails loud otherwise', async () => {
  const c = fake();
  assert.equal((await resolveDomain(c, 'go.example.com')).id, 12345);
  assert.equal((await resolveDomain(c, '12345')).hostname, 'go.example.com');
  await assert.rejects(resolveDomain(c, 'nope.example'), (e) => e instanceof ShortIoError && e.code === 'usage' && /go\.example\.com/.test(e.message));
});

test('listAllLinks follows nextPageToken to the end and reports the count', async () => {
  const pages = [];
  const out = await listAllLinks(fake(), 12345, { onPage: (p) => pages.push(p.links.length) });
  assert.equal(out.count, 3);
  assert.deepEqual(out.links.map((l) => l.path), ['a', 'b', 'c']);
  assert.deepEqual(pages, [2, 1]);
});

test('classifyCreate - invalid url, taken path, exists same url, duplicate destination, create', async () => {
  const c = fake();
  assert.equal((await classifyCreate(c, { domain: 'go.example.com', originalURL: 'not a url', path: 'p' })).action, 'invalid');
  const taken = fake({ expand: async () => ({ idString: 'link_t', originalURL: 'https://other.example/' }) });
  assert.equal((await classifyCreate(taken, { domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p' })).action, 'taken');
  const same = fake({ expand: async () => ({ idString: 'link_s', originalURL: 'https://example.com/' }) });
  const ex = await classifyCreate(same, { domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p' });
  assert.equal(ex.action, 'exists'); assert.equal(ex.existing.idString, 'link_s');
  const dup = fake({ linksByUrl: async () => [{ idString: 'link_d', path: 'other' }] });
  const d = await classifyCreate(dup, { domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p' });
  assert.equal(d.action, 'duplicate'); assert.equal(d.existing.path, 'other');
  assert.equal((await classifyCreate(c, { domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p' })).action, 'create');
  assert.equal((await classifyCreate(c, { domain: 'go.example.com', originalURL: 'https://example.com/' })).action, 'create');
});

test('createOne creates, skips duplicates unless allowed, and detects a silent existing return', async () => {
  const c = fake();
  const made = await createOne(c, { domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p', title: 't', tags: 'a, b' }, { now: () => new Date('2026-09-16T00:00:00Z') });
  assert.equal(made.action, 'created'); assert.equal(made.link.idString, 'link_new');
  assert.deepEqual(c.calls, []);
  const dup = fake({ linksByUrl: async () => [{ idString: 'link_d', path: 'other' }] });
  assert.equal((await createOne(dup, { domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p' })).action, 'duplicate');
  assert.equal((await createOne(dup, { domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p' }, { allowDuplicate: true, now: () => new Date('2026-09-16T00:00:00Z') })).action, 'created');
  const silent = fake({ createLink: async () => ({ idString: 'link_old', path: 'rnd', createdAt: '2026-09-15T00:00:00.000Z' }) });
  const s = await createOne(silent, { domain: 'go.example.com', originalURL: 'https://example.com/' }, { now: () => new Date('2026-09-16T00:00:00Z') });
  assert.equal(s.action, 'exists'); assert.equal(s.link.idString, 'link_old');
});

test('createOne sends tags as an array and omits empty optional fields', async () => {
  const seen = [];
  const c = fake({ createLink: async (b) => { seen.push(b); return { idString: 'x', createdAt: new Date().toISOString() }; } });
  await createOne(c, { domain: 'go.example.com', originalURL: 'https://example.com/', path: '', title: '', tags: 'a,b' });
  assert.deepEqual(seen[0], { domain: 'go.example.com', originalURL: 'https://example.com/', tags: ['a', 'b'] });
});

test('deleteBySlug expands, deletes and confirms gone', async () => {
  const seq = [];
  const c = fake({ expand: async () => { seq.push('expand'); return seq.length === 1 ? { idString: 'link_z' } : null; }, deleteLink: async (id) => { seq.push(`delete:${id}`); return { success: true }; } });
  assert.deepEqual(await deleteBySlug(c, 'go.example.com', 'z'), { deleted: 'link_z' });
  assert.deepEqual(seq, ['expand', 'delete:link_z', 'expand']);
  await assert.rejects(deleteBySlug(fake(), 'go.example.com', 'free'), (e) => e.code === 'not_found');
});

test('normaliseTags splits on commas, trims and drops empties', () => {
  assert.deepEqual(normaliseTags(' a, b ,,c '), ['a', 'b', 'c']);
  assert.deepEqual(normaliseTags(['x']), ['x']);
  assert.deepEqual(normaliseTags(''), []);
});
