export const ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org:settings:read',
  'org:settings:write',
  'org:members:read',
  'org:members:invite',
  'org:members:remove',
  'org:members:role',
  'integrations:read',
  'integrations:write',
  'integrations:disconnect',
  'findings:read',
  'findings:write',
  'findings:dismiss',
  'fixes:read',
  'fixes:write',
  'fixes:approve',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL_PERMS: ReadonlyArray<Permission> = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  owner: ALL_PERMS,
  admin: ALL_PERMS.filter(
    // Admin can do anything except transfer ownership (modeled as a separate
    // action handled in the owner-only route).
    (p) => p !== ('org:owner:transfer' as Permission),
  ),
  developer: [
    'findings:read',
    'findings:write',
    'findings:dismiss',
    'fixes:read',
    'fixes:write',
    'integrations:read',
  ],
  viewer: ['findings:read', 'fixes:read', 'integrations:read'],
};

export function hasPermission(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
