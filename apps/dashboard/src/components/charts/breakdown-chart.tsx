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

export interface BreakdownItem {
  label: string;
  count: number;
}

interface BreakdownChartProps {
  data: BreakdownItem[];
  /** Optional builder for drill-down. Return null to render a non-clickable bar. */
  linkBuilder?: (item: BreakdownItem) => string | null;
  /** Bar color. Defaults to the brand orange. */
  color?: string;
  /** Maximum label width before truncation in the Y-axis. */
  labelWidth?: number;
}

const DEFAULT_COLOR = '#f97316';

export function BreakdownChart({
  data,
  linkBuilder,
  color = DEFAULT_COLOR,
  labelWidth = 110,
}: BreakdownChartProps) {
  const router = useRouter();

  if (data.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-gray-muted">
        No data for the selected period.
      </p>
    );
  }

  // Cap to 10 and reverse so the largest renders at the top in a vertical-layout bar chart.
  const rows = data.slice(0, 10);
  const height = Math.max(180, rows.length * 28 + 24);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
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
          tick={{ fontSize: 11, fill: '#0f1a2e' }}
          axisLine={false}
          tickLine={false}
          width={labelWidth}
          interval={0}
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
          barSize={18}
          onClick={(payload) => {
            const item = payload as unknown as BreakdownItem;
            const href = linkBuilder?.(item);
            if (href) router.push(href);
          }}
        >
          {rows.map((row, idx) => {
            const href = linkBuilder?.(row);
            return (
              <Cell
                key={row.label + idx}
                fill={color}
                style={{ cursor: href ? 'pointer' : 'default' }}
              />
            );
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
