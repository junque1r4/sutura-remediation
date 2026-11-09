'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TREND_COLOR } from '@/lib/severity-colors';

export interface TrendPoint {
  date: string;
  ingested: number;
  resolved: number;
}

function formatTick(date: string): string {
  const [, mm, dd] = date.split('-');
  return `${dd}/${mm}`;
}

export function TrendChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-gray-muted">
        No data for the selected period.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id="ingestedGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TREND_COLOR.ingested} stopOpacity={0.35} />
            <stop offset="100%" stopColor={TREND_COLOR.ingested} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="resolvedGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TREND_COLOR.resolved} stopOpacity={0.35} />
            <stop offset="100%" stopColor={TREND_COLOR.resolved} stopOpacity={0} />
          </linearGradient>
        </defs>
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
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 12, paddingTop: 4 }}
        />
        <Area
          type="monotone"
          dataKey="ingested"
          name="Ingested"
          stroke={TREND_COLOR.ingested}
          fill="url(#ingestedGrad)"
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="resolved"
          name="Resolved"
          stroke={TREND_COLOR.resolved}
          fill="url(#resolvedGrad)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
