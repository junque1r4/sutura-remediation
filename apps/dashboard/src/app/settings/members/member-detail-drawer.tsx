'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/dialog';
import {
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@/lib/auth/permissions';

interface MemberDetail {
  userId: string;
  email: string;
  role: Role;
  joinedAt: string;
  invitedByEmail: string | null;
  lastLoginAt: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  activeSessionCount: number;
}

interface SessionRow {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

interface AuditEntry {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface Props {
  userId: string | null;
  open: boolean;
  onClose: () => void;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function statusBadge(detail: MemberDetail): { label: string; cls: string } {
  if (!detail.emailVerifiedAt) {
    return { label: 'Email unverified', cls: 'bg-severity-bg-medium text-severity-medium' };
  }
  return { label: 'Active', cls: 'bg-status-success/15 text-status-success' };
}

function formatAction(action: string): string {
  const map: Record<string, string> = {
    'auth.login.succeeded': 'Signed in',
    'auth.login.failed': 'Failed sign-in attempt',
    'auth.logout': 'Signed out',
    'auth.password.changed': 'Password changed',
    'org.member.invited': 'Invited someone',
    'org.member.role_changed': 'Role changed',
    'org.member.removed': 'Removed from org',
    'org.invitation.accepted': 'Accepted invitation',
    'org.invitation.resent': 'Resent invitation',
  };
  return map[action] ?? action;
}

function metadataPreview(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata).slice(0, 3);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
}

export function MemberDetailDrawer({ userId, open, onClose }: Props) {
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [d, s, a] = await Promise.all([
          fetch(`/api/org/members/${userId}/detail`, { cache: 'no-store' }),
          fetch(`/api/org/members/${userId}/sessions`, { cache: 'no-store' }),
          fetch(`/api/org/members/${userId}/audit?limit=50`, { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (!d.ok) {
          const body = (await d.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? 'Failed to load');
          return;
        }
        setDetail((await d.json()) as MemberDetail);
        if (s.ok) setSessions(((await s.json()) as { sessions: SessionRow[] }).sessions);
        if (a.ok) setAudit(((await a.json()) as { entries: AuditEntry[] }).entries);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  const rolePerms: ReadonlyArray<Permission> = detail
    ? ROLE_PERMISSIONS[detail.role]
    : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      variant="drawer"
      title={detail?.email ?? 'Member'}
      description={detail ? `${detail.role} · ${detail.activeSessionCount} active session${detail.activeSessionCount === 1 ? '' : 's'}` : undefined}
    >
      {loading && <p className="text-sm text-gray-text">Loading…</p>}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-severity-critical/30 bg-severity-bg-critical px-3 py-2 text-sm text-severity-critical"
        >
          {error}
        </div>
      )}
      {detail && (
        <div className="space-y-6">
          <section>
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(detail).cls}`}
              >
                {statusBadge(detail).label}
              </span>
              <span className="text-xs text-gray-text">
                joined {new Date(detail.joinedAt).toLocaleDateString()}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-gray-text">Email verified</dt>
              <dd className="text-navy">{formatDate(detail.emailVerifiedAt)}</dd>
              <dt className="text-gray-text">Last login</dt>
              <dd className="text-navy">{formatDate(detail.lastLoginAt)}</dd>
              <dt className="text-gray-text">Invited by</dt>
              <dd className="text-navy">{detail.invitedByEmail ?? '—'}</dd>
              <dt className="text-gray-text">Created at</dt>
              <dd className="text-navy">{formatDate(detail.createdAt)}</dd>
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-navy">
              Permissions ({detail.role})
            </h3>
            {rolePerms.length === 0 ? (
              <p className="text-sm text-gray-text">All permissions (owner)</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {rolePerms.map((p) => (
                  <li
                    key={p}
                    className="rounded bg-cream-warm px-2 py-0.5 text-xs text-navy"
                  >
                    {p}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-navy">
              Active sessions ({sessions.length})
            </h3>
            {sessions.length === 0 ? (
              <p className="text-sm text-gray-text">No active sessions.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-cream-warm text-left uppercase tracking-wide text-gray-text">
                  <tr>
                    <th className="px-2 py-1.5">Device</th>
                    <th className="px-2 py-1.5">IP</th>
                    <th className="px-2 py-1.5">Last active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-light">
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="px-2 py-1.5 text-navy">
                        <span
                          className="block max-w-[200px] truncate"
                          title={s.userAgent ?? undefined}
                        >
                          {s.userAgent ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-gray-text">{s.ip ?? '—'}</td>
                      <td className="px-2 py-1.5 text-gray-text">
                        {new Date(s.lastActiveAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-navy">
              Activity ({audit.length})
            </h3>
            {audit.length === 0 ? (
              <p className="text-sm text-gray-text">No audit events yet.</p>
            ) : (
              <ol className="space-y-2">
                {audit.map((e) => (
                  <li
                    key={e.id}
                    className="rounded-md border border-border-light bg-cream-warm px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-navy">
                        {formatAction(e.action)}
                      </span>
                      <span className="text-gray-text">
                        {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {metadataPreview(e.metadata) && (
                      <div className="mt-0.5 text-gray-text">
                        {metadataPreview(e.metadata)}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
