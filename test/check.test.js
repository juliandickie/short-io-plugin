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

test('checkSlug reports not-resolving for a configured slug that does not redirect', async () => {
  const random = () => 'zz-probe-1';
  const client = { expand: async () => ({ idString: 'link_1', originalURL: 'https://example.com/spring-sale' }) };
  const gone = await checkSlug(client, { domain: 'go.example.com', path: 'spring' }, { fetch: fetcher({}), random });
  assert.equal(gone.verdict, 'not-resolving'); assert.equal(gone.live.status, 404);
  const broken = await checkSlug(client, { domain: 'go.example.com', path: 'spring' }, { fetch: fetcher({ 'https://go.example.com/spring': answer(503) }), random });
  assert.equal(broken.verdict, 'not-resolving'); assert.equal(broken.live.status, 503);
});

test('a thrown fetch becomes status 0 with an error string instead of rejecting', async () => {
  const random = () => 'zz-probe-1';
  const boom = async (url, init) => {
    assert.equal(init.redirect, 'manual');
    if (url === 'https://go.example.com/spring') throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
    return answer(404);
  };
  const live = await probeLive(boom, 'https://go.example.com/spring');
  assert.equal(live.status, 0); assert.equal(live.location, null); assert.match(live.error, /boom/);

  const failAll = async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); };
  const fb = await probeFallback(failAll, 'go.example.com', { random });
  assert.equal(fb.hasFallback, false); assert.equal(fb.status, 0); assert.match(fb.error, /boom/);

  const configured = await checkSlug({ expand: async () => ({ idString: 'l', originalURL: 'https://example.com/x' }) }, { domain: 'go.example.com', path: 'spring' }, { fetch: boom, random });
  assert.equal(configured.live.status, 0); assert.match(configured.live.error, /boom/); assert.equal(configured.verdict, 'not-resolving');

  const free = await checkSlug({ expand: async () => null }, { domain: 'go.example.com', path: 'spring' }, { fetch: boom, random });
  assert.equal(free.verdict, 'free');
});

test('checkSlug reuses a known fallback instead of probing again', async () => {
  let calls = 0;
  const counted = async (url, init) => { calls += 1; assert.equal(init.redirect, 'manual'); return answer(302, 'https://example.com/spring-sale'); };
  const known = { hasFallback: true, status: 302, location: 'https://example.com/', probedPath: 'x' };
  const out = await checkSlug({ expand: async () => ({ idString: 'l', originalURL: 'https://example.com/spring-sale' }) }, { domain: 'go.example.com', path: 'spring' }, { fetch: counted, fallback: known });
  assert.equal(calls, 1);
  assert.equal(out.fallback, known);
  assert.equal(out.verdict, 'ok');
});

test('cloaked and password-protected links serve 200 and still count as ok', async () => {
  const random = () => 'zz-probe-1';
  const f = fetcher({ 'https://go.example.com/spring': answer(200) });
  const cloaked = await checkSlug({ expand: async () => ({ idString: 'l', originalURL: 'https://example.com/x', cloaking: true }) }, { domain: 'go.example.com', path: 'spring' }, { fetch: f, random });
  assert.equal(cloaked.verdict, 'ok'); assert.equal(cloaked.served, 'cloaked');
  const locked = await checkSlug({ expand: async () => ({ idString: 'l', originalURL: 'https://example.com/x', hasPassword: true }) }, { domain: 'go.example.com', path: 'spring' }, { fetch: f, random });
  assert.equal(locked.verdict, 'ok'); assert.equal(locked.served, 'password');
  const plain = await checkSlug({ expand: async () => ({ idString: 'l', originalURL: 'https://example.com/x' }) }, { domain: 'go.example.com', path: 'spring' }, { fetch: f, random });
  assert.equal(plain.verdict, 'not-resolving'); assert.equal(plain.served, null);
});

test('a redirect with no Location header is not-resolving', async () => {
  const random = () => 'zz-probe-1';
  const out = await checkSlug({ expand: async () => ({ idString: 'l', originalURL: 'https://example.com/x' }) }, { domain: 'go.example.com', path: 'spring' }, { fetch: fetcher({ 'https://go.example.com/spring': answer(302) }), random });
  assert.equal(out.verdict, 'not-resolving'); assert.equal(out.served, null);
});
