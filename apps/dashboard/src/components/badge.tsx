const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-severity-bg-critical text-severity-critical',
  high: 'bg-severity-bg-high text-severity-high',
  medium: 'bg-severity-bg-medium text-severity-medium',
  low: 'bg-severity-bg-low text-severity-low',
};

const STATUS_STYLES: Record<string, string> = {
  open: 'text-status-open',
  fixing: 'text-status-fixing',
  fixed: 'text-status-success',
  wont_fix: 'text-status-wontfix',
  failed: 'text-status-failed',
};

interface SeverityBadgeProps {
  severity: string;
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  const style = SEVERITY_STYLES[severity] ?? 'bg-gray-100 text-gray-text';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${style}`}>
      {severity.toUpperCase()}
    </span>
  );
}

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const style = STATUS_STYLES[status] ?? 'text-gray-text';
  const label =
    status === 'fixing'
      ? 'Fixing...'
      : status === 'wont_fix'
        ? "Won't Fix"
        : status === 'fixed'
          ? 'Fixed'
          : status === 'failed'
            ? 'Failed'
            : status === 'open'
              ? 'Open'
              : status;

  return (
    <span className={`text-xs ${style}`}>
      {status === 'fixing' && (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-fixing" />
      )}
      {label}
    </span>
  );
}
