import { randomBytes } from 'node:crypto';
import { sameUrl } from './links.mjs';

const defaultRandom = () => `zz-probe-${randomBytes(6).toString('hex')}`;

const isRedirect = (status) => status >= 300 && status < 400;

// What a probed status actually means for the domain. A 3xx and a 2xx are both fallbacks - a
// domain that answers a page for an unknown slug has no 404 either, so a typo fails silently
// there just as it does behind a redirect. Only 404 proves the domain refuses unknown slugs.
export function kindOf(status) {
  if (status === 0) return 'error';
  if (status === 404) return 'notfound';
  if (isRedirect(status)) return 'redirect';
  if (status >= 200 && status < 300) return 'page';
  return 'other';
}

export const FALLBACK_KINDS = ['notfound', 'redirect', 'page', 'other', 'error'];

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
  const kind = kindOf(status);
  const out = { kind, hasFallback: kind === 'redirect' || kind === 'page', status, location, probedPath };
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
  // No record but a 2xx body is still something being served at that slug, which is not the
  // same as a domain that refuses it, so it gets its own verdict rather than a plain 'free'.
  else if (!record && served2xx) verdict = 'free-but-served';
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
