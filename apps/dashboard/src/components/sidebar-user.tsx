'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Me {
  user: { id: string; email: string };
  activeOrgId: string | null;
  activeRole: string | null;
  memberships: Array<{ orgId: string; orgName: string; role: string }>;
}

function initials(email: string): string {
  const local = email.split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

async function logout(router: ReturnType<typeof useRouter>): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Even if the network call fails, fall through to the client-side cleanup
    // and redirect so the user is never trapped.
  } finally {
    router.replace('/login');
    router.refresh();
  }
}

export function SidebarUser({ collapsed }: { collapsed: boolean }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  // 'invalid' means /api/auth/me returned 401: the cookie is stale and we are
  // self-healing by logging out. Drives the "Session expired" escape hatch UI.
  const [status, setStatus] = useState<'loading' | 'ok' | 'invalid'>('loading');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          setMe((await res.json()) as Me);
          setStatus('ok');
          return;
        }
        if (res.status === 401) {
          // Stale/invalid sutura_session cookie. Self-heal: clear the cookie via
          // the logout endpoint and redirect to /login so the user isn't trapped
          // behind 403s with no visible way out (issues #17, #18).
          setStatus('invalid');
          void logout(router);
        }
      } catch {
        // Network error: leave the skeleton in place rather than logging out, so
        // a transient blip doesn't kick a still-valid session to /login.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onLogout() {
    setMenuOpen(false);
    await logout(router);
  }

  if (status === 'invalid') {
    // Escape hatch: the session is gone and we're redirecting, but render an
    // explicit, always-available Sign out control in case the auto-redirect is
    // blocked or slow.
    return (
      <div className="border-t border-navy-light px-4 py-3">
        {!collapsed && (
          <p className="mb-2 text-[11px] text-gray-muted">Session expired</p>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="block w-full rounded-md px-3 py-2 text-left text-sm text-cream hover:bg-navy-light"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="border-t border-navy-light px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 flex-shrink-0 rounded-full bg-navy-light" />
          {!collapsed && <div className="h-3 w-24 rounded bg-navy-light" />}
        </div>
      </div>
    );
  }

  const activeMembership = me.memberships.find((m) => m.orgId === me.activeOrgId);
  const role = me.activeRole ?? 'member';
  const orgName = activeMembership?.orgName ?? '';

  return (
    <div className="relative border-t border-navy-light px-4 py-3">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex w-full items-center gap-2 rounded-md p-0 text-left hover:bg-navy-light"
      >
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-orange/20 text-xs font-bold text-orange">
          {initials(me.user.email)}
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-cream">{me.user.email}</p>
            <p className="truncate text-[11px] text-gray-muted">
              {role}
              {orgName ? ` · ${orgName}` : ''}
            </p>
          </div>
        )}
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-md border border-navy-light bg-navy shadow-lg"
        >
          <a
            href="/settings/security"
            onClick={() => setMenuOpen(false)}
            className="block px-3 py-2 text-sm text-cream hover:bg-navy-light"
            role="menuitem"
          >
            Security
          </a>
          <button
            type="button"
            onClick={onLogout}
            className="block w-full px-3 py-2 text-left text-sm text-cream hover:bg-navy-light"
            role="menuitem"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
