'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ROLES, ROLE_PERMISSIONS, type Role } from '@/lib/auth/permissions';
import { MemberDetailDrawer } from './member-detail-drawer';
import { ConfirmDialog } from './confirm-dialog';

interface Member {
  userId: string;
  email: string;
  role: Role;
  joinedAt: string;
  lastLoginAt: string | null;
  invitedByEmail: string | null;
  emailVerifiedAt: string | null;
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  invitedByEmail: string | null;
  expiresAt: string;
  createdAt: string;
}

interface Props {
  currentUserId: string;
  currentRole: Role;
  canInvite: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
}

type PendingAction =
  | { kind: 'role'; userId: string; email: string; nextRole: Role; currentRole: Role }
  | { kind: 'remove'; userId: string; email: string };

function memberStatus(
  m: Member,
): { label: string; cls: string } {
  if (!m.emailVerifiedAt) {
    return { label: 'Unverified', cls: 'bg-severity-bg-medium text-severity-medium' };
  }
  return { label: 'Active', cls: 'bg-status-success/15 text-status-success' };
}

/**
 * Mask an invite accept URL for display: keep the origin/path so the user can
 * recognize it, but elide the secret token in the query/fragment. The full URL
 * is only shown after an explicit Reveal action.
 */
function maskInviteUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = `${u.origin}${u.pathname}`;
    if (u.search || u.hash) return `${base}?…`;
    return base;
  } catch {
    // Not a parseable URL — fall back to a coarse truncation.
    return url.length > 24 ? `${url.slice(0, 24)}…` : url;
  }
}

function roleTooltip(role: Role): string {
  const perms = ROLE_PERMISSIONS[role];
  if (perms.length === 0) return 'All permissions';
  return perms.slice(0, 8).join(', ') + (perms.length > 8 ? '…' : '');
}

export function MembersClient({
  currentUserId,
  currentRole,
  canInvite,
  canChangeRole,
  canRemove,
}: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('developer');
  const [inviting, setInviting] = useState(false);
  const [search, setSearch] = useState('');
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [pendingRoleChangeUserId, setPendingRoleChangeUserId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [warning, setWarning] = useState<{ message: string; copyLink?: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/org/members', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Failed to load');
        return;
      }
      const data = (await res.json()) as {
        members: Member[];
        pendingInvitations: Invitation[];
      };
      setMembers(data.members);
      setInvitations(data.pendingInvitations);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setInviting(true);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch('/api/org/members/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Invite failed');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        warning?: string;
        acceptUrl?: string;
      };
      const invitedEmail = inviteEmail;
      setInviteEmail('');
      if (body.warning) {
        setWarning({ message: body.warning, copyLink: body.acceptUrl });
      } else {
        setFlash(`Invitation sent to ${invitedEmail}`);
      }
      await refresh();
    } finally {
      setInviting(false);
    }
  }

  async function performRoleChange(userId: string, role: Role) {
    setPendingRoleChangeUserId(userId);
    try {
      const res = await fetch(`/api/org/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Update failed');
        return;
      }
      await refresh();
    } finally {
      setPendingRoleChangeUserId(null);
    }
  }

  async function performRemove(userId: string) {
    const res = await fetch(`/api/org/members/${userId}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Remove failed');
      return;
    }
    await refresh();
  }

  async function onRevokeInvite(id: string) {
    const res = await fetch(`/api/org/invitations/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Revoke failed');
      return;
    }
    await refresh();
  }

  async function onResendInvite(id: string) {
    setResendingId(id);
    setWarning(null);
    try {
      const res = await fetch(`/api/org/invitations/${id}/resend`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Resend failed');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        warning?: string;
        acceptUrl?: string;
      };
      if (body.warning) {
        setWarning({ message: body.warning, copyLink: body.acceptUrl });
      } else {
        setFlash('Invitation resent');
      }
      await refresh();
    } finally {
      setResendingId(null);
    }
  }

  const assignableRoles = useMemo(
    () => ROLES.filter((r) => r !== 'owner' || currentRole === 'owner'),
    [currentRole],
  );

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.email.toLowerCase().includes(q));
  }, [members, search]);

  async function onConfirmPending() {
    const action = pendingAction;
    setPendingAction(null);
    if (!action) return;
    if (action.kind === 'role') {
      await performRoleChange(action.userId, action.nextRole);
    } else if (action.kind === 'remove') {
      await performRemove(action.userId);
    }
  }

  return (
    <div className="space-y-8">
      {flash && (
        <div
          role="status"
          className="rounded-md border border-status-success/30 bg-status-success/10 px-3 py-2 text-sm text-status-success"
        >
          {flash}{' '}
          <button
            type="button"
            onClick={() => setFlash(null)}
            className="ml-2 text-xs underline"
          >
            dismiss
          </button>
        </div>
      )}
      {warning && (
        <CopyLinkWarning warning={warning} onDismiss={() => setWarning(null)} />
      )}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-severity-critical/30 bg-severity-bg-critical px-3 py-2 text-sm text-severity-critical"
        >
          {error}{' '}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 text-xs underline"
          >
            dismiss
          </button>
        </div>
      )}

      {canInvite && (
        <section className="rounded-lg border border-border bg-white p-6">
          <h2 className="text-lg font-medium text-navy">Invite a teammate</h2>
          <form onSubmit={onInvite} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              type="email"
              required
              placeholder="teammate@company.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-navy shadow-sm focus:border-orange focus:outline-none focus:ring-2 focus:ring-orange/30"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
              title={roleTooltip(inviteRole)}
              className="rounded-md border border-border bg-white px-3 py-2 text-sm text-navy shadow-sm focus:border-orange focus:outline-none focus:ring-2 focus:ring-orange/30"
            >
              {assignableRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={inviting}
              className="rounded-md bg-orange px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-orange-deep disabled:opacity-60"
            >
              {inviting ? 'Sending…' : 'Send invite'}
            </button>
          </form>
        </section>
      )}

      <section className="rounded-lg border border-border bg-white">
        <div className="flex flex-col gap-3 border-b border-border px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-medium text-navy">Members</h2>
            <p className="mt-0.5 text-xs text-gray-text">
              {members.length} total · click a row for details
            </p>
          </div>
          <input
            type="search"
            placeholder="Search by email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm text-navy shadow-sm focus:border-orange focus:outline-none focus:ring-2 focus:ring-orange/30 sm:w-64"
          />
        </div>
        <table className="w-full text-sm">
          <thead className="bg-cream-warm text-left text-xs uppercase tracking-wide text-gray-text">
            <tr>
              <th className="px-6 py-3">Email</th>
              <th className="px-6 py-3">Role</th>
              <th className="px-6 py-3">Status</th>
              <th className="px-6 py-3">Invited by</th>
              <th className="px-6 py-3">Joined</th>
              <th className="px-6 py-3">Last login</th>
              <th className="px-6 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-light">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`skel-${i}`}>
                  <td className="px-6 py-3">
                    <div className="h-3 w-40 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3">
                    <div className="h-3 w-20 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3">
                    <div className="h-3 w-16 animate-pulse rounded-full bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3">
                    <div className="h-3 w-32 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3">
                    <div className="h-3 w-20 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3">
                    <div className="h-3 w-24 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3" />
                </tr>
              ))
            ) : (
              <>
                {filteredMembers.map((m) => {
                  const status = memberStatus(m);
                  const canEditThisMember = canChangeRole && m.userId !== currentUserId;
                  const isRoleChanging = pendingRoleChangeUserId === m.userId;
                  return (
                    <tr
                      key={m.userId}
                      onClick={() => setDrawerUserId(m.userId)}
                      className="cursor-pointer hover:bg-cream-warm/60"
                    >
                      <td className="px-6 py-3 text-navy">
                        {m.email}
                        {m.userId === currentUserId && (
                          <span className="ml-2 text-xs text-gray-text">(you)</span>
                        )}
                      </td>
                      <td className="px-6 py-3" onClick={(e) => e.stopPropagation()}>
                        {canEditThisMember ? (
                          <select
                            value={m.role}
                            disabled={isRoleChanging}
                            onChange={(e) => {
                              const nextRole = e.target.value as Role;
                              if (nextRole === m.role) return;
                              setPendingAction({
                                kind: 'role',
                                userId: m.userId,
                                email: m.email,
                                nextRole,
                                currentRole: m.role,
                              });
                            }}
                            title={roleTooltip(m.role)}
                            className="rounded-md border border-border bg-white px-2 py-1 text-sm text-navy disabled:opacity-60"
                          >
                            {assignableRoles.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span title={roleTooltip(m.role)} className="text-navy">
                            {m.role}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${status.cls}`}
                        >
                          {status.label}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-text">
                        {m.invitedByEmail ?? '—'}
                      </td>
                      <td className="px-6 py-3 text-gray-text">
                        {new Date(m.joinedAt).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-3 text-gray-text">
                        {m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : '—'}
                      </td>
                      <td
                        className="px-6 py-3 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {canRemove && m.userId !== currentUserId && (
                          <button
                            onClick={() =>
                              setPendingAction({
                                kind: 'remove',
                                userId: m.userId,
                                email: m.email,
                              })
                            }
                            className="text-sm text-severity-critical hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filteredMembers.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-6 py-6 text-center text-sm text-gray-text"
                    >
                      No members match &ldquo;{search}&rdquo;.
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </section>

      {invitations.length > 0 && (
        <section className="rounded-lg border border-border bg-white">
          <div className="border-b border-border px-6 py-4">
            <h2 className="text-lg font-medium text-navy">Pending invitations</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-cream-warm text-left text-xs uppercase tracking-wide text-gray-text">
              <tr>
                <th className="px-6 py-3">Email</th>
                <th className="px-6 py-3">Role</th>
                <th className="px-6 py-3">Invited by</th>
                <th className="px-6 py-3">Expires</th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-light">
              {invitations.map((inv) => (
                <tr key={inv.id}>
                  <td className="px-6 py-3 text-navy">{inv.email}</td>
                  <td className="px-6 py-3 text-navy">{inv.role}</td>
                  <td className="px-6 py-3 text-gray-text">{inv.invitedByEmail}</td>
                  <td className="px-6 py-3 text-gray-text">
                    {new Date(inv.expiresAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {canInvite && (
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => onResendInvite(inv.id)}
                          disabled={resendingId === inv.id}
                          className="text-sm text-navy hover:text-orange disabled:opacity-60"
                        >
                          {resendingId === inv.id ? 'Sending…' : 'Resend'}
                        </button>
                        <button
                          onClick={() => onRevokeInvite(inv.id)}
                          className="text-sm text-severity-critical hover:underline"
                        >
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <MemberDetailDrawer
        userId={drawerUserId}
        open={drawerUserId !== null}
        onClose={() => setDrawerUserId(null)}
      />

      <ConfirmDialog
        open={pendingAction?.kind === 'role'}
        title="Change role?"
        description={
          pendingAction?.kind === 'role'
            ? `Change ${pendingAction.email} from ${pendingAction.currentRole} to ${pendingAction.nextRole}? They'll get the new permissions on their next request.`
            : undefined
        }
        confirmLabel="Change role"
        onConfirm={onConfirmPending}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction?.kind === 'remove'}
        title="Remove member?"
        description={
          pendingAction?.kind === 'remove'
            ? `Remove ${pendingAction.email} from this organization? They will lose access on their next request.`
            : undefined
        }
        confirmLabel="Remove"
        destructive
        onConfirm={onConfirmPending}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

function CopyLinkWarning({
  warning,
  onDismiss,
}: {
  warning: { message: string; copyLink?: string };
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function copy() {
    if (!warning.copyLink) return;
    try {
      await navigator.clipboard.writeText(warning.copyLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — user can still reveal and select manually
    }
  }

  return (
    <div
      role="alert"
      className="rounded-md border border-severity-medium/30 bg-severity-bg-medium px-3 py-2 text-sm text-navy"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="font-medium">{warning.message}</p>
          {warning.copyLink && (
            <>
              <p className="mt-1 text-xs text-gray-text">
                This single-use invite link is a fallback for when the invitation
                email fails to send. Treat it as a secret and share it only with
                the intended teammate.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="block flex-1 truncate rounded bg-white/70 px-2 py-1 text-xs text-gray-text">
                  {revealed ? warning.copyLink : maskInviteUrl(warning.copyLink)}
                </code>
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  className="rounded-md border border-border bg-white px-2 py-1 text-xs font-medium text-navy hover:bg-cream-warm"
                >
                  {revealed ? 'Hide' : 'Reveal'}
                </button>
                <button
                  type="button"
                  onClick={copy}
                  className="rounded-md border border-border bg-white px-2 py-1 text-xs font-medium text-navy hover:bg-cream-warm"
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-gray-text underline"
        >
          dismiss
        </button>
      </div>
    </div>
  );
}
