import { randomBytes } from 'node:crypto';

const defaultRandom = () => `zz-probe-${randomBytes(6).toString('hex')}`;

export async function probeLive(fetch, url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, location: res.headers?.get?.('location') ?? null };
}

export async function probeFallback(fetch, hostname, { random = defaultRandom } = {}) {
  const probedPath = random();
  const { status, location } = await probeLive(fetch, `https://${hostname}/${probedPath}`);
  return { hasFallback: status >= 300 && status < 400, status, location, probedPath };
}

function sameUrl(a, b) {
  if (!a || !b) return false;
  const norm = (u) => { try { const x = new URL(u); x.hash = ''; return x.toString().replace(/\/$/, ''); } catch { return String(u); } };
  return norm(a) === norm(b);
}

export async function checkSlug(client, { domain, path }, { fetch = globalThis.fetch, random = defaultRandom } = {}) {
  const record = await client.expand(domain, path);
  const configured = record?.originalURL ?? null;
  const live = await probeLive(fetch, `https://${domain}/${path}`);
  const fallback = await probeFallback(fetch, domain, { random });
  let verdict;
  if (!record) verdict = live.status >= 300 && live.status < 400 ? 'free-but-redirects' : 'free';
  else verdict = sameUrl(live.location, configured) || (live.status >= 300 && live.status < 400 && !fallback.hasFallback) ? 'ok' : (live.location && !sameUrl(live.location, configured) ? 'mismatch' : 'ok');
  return { domain, path, configured, idString: record?.idString ?? null, title: record?.title ?? null, live, fallback, verdict };
}
