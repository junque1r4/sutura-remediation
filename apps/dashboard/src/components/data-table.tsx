'use client';

import { useRouter } from 'next/navigation';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  sortable?: boolean;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowHref?: (row: T) => string;
  currentPage?: number;
  totalPages?: number;
  baseUrl?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  activeSortKey?: string;
  activeSortDirection?: 'asc' | 'desc';
}

export function DataTable<T>({
  columns,
  data,
  rowHref,
  currentPage = 1,
  totalPages = 1,
  baseUrl,
  sortBy,
  sortOrder = 'asc',
  onSort,
  activeSortKey,
  activeSortDirection,
}: DataTableProps<T>) {
  const router = useRouter();

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full min-w-[800px]">
        <thead>
          <tr className="border-b border-border bg-cream-warm">
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-gray-text"
                style={col.width ? { width: col.width } : undefined}
              >
                {col.sortable && onSort ? (
                  <button
                    onClick={() => onSort(col.key)}
                    className="flex items-center gap-1 hover:text-navy"
                  >
                    {col.header}
                    {activeSortKey === col.key && (
                      <span>{activeSortDirection === 'asc' ? '\u2191' : '\u2193'}</span>
                    )}
                  </button>
                ) : col.sortable && baseUrl ? (
                  <a
                    href={`${baseUrl}?sortBy=${col.key}&sortOrder=${sortBy === col.key && sortOrder === 'asc' ? 'desc' : 'asc'}&page=${currentPage}`}
                    className="hover:text-navy"
                  >
                    {col.header}
                    {sortBy === col.key && (
                      <span className="ml-1">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>
                    )}
                  </a>
                ) : (
                  col.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-gray-text">
                No data found
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <tr
                key={i}
                onClick={rowHref ? () => router.push(rowHref(row)) : undefined}
                className={`border-b border-border-light text-sm text-navy transition-colors last:border-b-0 ${
                  rowHref ? 'cursor-pointer hover:bg-cream-warm' : ''
                }`}
              >
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-3">
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Pagination */}
      {totalPages > 1 && baseUrl && (
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-xs text-gray-text">
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex gap-2">
            {currentPage > 1 && (
              <a
                href={`${baseUrl}?page=${currentPage - 1}${sortBy ? `&sortBy=${sortBy}&sortOrder=${sortOrder}` : ''}`}
                className="rounded border border-border px-3 py-1 text-xs text-gray-text hover:bg-cream-warm"
              >
                Previous
              </a>
            )}
            {currentPage < totalPages && (
              <a
                href={`${baseUrl}?page=${currentPage + 1}${sortBy ? `&sortBy=${sortBy}&sortOrder=${sortOrder}` : ''}`}
                className="rounded border border-border px-3 py-1 text-xs text-gray-text hover:bg-cream-warm"
              >
                Next
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
