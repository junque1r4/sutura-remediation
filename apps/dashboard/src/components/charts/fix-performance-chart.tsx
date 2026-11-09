'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { VALIDATION_COLOR } from '@/lib/severity-colors';

export interface FixPerformancePoint {
  date: string;
  resolved: number;
  stillVulnerable: number;
  inconclusive: number;
}

function formatTick(date: string): string {
  const [, mm, dd] = date.split('-');
  return `${dd}/${mm}`;
}

export function FixPerformanceChart({ data }: { data: FixPerformancePoint[] }) {
  const hasAny = data.some((d) => d.resolved + d.stillVulnerable + d.inconclusive > 0);
  if (!hasAny) {
    return (
      <p className="py-10 text-center text-sm text-gray-muted">
        No completed attempts in the selected period.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e8e0d6" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatTick}
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={{ stroke: '#e8e0d6' }}
          tickLine={false}
          minTickGap={20}
        />
        <YAxis
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            background: '#fff',
            border: '1px solid #e8e0d6',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: '#0f1a2e', fontWeight: 600 }}
        />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 4 }} />
        <Bar
          dataKey="resolved"
          name="Resolved"
          stackId="a"
          fill={VALIDATION_COLOR.resolved}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="stillVulnerable"
          name="Still vulnerable"
          stackId="a"
          fill={VALIDATION_COLOR.stillVulnerable}
        />
        <Bar
          dataKey="inconclusive"
          name="Inconclusive"
          stackId="a"
          fill={VALIDATION_COLOR.inconclusive}
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
