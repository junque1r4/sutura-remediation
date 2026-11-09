function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows: ReadonlyArray<object>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    const rec = row as Record<string, unknown>;
    lines.push(headers.map((h) => escapeCell(rec[h])).join(','));
  }
  return lines.join('\n');
}

export function downloadCsv(filename: string, rows: ReadonlyArray<object>): void {
  if (typeof window === 'undefined') return;
  const csv = rowsToCsv(rows);
  // Prepend UTF-8 BOM so Excel detects encoding correctly.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
