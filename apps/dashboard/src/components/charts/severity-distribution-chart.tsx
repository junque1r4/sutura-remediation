'use client';

import { useRouter } from 'next/navigation';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SEVERITY_COLOR, SEVERITY_ORDER } from '@/lib/severity-colors';

export interface SeverityRow {
  severity: 'critical' | 'high' | 'medium' | 'low';
  count: number;
}

interface SeverityDistributionChartProps {
  data: SeverityRow[];
  linkBuilder?: (item: SeverityRow) => string | null;
}

export function SeverityDistributionChart({
  data,
  linkBuilder,
}: SeverityDistributionChartProps) {
  const router = useRouter();
  const total = data.reduce((a, b) => a + b.count, 0);
  if (total === 0) {
    return (
      <p className="py-10 text-center text-sm text-gray-muted">
        Sem findings abertas no momento.
      </p>
    );
  }

  // Sort by canonical severity order so the chart reads critical -> low.
  const ordered = SEVERITY_ORDER.map((sev) => ({
    severity: sev,
    label: sev.charAt(0).toUpperCase() + sev.slice(1),
    count: data.find((d) => d.severity === sev)?.count ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={ordered}
        layout="vertical"
        margin={{ top: 10, right: 24, bottom: 0, left: 8 }}
      >
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <YAxis
          dataKey="label"
          type="category"
          tick={{ fontSize: 12, fill: '#0f1a2e', fontWeight: 500 }}
          axisLine={false}
          tickLine={false}
          width={80}
        />
        <Tooltip
          cursor={{ fill: '#faf6f1' }}
          contentStyle={{
            background: '#fff',
            border: '1px solid #e8e0d6',
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Bar
          dataKey="count"
          radius={[0, 4, 4, 0]}
          barSize={20}
          onClick={(payload) => {
            const item = payload as unknown as { severity: SeverityRow['severity']; count: number };
            const href = linkBuilder?.({ severity: item.severity, count: item.count });
            if (href) router.push(href);
          }}
        >
          {ordered.map((row) => {
            const href = linkBuilder?.({ severity: row.severity, count: row.count });
            return (
              <Cell
                key={row.severity}
                fill={SEVERITY_COLOR[row.severity]}
                style={{ cursor: href ? 'pointer' : 'default' }}
              />
            );
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
