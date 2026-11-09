import * as crypto from 'crypto';

/**
 * Shared AES-256-GCM helpers for encrypting/decrypting JSON cookie payloads.
 * Mirrors the pattern used in github.ts for installation data.
 */

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptJson<T>(data: T, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

export function decryptJson<T>(encryptedStr: string, secret: string): T | null {
  try {
    const key = deriveKey(secret);
    const [ivHex, encryptedHex, authTagHex] = encryptedStr.split(':');

    if (!ivHex || !encryptedHex || !authTagHex) {
      return null;
    }

    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  } catch {
    return null;
  }
}
