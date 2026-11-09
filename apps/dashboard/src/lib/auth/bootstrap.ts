import 'server-only';
import { query } from '@/lib/db';
import { hashPassword } from './password';
import { createMembership, createUser, findUserByEmail } from './users';

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Idempotent: if BOOTSTRAP_OWNER_EMAIL is set and no user has that email
 * yet, create it as an owner of the default organization.
 *
 * BOOTSTRAP_OWNER_PASSWORD must also be set; otherwise the function logs
 * and exits without doing anything (we never invent a password).
 */
export async function bootstrapOwnerFromEnv(): Promise<void> {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!email) return;
  if (!password) {
    console.warn(
      '[bootstrap] BOOTSTRAP_OWNER_EMAIL set but BOOTSTRAP_OWNER_PASSWORD missing -- skipping',
    );
    return;
  }

  // Make sure the default org exists (migration 008 seeds it, but on legacy
  // volumes the row could be missing).
  await query(
    `INSERT INTO organizations (id, name, plan)
     VALUES ($1, 'Default Organization', 'pilot')
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_ORG_ID],
  );

  const existing = await findUserByEmail(email);
  if (existing) {
    // Ensure they have an owner membership (in case a prior bootstrap created
    // the user but failed before the membership insert).
    await createMembership({
      userId: existing.id,
      orgId: DEFAULT_ORG_ID,
      role: 'owner',
    });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser({ email, passwordHash, emailVerified: true });
  await createMembership({ userId: user.id, orgId: DEFAULT_ORG_ID, role: 'owner' });
  console.warn(`[bootstrap] created owner ${email}`);
}
