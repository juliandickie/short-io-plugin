import { randomBytes } from 'node:crypto';
import { sameUrl } from './links.mjs';

const defaultRandom = () => `zz-probe-${randomBytes(6).toString('hex')}`;

const isRedirect = (status) => status >= 300 && status < 400;

// A probe that cannot reach the server is data, not a crash - the caller still wants the
// configured destination and the verdict, so a thrown fetch becomes status 0 plus an error string.
export async function probeLive(fetch, url, { timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { status: 0, location: null, error: `${url}: ${e?.message ?? e}` };
  }
  return { status: res.status, location: res.headers?.get?.('location') ?? null };
}

export async function probeFallback(fetch, hostname, { random = defaultRandom } = {}) {
  const probedPath = random();
  const { status, location, error } = await probeLive(fetch, `https://${hostname}/${probedPath}`);
  const out = { hasFallback: isRedirect(status), status, location, probedPath };
  return error ? { ...out, error } : out;
}

export async function checkSlug(client, { domain, path }, { fetch = globalThis.fetch, random = defaultRandom, fallback: knownFallback } = {}) {
  const record = await client.expand(domain, path);
  const configured = record?.originalURL ?? null;
  const live = await probeLive(fetch, `https://${domain}/${path}`);
  const fallback = knownFallback ?? await probeFallback(fetch, domain, { random });
  const redirected = isRedirect(live.status);
  const served2xx = live.status >= 200 && live.status < 300;
  let verdict; let served = null;
  if (!record && redirected) verdict = 'free-but-redirects';
  else if (!record) verdict = 'free';
  else if (redirected && live.location && sameUrl(live.location, configured)) { verdict = 'ok'; served = 'redirect'; }
  else if (redirected && live.location) verdict = 'mismatch';
  // Cloaked and password-protected links serve a page of their own instead of redirecting,
  // so a 2xx on one of those is the configured behaviour, not a dead slug.
  else if (served2xx && record.cloaking === true) { verdict = 'ok'; served = 'cloaked'; }
  else if (served2xx && record.hasPassword === true) { verdict = 'ok'; served = 'password'; }
  else verdict = 'not-resolving';
  return { domain, path, configured, served, idString: record?.idString ?? null, title: record?.title ?? null, live, fallback, verdict };
}
