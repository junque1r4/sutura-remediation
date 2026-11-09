'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Tab {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
}

export function SettingsTabs({ canSeeTeam }: { canSeeTeam: boolean }) {
  const pathname = usePathname();

  const tabs: Tab[] = [
    {
      href: '/settings',
      label: 'Integrations',
      match: (p) => p === '/settings',
    },
    ...(canSeeTeam
      ? [
          {
            href: '/settings/members',
            label: 'Team',
            match: (p: string) => p.startsWith('/settings/members'),
          },
        ]
      : []),
    {
      href: '/settings/security',
      label: 'Security',
      match: (p) => p.startsWith('/settings/security'),
    },
  ];

  return (
    <nav className="flex gap-1 border-b border-border">
      {tabs.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={
              active
                ? '-mb-px border-b-2 border-orange px-4 py-2 text-sm font-medium text-orange'
                : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-text hover:text-navy'
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
