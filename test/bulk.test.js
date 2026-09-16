import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSpecs, planBulk, runBulk, RESULT_COLUMNS } from '../lib/bulk.mjs';

const fake = (over = {}) => ({
  expand: async (d, p) => (p === 'taken' ? { idString: 'link_t', originalURL: 'https://other.example/' } : p === 'same' ? { idString: 'link_s', originalURL: 'https://example.com/same' } : null),
  linksByUrl: async (d, u) => (u === 'https://example.com/dup' ? [{ idString: 'link_d', path: 'older' }] : []),
  createLink: async (b) => ({ idString: `link_${b.path ?? 'rnd'}`, path: b.path ?? 'rnd', shortURL: `https://go.example.com/${b.path ?? 'rnd'}`, createdAt: new Date().toISOString() }),
  ...over,
});

test('loadSpecs reads CSV with a header and JSON arrays, requiring url', () => {
  const csv = loadSpecs('url,path,title,tags\nhttps://example.com/a,a,A,"t1,t2"\n', { format: 'csv' });
  assert.deepEqual(csv[0], { url: 'https://example.com/a', path: 'a', title: 'A', tags: 't1,t2', row: 2 });
  const json = loadSpecs('[{"url":"https://example.com/b","path":"b"}]', { format: 'json' });
  assert.deepEqual(json[0], { url: 'https://example.com/b', path: 'b', title: '', tags: '', row: 1 });
  assert.throws(() => loadSpecs('path\nx\n', { format: 'csv' }), /url column/);
});

test('planBulk classifies every row and counts, without creating anything', async () => {
  const specs = [
    { url: 'https://example.com/new', path: 'new', row: 2 }, { url: 'https://example.com/taken', path: 'taken', row: 3 },
    { url: 'https://example.com/same', path: 'same', row: 4 }, { url: 'https://example.com/dup', path: 'fresh', row: 5 },
    { url: 'nope', path: 'bad', row: 6 }, { url: 'https://example.com/new', path: 'new', row: 7 },
  ];
  const plan = await planBulk(fake(), specs, { domain: 'go.example.com' });
  assert.deepEqual(plan.items.map((i) => i.action), ['create', 'taken', 'exists', 'duplicate', 'invalid', 'duplicate-in-file']);
  assert.deepEqual(plan.counts, { create: 1, taken: 1, exists: 1, duplicate: 1, invalid: 1, 'duplicate-in-file': 1 });
});

test('runBulk creates only the create rows, paces, and writes result rows', async () => {
  const sleeps = [];
  const specs = [{ url: 'https://example.com/new', path: 'new', row: 2 }, { url: 'https://example.com/new2', path: 'new2', row: 3 }, { url: 'nope', path: 'bad', row: 4 }];
  const plan = await planBulk(fake(), specs, { domain: 'go.example.com' });
  const out = await runBulk(fake(), plan, { domain: 'go.example.com', sleep: async (ms) => { sleeps.push(ms); }, minGapMs: 200 });
  assert.deepEqual(out.counts, { created: 2, skipped: 1, failed: 0 });
  assert.equal(out.results[0].short_url, 'https://go.example.com/new');
  assert.equal(out.results[2].action, 'invalid');
  assert.deepEqual(sleeps, [200]);
  assert.deepEqual(RESULT_COLUMNS, ['row', 'url', 'path', 'action', 'short_url', 'id', 'note']);
});

test('runBulk records an API failure on the row and continues', async () => {
  const c = fake({ createLink: async (b) => { if (b.path === 'boom') throw Object.assign(new Error('HTTP 500'), { code: 'transient' }); return { idString: 'ok', path: b.path, shortURL: 'https://go.example.com/' + b.path, createdAt: new Date().toISOString() }; } });
  const plan = await planBulk(c, [{ url: 'https://example.com/1', path: 'boom', row: 2 }, { url: 'https://example.com/2', path: 'fine', row: 3 }], { domain: 'go.example.com' });
  const out = await runBulk(c, plan, { domain: 'go.example.com', sleep: async () => {} });
  assert.deepEqual(out.counts, { created: 1, skipped: 0, failed: 1 });
  assert.match(out.results[0].note, /HTTP 500/);
});
