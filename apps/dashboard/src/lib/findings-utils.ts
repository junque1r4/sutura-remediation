import { classifyRemediationClass } from '@sutura/common';
import type { Finding } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UrgencyLevel = 'normal' | 'low-concern' | 'warning' | 'urgent';

export interface FindingFilters {
  severity: Set<string>;
  scannerSource: Set<string>;
  status: Set<string>;
  repo: Set<string>;
  cwe: Set<string>;
}

// ---------------------------------------------------------------------------
// Age urgency
// ---------------------------------------------------------------------------

export function getAgeUrgency(
  severity: Finding['severity'],
  status: Finding['status'],
  ingestedAt: string,
): UrgencyLevel {
  if (status === 'fixed' || status === 'wont_fix') return 'low-concern';

  const daysOpen = Math.floor((Date.now() - new Date(ingestedAt).getTime()) / 86_400_000);

  switch (severity) {
    case 'critical':
      if (daysOpen <= 3) return 'warning';
      return 'urgent';
    case 'high':
      if (daysOpen <= 7) return 'normal';
      if (daysOpen <= 14) return 'warning';
      return 'urgent';
    case 'medium':
      if (daysOpen <= 14) return 'normal';
      if (daysOpen <= 30) return 'warning';
      return 'urgent';
    case 'low':
      if (daysOpen <= 30) return 'low-concern';
      if (daysOpen <= 60) return 'normal';
      return 'warning';
    default:
      return 'normal';
  }
}

export function getAgeUrgencyClasses(level: UrgencyLevel): string {
  switch (level) {
    case 'low-concern':
      return 'text-status-success';
    case 'warning':
      return 'text-orange font-medium';
    case 'urgent':
      return 'text-severity-critical font-bold';
    case 'normal':
    default:
      return 'text-gray-text';
  }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK: Record<string, number> = { open: 0, fixing: 1, fixed: 2, wont_fix: 3, failed: 4 };

export function sortFindings(
  findings: Finding[],
  sortKey: string,
  sortDirection: 'asc' | 'desc',
): Finding[] {
  const dir = sortDirection === 'asc' ? 1 : -1;

  return [...findings].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'title':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'severity':
        cmp = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
        break;
      case 'repo':
        cmp = a.repo.localeCompare(b.repo);
        break;
      case 'scannerSource':
        cmp = a.scannerSource.localeCompare(b.scannerSource);
        break;
      case 'status':
        cmp = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
        break;
      case 'ingestedAt':
        cmp = new Date(a.ingestedAt).getTime() - new Date(b.ingestedAt).getTime();
        break;
      default:
        cmp = 0;
    }
    return cmp * dir;
  });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter findings by the active set-based filters. Cross-scanner duplicates
 * (findings with `duplicateOf` set) are hidden by default so each underlying
 * issue shows once; pass `showDuplicates = true` to reveal them. Advisory
 * findings (container/OS, no code repo to patch) are likewise hidden by
 * default; pass `showAdvisory = true` to reveal them.
 */
export function filterFindings(
  findings: Finding[],
  filters: FindingFilters,
  showDuplicates = false,
  showAdvisory = false,
): Finding[] {
  return findings.filter((f) => {
    if (!showDuplicates && f.duplicateOf) return false;
    if (!showAdvisory && classifyRemediationClass({ repo: f.repo, rawPayload: f.rawPayload }) === 'advisory') return false;
    if (filters.severity.size > 0 && !filters.severity.has(f.severity)) return false;
    if (filters.scannerSource.size > 0 && !filters.scannerSource.has(f.scannerSource)) return false;
    if (filters.status.size > 0 && !filters.status.has(f.status)) return false;
    if (filters.repo.size > 0 && !filters.repo.has(f.repo)) return false;
    if (filters.cwe.size > 0 && (!f.cweId || !filters.cwe.has(f.cweId))) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Empty filters helper
// ---------------------------------------------------------------------------

export function emptyFilters(): FindingFilters {
  return {
    severity: new Set(),
    scannerSource: new Set(),
    status: new Set(),
    repo: new Set(),
    cwe: new Set(),
  };
}

export function hasActiveFilters(filters: FindingFilters): boolean {
  return filters.severity.size > 0
    || filters.scannerSource.size > 0
    || filters.status.size > 0
    || filters.repo.size > 0
    || filters.cwe.size > 0;
}

// ---------------------------------------------------------------------------
// Backend enrichment merge
// ---------------------------------------------------------------------------

/**
 * The Aikido API is the live source for the findings list, but it does not
 * carry the backend-only verification (workstream C) and dedup (workstream D)
 * fields. The backend `findings` table holds those, keyed by scanner +
 * externalId, so we layer them on top of the Aikido-derived findings here.
 *
 * The key is `${scannerSource}-${externalId}`, which is exactly the dashboard
 * Finding `id` for Aikido findings (`aikido-${issueId}`, with
 * `externalId === String(issueId)`). Building the key from
 * scannerSource/externalId keeps the merge scanner-agnostic and independent of
 * how the id string happens to be assembled.
 */
function backendFieldKey(f: Pick<Finding, 'scannerSource' | 'externalId'>): string {
  return `${f.scannerSource}-${f.externalId}`;
}

/** Backend-sourced fields layered onto the live Aikido findings. */
type BackendFields = Pick<
  Finding,
  'verificationVerdict' | 'reachable' | 'exploitability' | 'verifiedAt' | 'signature' | 'duplicateOf'
>;

/**
 * Return `aikidoFindings` with backend verification/dedup fields merged in by
 * scanner + externalId. Pure and non-mutating: findings without a backend match
 * are returned unchanged, and an empty `backendFindings` array is a no-op.
 */
export function mergeBackendFields(
  aikidoFindings: Finding[],
  backendFindings: Finding[],
): Finding[] {
  if (backendFindings.length === 0) return aikidoFindings;

  const byKey = new Map<string, Finding>();
  for (const b of backendFindings) {
    byKey.set(backendFieldKey(b), b);
  }

  return aikidoFindings.map((f) => {
    const match = byKey.get(backendFieldKey(f));
    if (!match) return f;
    const fields: BackendFields = {
      verificationVerdict: match.verificationVerdict,
      reachable: match.reachable,
      exploitability: match.exploitability,
      verifiedAt: match.verifiedAt,
      signature: match.signature,
      duplicateOf: match.duplicateOf,
    };
    return { ...f, ...fields };
  });
}
