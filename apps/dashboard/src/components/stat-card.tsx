import { SEVERITY_COLOR } from '@/lib/severity-colors';

interface SeverityBreakdownEntry {
  severity: 'critical' | 'high' | 'medium' | 'low';
  count: number;
}

interface StatCardProps {
  label: string;
  value: number | string;
  color?: string;
  trend?: 'up' | 'down' | 'flat';
  trendValue?: string;
  /**
   * Optional delta vs previous period. Positive number renders with an up
   * arrow and `goodWhen` decides whether up is good (green) or bad (red).
   * `null` means "no comparison available" and the row is hidden.
   */
  delta?: { value: number; suffix?: string; goodWhen?: 'up' | 'down' } | null;
  /** Stacked mini-bar showing severity composition under the value. */
  breakdown?: SeverityBreakdownEntry[];
}

function formatDelta(value: number, suffix?: string): string {
  const sign = value > 0 ? '+' : '';
  const decimals = Math.abs(value) >= 10 ? 0 : 1;
  return `${sign}${value.toFixed(decimals)}${suffix ?? ''}`;
}

export function StatCard({
  label,
  value,
  color,
  trend,
  trendValue,
  delta,
  breakdown,
}: StatCardProps) {
  const trendArrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '';
  const trendColor =
    trend === 'down'
      ? 'text-status-success'
      : trend === 'up'
        ? 'text-status-failed'
        : 'text-gray-text';

  let deltaNode: React.ReactNode = null;
  if (delta && delta.value !== 0 && Number.isFinite(delta.value)) {
    const goodWhen = delta.goodWhen ?? 'up';
    const isGood = goodWhen === 'up' ? delta.value > 0 : delta.value < 0;
    const cls = isGood ? 'text-status-success' : 'text-status-failed';
    const arrow = delta.value > 0 ? '↑' : '↓';
    deltaNode = (
      <p className={`mt-1 text-xs ${cls}`}>
        {arrow} {formatDelta(delta.value, delta.suffix)} vs previous period
      </p>
    );
  }

  const breakdownTotal = breakdown?.reduce((a, b) => a + b.count, 0) ?? 0;

  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-text">{label}</p>
      <p className="mt-1 text-2xl font-bold" style={color ? { color } : undefined}>
        {value}
      </p>
      {trend && trendValue && (
        <p className={`mt-1 text-xs ${trendColor}`}>
          {trendArrow} {trendValue}
        </p>
      )}
      {deltaNode}
      {breakdown && breakdownTotal > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-cream-warm">
            {breakdown.map((b) =>
              b.count > 0 ? (
                <div
                  key={b.severity}
                  style={{
                    width: `${(b.count / breakdownTotal) * 100}%`,
                    backgroundColor: SEVERITY_COLOR[b.severity],
                  }}
                  title={`${b.severity}: ${b.count}`}
                />
              ) : null,
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-text">
            {breakdown.map((b) => (
              <span key={b.severity} className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: SEVERITY_COLOR[b.severity] }}
                />
                {b.count} {b.severity}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
