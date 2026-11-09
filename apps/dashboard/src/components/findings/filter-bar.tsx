'use client';

import { useMemo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { Finding } from '@/types';
import type { FindingFilters } from '@/lib/findings-utils';
import { hasActiveFilters, emptyFilters } from '@/lib/findings-utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FindingsFilterBarProps {
  findings: Finding[];
  filters: FindingFilters;
  onFiltersChange: (filters: FindingFilters) => void;
  showAdvisory: boolean;
  onShowAdvisoryChange: (v: boolean) => void;
}

// ---------------------------------------------------------------------------
// Filter definitions
// ---------------------------------------------------------------------------

interface FilterDef {
  key: keyof FindingFilters;
  label: string;
  options: (findings: Finding[]) => string[];
  formatOption?: (val: string) => string;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const STATUS_ORDER = ['open', 'fixing', 'fixed', 'wont_fix', 'failed'];

const FILTER_DEFS: FilterDef[] = [
  {
    key: 'severity',
    label: 'Severity',
    options: () => SEVERITY_ORDER,
    formatOption: (v) => v.charAt(0).toUpperCase() + v.slice(1),
  },
  {
    key: 'scannerSource',
    label: 'Scanner',
    options: (findings) => [...new Set(findings.map((f) => f.scannerSource))].sort(),
  },
  {
    key: 'status',
    label: 'Status',
    options: () => STATUS_ORDER,
    formatOption: (v) =>
      v === 'wont_fix' ? "Won't Fix" : v.charAt(0).toUpperCase() + v.slice(1),
  },
  {
    key: 'repo',
    label: 'Repo',
    options: (findings) => [...new Set(findings.map((f) => f.repo))].sort(),
  },
  {
    key: 'cwe',
    label: 'CWE',
    options: (findings) =>
      [...new Set(findings.map((f) => f.cweId).filter((c): c is string => Boolean(c)))].sort(),
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FindingsFilterBar({
  findings,
  filters,
  onFiltersChange,
  showAdvisory,
  onShowAdvisoryChange,
}: FindingsFilterBarProps) {
  const active = hasActiveFilters(filters);

  function toggleValue(filterKey: keyof FindingFilters, value: string) {
    const current = filters[filterKey];
    const next = new Set(current);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    onFiltersChange({ ...filters, [filterKey]: next });
  }

  function removeValue(filterKey: keyof FindingFilters, value: string) {
    const next = new Set(filters[filterKey]);
    next.delete(value);
    onFiltersChange({ ...filters, [filterKey]: next });
  }

  function clearAll() {
    onFiltersChange(emptyFilters());
  }

  // Collect all active pills
  const pills = useMemo(() => {
    const result: { filterKey: keyof FindingFilters; value: string; label: string }[] = [];
    for (const def of FILTER_DEFS) {
      for (const value of filters[def.key]) {
        const formatted = def.formatOption ? def.formatOption(value) : value;
        result.push({ filterKey: def.key, value, label: `${def.label}: ${formatted}` });
      }
    }
    return result;
  }, [filters]);

  return (
    <div className="mb-4 space-y-2">
      {/* Filter buttons row */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_DEFS.map((def) => (
          <MultiSelectDropdown
            key={def.key}
            label={def.label}
            options={def.options(findings)}
            selected={filters[def.key]}
            formatOption={def.formatOption}
            onToggle={(value) => toggleValue(def.key, value)}
          />
        ))}
        {active && (
          <button
            onClick={clearAll}
            className="rounded px-2.5 py-1.5 text-xs font-medium text-gray-text hover:bg-cream-warm hover:text-navy"
          >
            Clear all
          </button>
        )}
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded border border-border bg-white px-3 py-1.5 text-xs font-medium text-navy hover:bg-cream-warm">
          <input
            type="checkbox"
            checked={showAdvisory}
            onChange={(e) => onShowAdvisoryChange(e.target.checked)}
            className="h-3.5 w-3.5 accent-orange"
          />
          Show advisory (container/OS)
        </label>
      </div>

      {/* Active filter pills */}
      {pills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pills.map((pill) => (
            <span
              key={`${pill.filterKey}-${pill.value}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-cream-warm px-2.5 py-0.5 text-xs text-navy"
            >
              {pill.label}
              <button
                onClick={() => removeValue(pill.filterKey, pill.value)}
                className="ml-0.5 text-gray-text hover:text-navy"
                aria-label={`Remove filter ${pill.label}`}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MultiSelectDropdown
// ---------------------------------------------------------------------------

interface MultiSelectDropdownProps {
  label: string;
  options: string[];
  selected: Set<string>;
  formatOption?: (val: string) => string;
  onToggle: (value: string) => void;
}

function MultiSelectDropdown({
  label,
  options,
  selected,
  formatOption,
  onToggle,
}: MultiSelectDropdownProps) {
  const count = selected.size;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded border border-border bg-white px-3 py-1.5 text-xs font-medium text-navy hover:bg-cream-warm">
          {label}
          {count > 0 && (
            <span className="rounded-full bg-orange px-1.5 text-[10px] font-semibold text-white">
              {count}
            </span>
          )}
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className="ml-0.5 opacity-50">
            <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 min-w-[180px] rounded-md border border-border bg-white p-1 shadow-lg"
          sideOffset={4}
          align="start"
        >
          {options.map((option) => (
            <DropdownMenu.CheckboxItem
              key={option}
              checked={selected.has(option)}
              onCheckedChange={() => onToggle(option)}
              onSelect={(e) => e.preventDefault()}
              className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-xs text-navy outline-none hover:bg-cream-warm focus:bg-cream-warm"
            >
              <DropdownMenu.ItemIndicator className="flex h-3.5 w-3.5 items-center justify-center">
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </DropdownMenu.ItemIndicator>
              <span className={selected.has(option) ? '' : 'ml-[22px]'}>
                {formatOption ? formatOption(option) : option}
              </span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
