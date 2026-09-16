// Rows carry the physical 1-based line they start on (header is line 1) so a blank or
// dropped line never shifts the row numbers a bulk report points the user at.
export function parseCsv(text) {
  const records = []; let row = []; let field = ''; let quoted = false; const s = String(text ?? '');
  let line = 1; let start = 1; let started = false;
  const begin = () => { if (!started) { start = line; started = true; } };
  const endRecord = () => { row.push(field); records.push({ fields: row, line: start }); row = []; field = ''; started = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else { if (c === '\n') line++; field += c; }
      continue;
    }
    begin();
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { endRecord(); line++; continue; }
    field += c;
  }
  if (field !== '' || row.length) { begin(); endRecord(); }
  const head = records.shift() ?? { fields: [], line: 1 };
  const header = head.fields.map((h) => h.trim().toLowerCase());
  const kept = records.filter((r) => r.fields.some((v) => v !== ''));
  const rows = kept.map((r) => Object.fromEntries(header.map((h, i) => [h, r.fields[i] ?? ''])));
  return { header, rows, lines: kept.map((r) => r.line) };
}

const q = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(columns, rows) {
  return `${columns.join(',')}\n${rows.map((r) => columns.map((c) => q(r[c])).join(',')).join('\n')}${rows.length ? '\n' : ''}`;
}
