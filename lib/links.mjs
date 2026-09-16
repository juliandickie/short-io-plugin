import { ShortIoError } from './client.mjs';

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

export async function resolveDomain(client, hostnameOrId) {
  const want = String(hostnameOrId ?? '').trim().toLowerCase();
  const domains = await client.listDomains();
  const hit = domains.find((d) => String(d.id) === want || String(d.hostname).toLowerCase() === want);
  if (!hit) throw new ShortIoError('usage', `No domain "${hostnameOrId}" on this account. Domains: ${domains.map((d) => `${d.hostname} (${d.id})`).join(', ') || 'none'}`);
  return { id: hit.id, hostname: hit.hostname, linkType: hit.linkType, redirect404: hit.redirect404 ?? null };
}

export async function listAllLinks(client, domainId, { onPage = () => {}, limit = 150 } = {}) {
  const links = []; let count = null; let pageToken;
  for (;;) {
    const page = await client.listLinks({ domainId, limit, pageToken });
    count = page.count ?? count;
    links.push(...(page.links ?? []));
    onPage(page);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return { count: count ?? links.length, links };
}

export function normaliseTags(value) {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

function validUrl(u) { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } }

export async function classifyCreate(client, { domain, originalURL, path }) {
  if (!validUrl(originalURL)) return { action: 'invalid', reason: 'originalURL is not an http(s) URL' };
  if (path) {
    const existing = await client.expand(domain, path);
    if (existing) return existing.originalURL === originalURL ? { action: 'exists', existing } : { action: 'taken', existing };
  }
  const same = await client.linksByUrl(domain, originalURL);
  if (same.length) return { action: 'duplicate', existing: same[0], all: same };
  return { action: 'create' };
}

export async function createOne(client, spec, { allowDuplicate = false, now = () => new Date() } = {}) {
  const { domain, originalURL } = spec;
  const path = spec.path ? String(spec.path).trim() : '';
  const verdict = await classifyCreate(client, { domain, originalURL, path });
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
  // The API answers 200 with the EXISTING record for a repeated (path, url) or a repeated
  // url with no path. A createdAt older than this call means nothing was created.
  const created = link?.createdAt ? Date.parse(link.createdAt) : NaN;
  if (Number.isFinite(created) && created < started - 5000) return { action: 'exists', link };
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
