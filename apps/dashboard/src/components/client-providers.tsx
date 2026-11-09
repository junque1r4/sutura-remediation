'use client';

import { FindingsProvider } from '@/contexts/findings-context';

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return <FindingsProvider>{children}</FindingsProvider>;
}
