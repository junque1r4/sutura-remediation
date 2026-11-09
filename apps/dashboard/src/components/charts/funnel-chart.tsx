'use client';

export interface FunnelStagePoint {
  key: string;
  label: string;
  count: number;
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

export function FunnelChart({ data }: { data: FunnelStagePoint[] }) {
  if (data.length === 0 || data.every((d) => d.count === 0)) {
    return (
      <p className="py-10 text-center text-sm text-gray-muted">
        Sem atividade de remediacao no periodo.
      </p>
    );
  }

  const max = Math.max(...data.map((d) => d.count), 1);
  const top = data[0]?.count ?? 0;

  return (
    <div className="space-y-2.5">
      {data.map((stage, i) => {
        const widthPct = (stage.count / max) * 100;
        const prev = i > 0 ? data[i - 1].count : null;
        const conversionFromPrev = prev !== null ? percent(stage.count, prev) : null;
        const conversionFromTop = i > 0 ? percent(stage.count, top) : null;
        return (
          <div key={stage.key} className="flex items-center gap-3">
            <div className="w-36 shrink-0 text-xs font-medium text-navy">{stage.label}</div>
            <div className="relative h-8 flex-1 overflow-hidden rounded bg-cream-warm">
              <div
                className="absolute inset-y-0 left-0 flex items-center bg-gradient-to-r from-navy to-orange pl-2 transition-all"
                style={{ width: `${widthPct}%` }}
              >
                <span className="text-xs font-semibold text-white">{stage.count}</span>
              </div>
            </div>
            <div className="w-32 shrink-0 text-right text-[11px] text-gray-text">
              {conversionFromPrev !== null && (
                <>
                  <span className="font-mono">{conversionFromPrev}</span>
                  <span className="ml-1">vs anterior</span>
                </>
              )}
              {conversionFromTop !== null && (
                <div className="text-[10px] text-gray-muted">
                  <span className="font-mono">{conversionFromTop}</span> do topo
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
