import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShortIoClient, ShortIoError, classify, rateInfo, MAX_PACE_MS } from '../lib/client.mjs';

const res = (status, body, headers = {}) => ({
  status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const client = (calls, answers, extra = {}) => new ShortIoClient({
  key: 'sk_T', sleep: async (ms) => { calls.sleeps.push(ms); }, fetch: async (url, init) => { calls.push({ url, init }); return answers.shift(); }, ...extra,
});

test('every request carries the bare key and JSON accept, never Bearer', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(200, [{ id: 12345, hostname: 'go.example.com' }])]);
  const out = await c.listDomains();
  assert.deepEqual(out, [{ id: 12345, hostname: 'go.example.com' }]);
  assert.equal(calls[0].url, 'https://api.short.io/api/domains');
  assert.equal(calls[0].init.headers.authorization, 'sk_T');
  assert.equal(JSON.stringify(calls[0].init.headers).includes('Bearer'), false);
});

test('listLinks builds the query and returns count, links and nextPageToken', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(200, { count: 2, links: [{ path: 'a' }], nextPageToken: 'page_x' })]);
  const out = await c.listLinks({ domainId: 12345, limit: 150, pageToken: 'page_p' });
  assert.equal(calls[0].url, 'https://api.short.io/api/links?domain_id=12345&limit=150&pageToken=page_p');
  assert.equal(out.nextPageToken, 'page_x');
});

test('expand encodes and returns null on 404 Link not found', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(404, { error: 'Link not found' }), res(200, { idString: 'link_1', originalURL: 'https://example.com/' })]);
  assert.equal(await c.expand('go.example.com', 'free slug'), null);
  assert.equal(calls[0].url, 'https://api.short.io/links/expand?domain=go.example.com&path=free+slug');
  assert.equal((await c.expand('go.example.com', 'x')).idString, 'link_1');
});

test('createLink posts JSON and classifies 409 as conflict, 400 as validation, 404 domain as not_found', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [
    res(200, { idString: 'link_1', path: 'p' }),
    res(409, { message: 'Link already exists', statusCode: 409, success: false }),
    res(400, { message: 'originalURL must pass "url" keyword validation', statusCode: 400, code: 'FST_ERR_VALIDATION' }),
    res(404, { message: 'Domain not found', statusCode: 404, success: false }),
  ]);
  const made = await c.createLink({ domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p' });
  assert.equal(made.idString, 'link_1');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { domain: 'go.example.com', originalURL: 'https://example.com/', path: 'p' });
  await assert.rejects(c.createLink({}), (e) => e instanceof ShortIoError && e.code === 'conflict' && /already exists/.test(e.message));
  await assert.rejects(c.createLink({}), (e) => e.code === 'validation' && /originalURL/.test(e.message));
  await assert.rejects(c.createLink({}), (e) => e.code === 'not_found' && /Domain not found/.test(e.message));
});

test('401 is auth with the bare-key hint, delete 404 is not_found', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(401, { error: 'Unauthorized' }), res(404, { success: false, error: 'Link not found' })]);
  await assert.rejects(c.listDomains(), (e) => e.code === 'auth' && /bare key|Bearer/.test(e.message));
  await assert.rejects(c.deleteLink('link_9'), (e) => e.code === 'not_found');
});

test('a 429 is retried with backoff up to three times, then surfaces as rate', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(429, { error: 'Too Many Requests' }, { 'x-ratelimit-reset': '2' }), res(200, [])], { backoffMs: [100, 200, 300] });
  assert.deepEqual(await c.listDomains(), []);
  assert.deepEqual(calls.sleeps, [2000]);
  const calls2 = []; calls2.sleeps = [];
  const c2 = client(calls2, [res(429, {}), res(429, {}), res(429, {}), res(429, {})], { backoffMs: [1, 2, 3] });
  await assert.rejects(c2.listDomains(), (e) => e.code === 'rate');
  assert.equal(calls2.length, 4);
});

test('when remaining hits zero the client sleeps for the reset window before the next call', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(200, [], { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }), res(200, [])]);
  await c.listDomains(); await c.listDomains();
  assert.deepEqual(calls.sleeps, [1000]);
});

test('writes are not retried on 5xx, reads are', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(503, 'down'), res(200, [])], { backoffMs: [1] });
  assert.deepEqual(await c.listDomains(), []);
  const calls2 = []; calls2.sleeps = [];
  const c2 = client(calls2, [res(503, 'down')], { backoffMs: [1] });
  await assert.rejects(c2.createLink({}), (e) => e.code === 'transient');
  assert.equal(calls2.length, 1);
});

test('rateInfo and classify helpers', () => {
  assert.deepEqual(rateInfo({ get: (k) => ({ 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1' })[k] }), { limit: 50, remaining: 3, reset: 1 });
  assert.throws(() => classify({ status: 500, body: { message: 'boom' }, endpoint: 'x' }), (e) => e.code === 'transient');
  assert.equal(classify({ status: 200, body: { ok: 1 }, endpoint: 'x' }).ok, 1);
});

test('a 429 with a huge reset window is capped at the maximum pace', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(429, {}, { 'x-ratelimit-reset': '900' }), res(200, [])], { backoffMs: [100, 200, 300] });
  assert.deepEqual(await c.listDomains(), []);
  assert.deepEqual(calls.sleeps, [MAX_PACE_MS]);
});

test('a 429 carrying remaining 0 sleeps exactly once', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(429, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2' }), res(200, [])], { backoffMs: [100, 200, 300] });
  assert.deepEqual(await c.listDomains(), []);
  assert.deepEqual(calls.sleeps, [2000]);
});

test('a drained create bucket does not pace a listing call, and its own pace is capped', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [
    res(200, { idString: 'link_1' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '900' }),
    res(200, []),
    res(200, { idString: 'link_2' }),
  ]);
  await c.createLink({ domain: 'go.example.com', originalURL: 'https://example.com/' });
  await c.listDomains();
  assert.deepEqual(calls.sleeps, []);
  await c.createLink({ domain: 'go.example.com', originalURL: 'https://example.com/2' });
  assert.deepEqual(calls.sleeps, [MAX_PACE_MS]);
  assert.equal(MAX_PACE_MS, 60000);
});

test('the pre-request pace is per family and clears after use', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [
    res(200, { idString: 'link_1' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }),
    res(200, { idString: 'link_1' }),
    res(200, { idString: 'link_1' }),
  ]);
  await c.expand('go.example.com', 'slug');
  await c.getLink('link_1');
  assert.deepEqual(calls.sleeps, [1000]);
  await c.getLink('link_1');
  assert.deepEqual(calls.sleeps, [1000]);
});

test('a timeout maps to code timeout, with no retry and no sleep', async () => {
  const calls = []; calls.sleeps = [];
  const c = new ShortIoClient({
    key: 'sk_T', backoffMs: [1, 2, 3],
    sleep: async (ms) => { calls.sleeps.push(ms); },
    fetch: async (url, init) => { calls.push({ url, init }); const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
  });
  await assert.rejects(c.listDomains(), (e) => e.code === 'timeout' && /did not answer/.test(e.message));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls.sleeps, []);
});

test('a non-JSON 200 body maps to unknown', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(200, '<html>maintenance</html>')]);
  await assert.rejects(c.listDomains(), (e) => e.code === 'unknown' && /Non-JSON response/.test(e.message));
});

test('linksByUrl unwraps both the wrapped and the bare array shape', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(200, { links: [{ idString: 'link_1' }] }), res(200, [{ idString: 'link_2' }]), res(200, {})]);
  assert.deepEqual(await c.linksByUrl('go.example.com', 'https://example.com/'), [{ idString: 'link_1' }]);
  assert.deepEqual(await c.linksByUrl('go.example.com', 'https://example.com/'), [{ idString: 'link_2' }]);
  assert.deepEqual(await c.linksByUrl('go.example.com', 'https://example.com/'), []);
});

test('linksByUrl reads a 404 "No links found" as no links', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(404, { error: 'No links found' })]);
  assert.deepEqual(await c.linksByUrl('go.example.com', 'https://example.com/new'), []);
});

test('linksByUrl still throws on any other 404', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(404, { error: 'Domain not found' })]);
  await assert.rejects(c.linksByUrl('nope.example.com', 'https://example.com/new'), (e) => e.code === 'not_found' && /Domain not found/.test(e.message));
});

test('a 403 is auth', async () => {
  const calls = []; calls.sleeps = [];
  const c = client(calls, [res(403, { error: 'Forbidden' })]);
  await assert.rejects(c.listDomains(), (e) => e.code === 'auth');
});
