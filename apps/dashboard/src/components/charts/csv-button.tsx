'use client';

import { downloadCsv } from '@/lib/csv';

interface CsvButtonProps {
  filename: string;
  getRows: () => ReadonlyArray<object>;
  disabled?: boolean;
}

export function CsvButton({ filename, getRows, disabled }: CsvButtonProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (disabled) return;
        const rows = getRows();
        if (rows.length === 0) return;
        downloadCsv(filename, rows);
      }}
      disabled={disabled}
      title="Exportar como CSV"
      className="inline-flex h-7 w-7 items-center justify-center rounded text-gray-text transition-colors hover:bg-cream-warm hover:text-navy disabled:cursor-not-allowed disabled:opacity-40"
      aria-label="Exportar CSV"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.5v8m0 0L4.5 6m3.5 3.5L11.5 6M2.5 11v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
