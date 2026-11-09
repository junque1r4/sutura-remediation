export const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [{ name: 'Home', href: '/', icon: 'home' }],
  },
  {
    label: 'Operations',
    items: [
      { name: 'Findings', href: '/findings', icon: 'search' },
      { name: 'Fix History', href: '/fixes', icon: 'history' },
      { name: 'Repositories', href: '/repositories', icon: 'folder' },
      { name: 'Supply Chain', href: '/supply-chain', icon: 'package' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { name: 'Analytics', href: '/analytics', icon: 'chart' },
      { name: 'Token Costs', href: '/token-costs', icon: 'chart' },
      { name: 'Audit Log', href: '/audit-log', icon: 'shield' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { name: 'Settings', href: '/settings', icon: 'settings' },
      { name: 'Team', href: '/settings/members', icon: 'users' },
      { name: 'Custom Prompts', href: '/prompts', icon: 'message' },
    ],
  },
] as const;

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

export const SEVERITY_LABELS: Record<string, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

export const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  fixing: 'Fixing...',
  fixed: 'Fixed',
  wont_fix: "Won't Fix",
  failed: 'Failed',
};

export const ITEMS_PER_PAGE = 25;
