export const SEVERITY_COLOR: Record<'critical' | 'high' | 'medium' | 'low', string> = {
  critical: '#dc2626',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
};

export const SEVERITY_ORDER: Array<'critical' | 'high' | 'medium' | 'low'> = [
  'critical',
  'high',
  'medium',
  'low',
];

export const VALIDATION_COLOR = {
  resolved: '#10b981',
  stillVulnerable: '#dc2626',
  inconclusive: '#94a3b8',
} as const;

export const TREND_COLOR = {
  ingested: '#dc2626',
  resolved: '#10b981',
} as const;
