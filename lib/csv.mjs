export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false; const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const out = rows.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  return { header, rows: out };
}

const q = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(columns, rows) {
  return `${columns.join(',')}\n${rows.map((r) => columns.map((c) => q(r[c])).join(',')).join('\n')}${rows.length ? '\n' : ''}`;
}
