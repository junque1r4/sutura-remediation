/**
 * Sanitize the `?next=` redirect target used after sign-in. Only same-origin
 * absolute paths are allowed; anything else falls back to the dashboard root.
 * Rejects protocol-relative (`//host`) and backslash (`/\host`) forms, which
 * browsers treat as cross-origin destinations when handed to
 * `window.location.assign` (open redirect).
 */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith('/')) return '/';
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
