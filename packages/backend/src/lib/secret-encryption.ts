import * as crypto from 'crypto';

/**
 * AES-256-GCM helpers for encrypting secret fields stored in Redis job
 * payloads (Aikido / Anthropic / GitHub credentials). Mirrors the format of
 * the dashboard's lib/crypto.ts ("iv:ct:tag" hex) so the same key can decrypt
 * either side, but reads its key from the backend's own environment and uses
 * Node's crypto directly (no cross-package import).
 *
 * Key derivation: sha256(INTEGRATION_ENCRYPTION_KEY). The dashboard already
 * fails fast on a missing/weak key at boot (lib/encryption-config.ts); the
 * backend reuses the same env var so dashboard-encrypted values round-trip.
 */

// Legacy var name accepted during the transition, matching the dashboard's
// getIntegrationEncryptionSecret() resolution order.
function resolveSecret(): string {
  const next = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (next != null && next !== '') return next;
  const legacy = process.env.SNYK_ENCRYPTION_SECRET;
  if (legacy != null && legacy !== '') return legacy;
  return '';
}

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/** Matches the "iv:ct:tag" hex shape: three hex groups separated by colons. */
function looksEncrypted(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 3 && parts.every((p) => p.length > 0 && /^[0-9a-f]+$/i.test(p));
}

/**
 * Encrypt a plaintext secret. Returns "iv:ct:tag" hex. Empty input is returned
 * as-is so optional/absent fields stay falsy.
 */
export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  const key = deriveKey(resolveSecret());
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

/**
 * Decrypt a value produced by encryptSecret. Values that are not in the
 * encrypted "iv:ct:tag" shape are returned unchanged, so old in-flight jobs and
 * plaintext config fallbacks keep working. A decryption failure (wrong key /
 * tampered ciphertext) also returns the input unchanged rather than throwing,
 * to avoid wedging a job that BullMQ would otherwise endlessly retry.
 */
export function decryptSecret(str: string): string {
  if (!str || !looksEncrypted(str)) return str;
  try {
    const key = deriveKey(resolveSecret());
    const [ivHex, encryptedHex, authTagHex] = str.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return str;
  }
}
