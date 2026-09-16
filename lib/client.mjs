export class ShortIoError extends Error {
  constructor(code, message, meta = {}) { super(message); Object.assign(this, meta); this.name = 'ShortIoError'; this.code = code; }
}

const TRANSIENT = new Set([500, 502, 503, 504]);
export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_PACE_MS = 60000;

// Short.io meters per endpoint family (listing 1000, creation 50, link info and delete 20),
// so the pacing state is kept per family and never shared across them.
export function familyOf(method, endpoint) {
  const path = String(endpoint).replace(/^\/+/, '');
  if (path.startsWith('api/')) return 'listing';
  if (String(method).toUpperCase() === 'POST' && path.startsWith('links')) return 'create';
  return 'info';
}

function messageOf(body) {
  if (!body || typeof body !== 'object') return '';
  return String(body.message ?? body.error ?? '');
}

export function rateInfo(headers) {
  const n = (k) => { const v = headers?.get?.(k); return v === null || v === undefined || v === '' ? null : Number(v); };
  return { limit: n('x-ratelimit-limit'), remaining: n('x-ratelimit-remaining'), reset: n('x-ratelimit-reset') };
}

export function classify({ status, body, text = '', endpoint }) {
  if (TRANSIENT.has(status)) throw new ShortIoError('transient', `HTTP ${status} from ${endpoint}`, { status, retryable: true, endpoint });
  if (status === 429) throw new ShortIoError('rate', `Rate limited on ${endpoint}`, { status, retryable: true, endpoint });
  if (body === undefined) throw new ShortIoError('unknown', `Non-JSON response (HTTP ${status}) from ${endpoint}: ${String(text).replace(/\s+/g, ' ').slice(0, 120)}`, { status, endpoint });
  const msg = messageOf(body);
  if (status === 401 || status === 403) throw new ShortIoError('auth', `Short.io rejected the request (HTTP ${status}) on ${endpoint}. The header must be the bare key (Authorization: sk_...), never Bearer, and pk_ public keys are refused.`, { status, endpoint, body });
  if (status === 404) throw new ShortIoError('not_found', `${endpoint}: ${msg || 'HTTP 404'}`, { status, endpoint, body });
  if (status === 409) throw new ShortIoError('conflict', `${endpoint}: ${msg || 'HTTP 409'}`, { status, endpoint, body });
  if (status === 400 || status === 422) throw new ShortIoError('validation', `${endpoint}: ${msg || `HTTP ${status}`}`, { status, endpoint, body });
  if (status >= 400) throw new ShortIoError('unknown', `${endpoint}: HTTP ${status} ${msg}`.trim(), { status, endpoint, body });
  return body;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ShortIoClient {
  constructor({ key, fetch = globalThis.fetch, sleep = defaultSleep, backoffMs = [1000, 3000, 9000], baseUrl = 'https://api.short.io', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!key) throw new ShortIoError('config', 'ShortIoClient needs an API key');
    Object.defineProperty(this, 'key', { value: key, enumerable: false });
    this.fetch = fetch; this.sleep = sleep; this.backoffMs = backoffMs; this.baseUrl = baseUrl.replace(/\/+$/, ''); this.timeoutMs = timeoutMs;
    this.rate = Object.create(null);   // family -> {limit, remaining, reset} from its most recent answer
  }

  async #send(url, init, endpoint, retry, family) {
    let attempt = 0;
    for (;;) {
      const paced = this.rate[family];
      if (paced && paced.remaining === 0 && paced.reset) { this.rate[family] = null; await this.sleep(Math.min(paced.reset * 1000, MAX_PACE_MS)); }
      let res; let text;
      try {
        res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        text = await res.text();
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new ShortIoError('timeout', `${endpoint} did not answer within ${this.timeoutMs} ms`, { endpoint });
        if (retry && attempt < this.backoffMs.length) { await this.sleep(this.backoffMs[attempt++]); continue; }
        throw new ShortIoError('transient', `Network error calling ${endpoint}: ${error.message}`, { retryable: true, endpoint });
      }
      const rate = rateInfo(res.headers);
      this.rate[family] = rate;
      if (res.status === 429 && attempt < this.backoffMs.length) {
        const wait = rate.reset ? rate.reset * 1000 : this.backoffMs[attempt];
        this.rate[family] = null;   // the wait below is the whole pause, the pre-request guard must not repeat it
        attempt++; await this.sleep(wait); continue;
      }
      if (TRANSIENT.has(res.status) && retry && attempt < this.backoffMs.length) { await this.sleep(this.backoffMs[attempt++]); continue; }
      let body; try { body = JSON.parse(text); } catch { body = undefined; }
      return { status: res.status, body, text };
    }
  }

  async request(method, endpoint, { query, body } = {}) {
    const url = new URL(`${this.baseUrl}/${endpoint.replace(/^\/+/, '')}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { authorization: this.key, accept: 'application/json' };
    const init = { method, headers };
    if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await this.#send(url.toString(), init, endpoint, String(method).toUpperCase() === 'GET', familyOf(method, endpoint));
    return classify({ ...res, endpoint });
  }

  listDomains() { return this.request('GET', 'api/domains'); }
  listLinks({ domainId, limit = 150, pageToken } = {}) { return this.request('GET', 'api/links', { query: { domain_id: domainId, limit, pageToken } }); }
  async expand(domain, path) {
    try { return await this.request('GET', 'links/expand', { query: { domain, path } }); }
    catch (e) { if (e.code === 'not_found') return null; throw e; }
  }
  async linksByUrl(domain, originalURL) {
    const out = await this.request('GET', 'links/multiple-by-url', { query: { domain, originalURL } });
    return Array.isArray(out?.links) ? out.links : Array.isArray(out) ? out : [];
  }
  getLink(idString) { return this.request('GET', `links/${encodeURIComponent(idString)}`); }
  createLink(body) { return this.request('POST', 'links', { body }); }
  deleteLink(idString) { return this.request('DELETE', `links/${encodeURIComponent(idString)}`); }
}
