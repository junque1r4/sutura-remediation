'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';

const AUTH_PATH_PREFIXES = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/invite/accept',
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthRoute = AUTH_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (isAuthRoute) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-cream px-4 py-8">
        {children}
      </main>
    );
  }

  return (
    <>
      <Sidebar />
      <main className="ml-[220px] min-h-screen">
        <div className="mx-auto max-w-[1280px] px-6 py-6">{children}</div>
      </main>
    </>
  );
}
