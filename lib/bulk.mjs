import { parseCsv } from './csv.mjs';
import { classifyCreate, createOne } from './links.mjs';
import { ShortIoError } from './client.mjs';

export const RESULT_COLUMNS = ['row', 'url', 'path', 'action', 'short_url', 'id', 'note'];

// `row` is what the user has to look at to find the offending input. For CSV that is the
// physical line number in the file (header included, and a quoted cell spanning several lines
// counts as the line it starts on), for JSON it is the 1-based index in the array.

export function loadSpecs(text, { format }) {
  if (format === 'json') {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new ShortIoError('usage', 'JSON input must be an array of {url, path, title, tags}');
    return arr.map((o, i) => ({ url: String(o.url ?? o.originalURL ?? '').trim(), path: String(o.path ?? '').trim(), title: String(o.title ?? ''), tags: Array.isArray(o.tags) ? o.tags.join(',') : String(o.tags ?? ''), row: i + 1 }));
  }
  const { header, rows, lines } = parseCsv(text);
  if (!header.includes('url')) throw new ShortIoError('usage', `CSV needs a header row with a url column (optional: path, title, tags). Got: ${header.join(', ') || 'nothing'}`);
  return rows.map((r, i) => ({ url: String(r.url ?? '').trim(), path: String(r.path ?? '').trim(), title: String(r.title ?? ''), tags: String(r.tags ?? ''), row: lines[i] ?? i + 2 }));
}

export async function planBulk(client, specs, { domain }) {
  const firstRow = new Map(); const items = []; const counts = {};
  for (const spec of specs) {
    const key = spec.path ? `p:${spec.path}` : `u:${spec.url}`;
    let verdict;
    if (firstRow.has(key)) verdict = { action: 'duplicate-in-file', duplicateOf: firstRow.get(key) };
    else { verdict = await classifyCreate(client, { domain, originalURL: spec.url, path: spec.path }); firstRow.set(key, spec.row); }
    items.push({ ...spec, action: verdict.action, existing: verdict.existing ?? null, known: verdict.known ?? [], duplicateOf: verdict.duplicateOf ?? null, reason: verdict.reason ?? '' });
    counts[verdict.action] = (counts[verdict.action] ?? 0) + 1;
  }
  return { items, counts };
}

// The API answers 200 with the existing record rather than erroring, so a non-created
// outcome after the POST is reported as what it actually was, never as a create.
const POST_NOTES = {
  exists: 'API returned the existing record',
  taken: 'slug held by a different destination',
  duplicate: 'API returned an existing record for this destination',
};

function skipNote(item) {
  if (item.action === 'invalid') return item.reason || 'not an http(s) URL';
  if (item.action === 'duplicate-in-file') return `duplicate of row ${item.duplicateOf} in this file`;
  if (item.action === 'duplicate') return `destination already shortened as ${item.existing?.path ?? 'an existing link'}`;
  if (item.action === 'taken') return 'slug held by a different destination';
  if (item.action === 'exists') return 'slug already points at this destination';
  return '';
}

export async function runBulk(client, plan, { domain, allowDuplicate = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minGapMs = 200, onItem = () => {} } = {}) {
  const results = []; const counts = { created: 0, skipped: 0, failed: 0 }; let first = true;
  for (const item of plan.items) {
    const willCreate = item.action === 'create' || (allowDuplicate && item.action === 'duplicate');
    if (!willCreate) {
      counts.skipped++;
      results.push({ row: item.row, url: item.url, path: item.path, action: item.action, short_url: item.existing?.shortURL ?? '', id: item.existing?.idString ?? '', note: skipNote(item) });
    } else {
      if (!first) await sleep(minGapMs);
      first = false;
      try {
        const out = await createOne(client, { domain, originalURL: item.url, path: item.path, title: item.title, tags: item.tags }, { allowDuplicate, verdict: { action: item.action, known: item.known } });
        const created = out.action === 'created';
        counts[created ? 'created' : 'skipped']++;
        results.push({ row: item.row, url: item.url, path: item.path, action: created ? 'created' : out.action, short_url: out.link?.shortURL ?? '', id: out.link?.idString ?? '', note: created ? '' : POST_NOTES[out.action] ?? `API returned ${out.action}` });
      } catch (error) {
        counts.failed++;
        results.push({ row: item.row, url: item.url, path: item.path, action: 'failed', short_url: '', id: '', note: `${error.code ?? 'error'}: ${error.message}` });
      }
    }
    await onItem(results[results.length - 1]);
  }
  return { results, counts };
}
