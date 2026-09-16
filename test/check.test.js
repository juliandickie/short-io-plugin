import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeLive, probeFallback, checkSlug } from '../lib/check.mjs';

const answer = (status, location) => ({ status, headers: { get: (k) => (k.toLowerCase() === 'location' ? location ?? null : null) } });
const fetcher = (map) => async (url, init) => { assert.equal(init.redirect, 'manual'); return map[url] ?? answer(404); };

test('probeLive reports the first hop without following', async () => {
  const f = fetcher({ 'https://go.example.com/spring': answer(302, 'https://example.com/spring-sale') });
  assert.deepEqual(await probeLive(f, 'https://go.example.com/spring'), { status: 302, location: 'https://example.com/spring-sale' });
});

test('probeFallback says whether an unknown slug is redirected', async () => {
  const random = () => 'zz-probe-1';
  const yes = await probeFallback(fetcher({ 'https://go.example.com/zz-probe-1': answer(302, 'https://example.com/') }), 'go.example.com', { random });
  assert.deepEqual(yes, { hasFallback: true, status: 302, location: 'https://example.com/', probedPath: 'zz-probe-1' });
  const no = await probeFallback(fetcher({}), 'go.example.com', { random });
  assert.equal(no.hasFallback, false); assert.equal(no.status, 404);
});

test('checkSlug verdicts - ok, mismatch, free, free-but-redirects', async () => {
  const random = () => 'zz-probe-1';
  const live = fetcher({ 'https://go.example.com/spring': answer(302, 'https://example.com/spring-sale'), 'https://go.example.com/zz-probe-1': answer(302, 'https://example.com/') });
  const client = { expand: async (d, p) => (p === 'spring' ? { idString: 'link_1', originalURL: 'https://example.com/spring-sale' } : null) };
  const ok = await checkSlug(client, { domain: 'go.example.com', path: 'spring' }, { fetch: live, random });
  assert.equal(ok.verdict, 'ok'); assert.equal(ok.configured, 'https://example.com/spring-sale'); assert.equal(ok.fallback.hasFallback, true);
  const mism = await checkSlug({ expand: async () => ({ idString: 'l', originalURL: 'https://example.com/other' }) }, { domain: 'go.example.com', path: 'spring' }, { fetch: live, random });
  assert.equal(mism.verdict, 'mismatch');
  const free = await checkSlug({ expand: async () => null }, { domain: 'go.example.com', path: 'gone' }, { fetch: fetcher({}), random });
  assert.equal(free.verdict, 'free'); assert.equal(free.configured, null);
  const freeRedir = await checkSlug({ expand: async () => null }, { domain: 'go.example.com', path: 'gone' }, { fetch: fetcher({ 'https://go.example.com/gone': answer(302, 'https://example.com/') }), random });
  assert.equal(freeRedir.verdict, 'free-but-redirects');
});
