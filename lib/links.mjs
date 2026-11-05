import { ShortIoError } from './client.mjs';

// A record whose createdAt is older than this before the POST was sent is treated as
// pre-existing. Identity is the primary signal, this is only a backstop.
export const STALE_MS = 60000;

export function parseTarget(input, defaultDomain) {
  let s = String(input ?? '').trim();
  if (/^https?:\/\//i.test(s)) { const u = new URL(s); s = `${u.hostname}${u.pathname}`; }
  const m = s.match(/^([^/\s]+)\/(.*)$/);
  let domain; let path;
  if (m) { domain = m[1].toLowerCase(); path = m[2]; }
  else { if (!defaultDomain) throw new ShortIoError('usage', `Give the target as domain/slug or a short URL, or pass --domain (got "${input}")`); domain = String(defaultDomain).toLowerCase(); path = s; }
  path = path.replace(/^\/+/, '').split(/[?#]/)[0];
  if (!path) throw new ShortIoError('usage', `No slug in "${input}"`);
  return { domain, path };
}

export function matchDomain(domains, hostnameOrId) {
  if (!Array.isArray(domains)) throw new ShortIoError('unknown', 'listDomains did not return an array');
  const want = String(hostnameOrId ?? '').trim().toLowerCase();
  const hit = domains.find((d) => String(d.id) === want || String(d.hostname).toLowerCase() === want);
  return hit ? { id: hit.id, hostname: hit.hostname, linkType: hit.linkType, redirect404: hit.redirect404 ?? null } : null;
}

export async function resolveDomain(client, hostnameOrId) {
  const domains = await client.listDomains();
  const hit = matchDomain(domains, hostnameOrId);
  if (!hit) throw new ShortIoError('usage', `No domain "${hostnameOrId}" on this account. Domains: ${listDomainNames(domains)}`);
  return hit;
}

export function listDomainNames(domains) {
  return domains.map((d) => `${d.hostname} (${d.id})`).join(', ') || 'none';
}

export async function listAllLinks(client, domainId, { onPage = () => {}, limit = 150 } = {}) {
  const links = []; const seen = new Set(); let count = null; let pageToken;
  for (;;) {
    const page = await client.listLinks({ domainId, limit, pageToken });
    count = page.count ?? count;
    links.push(...(page.links ?? []));
    onPage(page);
    if (!page.nextPageToken) break;
    // Every token ever handed back is remembered, so an A, B, A cycle is caught as surely as
    // a token that repeats itself immediately.
    if (seen.has(page.nextPageToken)) throw new ShortIoError('unknown', `listLinks repeated the page token "${page.nextPageToken}", stopping instead of looping`);
    seen.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
  return { count: count ?? links.length, links };
}

export function normaliseTags(value) {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

function validUrl(u) { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } }

// Short.io stores a normalised URL (lowercased host, trailing slash on a bare host), so a raw
// string compare would read the plugin's own link back as a different destination.
export function sameUrl(a, b) {
  try { return new URL(a).href === new URL(b).href; } catch { return a === b; }
}

export async function classifyCreate(client, { domain, originalURL, path }) {
  if (!validUrl(originalURL)) return { action: 'invalid', reason: 'originalURL is not an http(s) URL', known: [] };
  if (path) {
    const existing = await client.expand(domain, path);
    if (existing) {
      const known = existing.idString ? [existing.idString] : [];
      return sameUrl(existing.originalURL, originalURL) ? { action: 'exists', existing, known } : { action: 'taken', existing, known };
    }
  }
  const same = await client.linksByUrl(domain, originalURL);
  const known = same.map((l) => l?.idString).filter(Boolean);
  if (same.length) return { action: 'duplicate', existing: same[0], all: same, known };
  return { action: 'create', known };
}

// A caller that has already classified the row (planBulk) passes its verdict straight
// through, so a bulk run spends one metered call per link instead of re-checking each one.
export async function createOne(client, spec, { allowDuplicate = false, now = () => new Date(), verdict: given = null } = {}) {
  const { domain, originalURL } = spec;
  const path = spec.path ? String(spec.path).trim() : '';
  const verdict = given ?? await classifyCreate(client, { domain, originalURL, path });
  if (verdict.action === 'invalid') return { action: 'invalid', reason: verdict.reason };
  if (verdict.action === 'exists') return { action: 'exists', link: verdict.existing };
  if (verdict.action === 'taken') return { action: 'taken', link: verdict.existing };
  if (verdict.action === 'duplicate' && !allowDuplicate) return { action: 'duplicate', link: verdict.existing, all: verdict.all };
  const body = { domain, originalURL };
  if (path) body.path = path;
  if (spec.title && String(spec.title).trim()) body.title = String(spec.title).trim();
  const tags = normaliseTags(spec.tags);
  if (tags.length) body.tags = tags;
  const started = now().getTime();
  const link = await client.createLink(body);
  // The API answers 200 with the EXISTING record for a repeated (path, url) or a repeated url
  // with no path. An id we already saw before the POST means nothing was created, whatever the
  // timestamps say. A clearly old createdAt is the secondary signal.
  const known = verdict.known ?? [];
  if (link?.idString && known.includes(link.idString)) return { action: 'exists', link };
  const created = link?.createdAt ? Date.parse(link.createdAt) : NaN;
  if (Number.isFinite(created) && created < started - STALE_MS) return { action: 'exists', link };
  return { action: 'created', link };
}

export async function deleteBySlug(client, domain, path) {
  const existing = await client.expand(domain, path);
  if (!existing) throw new ShortIoError('not_found', `${domain}/${path} does not exist`);
  await client.deleteLink(existing.idString);
  const after = await client.expand(domain, path);
  if (after) throw new ShortIoError('unknown', `${domain}/${path} still resolves after delete`);
  return { deleted: existing.idString };
}
