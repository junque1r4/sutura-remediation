'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_GROUPS } from '@/lib/constants';
import { SidebarUser } from '@/components/sidebar-user';
import { hasPermission, isRole, type Permission, type Role } from '@/lib/auth/permissions';

// Nav entries that require a specific permission to be visible.
const NAV_PERMISSIONS: Partial<Record<string, Permission>> = {
  '/settings/members': 'org:members:read',
  '/audit-log': 'audit:read',
};

const NAV_ICONS: Record<string, React.ReactNode> = {
  home: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1"
      />
    </svg>
  ),
  search: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
  history: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
  folder: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      />
    </svg>
  ),
  chart: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
      />
    </svg>
  ),
  shield: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
      />
    </svg>
  ),
  settings: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  message: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
      />
    </svg>
  ),
  users: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-8a4 4 0 11-8 0 4 4 0 018 0zm6 3a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  ),
  package: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
      />
    </svg>
  ),
};

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [role, setRole] = useState<Role | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { activeRole: string | null };
        if (isRole(data.activeRole)) setRole(data.activeRole);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function isItemVisible(href: string): boolean {
    const required = NAV_PERMISSIONS[href];
    if (!required) return true;
    // Until /api/auth/me resolves, hide perm-gated entries to avoid a flash.
    if (!role) return false;
    return hasPermission(role, required);
  }

  // Pick the single best-matching item per group so nested routes don't
  // light up both the parent ("/settings") and the child ("/settings/members").
  const allVisibleHrefs = NAV_GROUPS.flatMap((g) =>
    g.items.filter((i) => isItemVisible(i.href)).map((i) => i.href),
  );
  const bestActiveHref = allVisibleHrefs
    .filter((href) =>
      href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`),
    )
    .sort((a, b) => b.length - a.length)[0];

  return (
    <aside
      className={`fixed left-0 top-0 flex h-screen flex-col bg-navy text-cream transition-all duration-200 ${
        collapsed ? 'w-16' : 'w-[220px]'
      }`}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-5">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-orange text-sm font-extrabold text-navy">
          S
        </div>
        {!collapsed && <span className="text-lg font-bold tracking-tight">Sutura</span>}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-4">
            {!collapsed && (
              <span className="mb-1 block px-3 text-[11px] font-medium uppercase tracking-wider text-gray-muted">
                {group.label}
              </span>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.filter((item) => isItemVisible(item.href)).map((item) => {
                const isActive = item.href === bestActiveHref;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-label={collapsed ? item.name : undefined}
                    title={collapsed ? item.name : undefined}
                    className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${
                      isActive
                        ? 'border-l-[3px] border-orange bg-orange/15 font-medium text-orange'
                        : 'border-l-[3px] border-transparent text-gray-muted hover:bg-navy-light hover:text-cream'
                    } ${collapsed ? 'justify-center px-0' : ''}`}
                  >
                    <span className="flex-shrink-0">{NAV_ICONS[item.icon] ?? null}</span>
                    {!collapsed && item.name}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="mx-3 mb-3 rounded-md px-3 py-2 text-[13px] text-gray-muted transition-colors hover:bg-navy-light hover:text-cream"
      >
        {collapsed ? '>>' : '<< Collapse'}
      </button>

      {/* User section */}
      <SidebarUser collapsed={collapsed} />
    </aside>
  );
}
