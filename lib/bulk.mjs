import { parseCsv } from './csv.mjs';
import { classifyCreate, createOne } from './links.mjs';
import { ShortIoError } from './client.mjs';

export const RESULT_COLUMNS = ['row', 'url', 'path', 'action', 'short_url', 'id', 'note'];

export function loadSpecs(text, { format }) {
  if (format === 'json') {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new ShortIoError('usage', 'JSON input must be an array of {url, path, title, tags}');
    return arr.map((o, i) => ({ url: String(o.url ?? o.originalURL ?? '').trim(), path: String(o.path ?? '').trim(), title: String(o.title ?? ''), tags: Array.isArray(o.tags) ? o.tags.join(',') : String(o.tags ?? ''), row: i + 1 }));
  }
  const { header, rows } = parseCsv(text);
  if (!header.includes('url')) throw new ShortIoError('usage', `CSV needs a header row with a url column (optional: path, title, tags). Got: ${header.join(', ') || 'nothing'}`);
  return rows.map((r, i) => ({ url: String(r.url ?? '').trim(), path: String(r.path ?? '').trim(), title: String(r.title ?? ''), tags: String(r.tags ?? ''), row: i + 2 }));
}

export async function planBulk(client, specs, { domain }) {
  const seenPath = new Set(); const seenUrl = new Set(); const items = []; const counts = {};
  for (const spec of specs) {
    let verdict;
    if ((spec.path && seenPath.has(spec.path)) || (!spec.path && seenUrl.has(spec.url))) verdict = { action: 'duplicate-in-file' };
    else verdict = await classifyCreate(client, { domain, originalURL: spec.url, path: spec.path });
    if (spec.path) seenPath.add(spec.path); else seenUrl.add(spec.url);
    items.push({ ...spec, action: verdict.action, existing: verdict.existing ?? null, reason: verdict.reason ?? '' });
    counts[verdict.action] = (counts[verdict.action] ?? 0) + 1;
  }
  return { items, counts };
}

export async function runBulk(client, plan, { domain, allowDuplicate = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minGapMs = 200, onItem = () => {} }) {
  const results = []; const counts = { created: 0, skipped: 0, failed: 0 }; let first = true;
  for (const item of plan.items) {
    const willCreate = item.action === 'create' || (allowDuplicate && item.action === 'duplicate');
    if (!willCreate) {
      counts.skipped++;
      results.push({ row: item.row, url: item.url, path: item.path, action: item.action, short_url: item.existing?.shortURL ?? '', id: item.existing?.idString ?? '', note: item.reason || (item.existing ? `existing ${item.existing.path ?? ''}`.trim() : '') });
      continue;
    }
    if (!first) await sleep(minGapMs);
    first = false;
    try {
      const out = await createOne(client, { domain, originalURL: item.url, path: item.path, title: item.title, tags: item.tags }, { allowDuplicate: true });
      const created = out.action === 'created';
      counts[created ? 'created' : 'skipped']++;
      results.push({ row: item.row, url: item.url, path: item.path, action: created ? 'created' : out.action, short_url: out.link?.shortURL ?? '', id: out.link?.idString ?? '', note: created ? '' : 'API returned an existing record' });
    } catch (error) {
      counts.failed++;
      results.push({ row: item.row, url: item.url, path: item.path, action: 'failed', short_url: '', id: '', note: error.message });
    }
    onItem(results[results.length - 1]);
  }
  return { results, counts };
}
