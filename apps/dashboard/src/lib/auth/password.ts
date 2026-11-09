import 'server-only';
import { hash, verify } from '@node-rs/argon2';

// OWASP 2025 baseline for argon2id.
const ARGON2_OPTS = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 12) {
    throw new Error('Password must be at least 12 characters');
  }
  return hash(plain, ARGON2_OPTS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}
