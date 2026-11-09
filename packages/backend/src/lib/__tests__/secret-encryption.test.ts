import { describe, it, expect, beforeAll } from 'vitest';
import { encryptSecret, decryptSecret } from '../secret-encryption';

// secret-encryption.ts resolves the key from the process env at call time, so a
// strong key set before the round-trip cases guarantees real AES-256-GCM.
beforeAll(() => {
  process.env.INTEGRATION_ENCRYPTION_KEY =
    'test-integration-key-0123456789abcdef0123456789abcdef';
});

describe('encryptSecret / decryptSecret round-trip', () => {
  it('round-trips an arbitrary plaintext secret', () => {
    const plain = 'sk-ant-api03-abcdef0123456789';
    const enc = encryptSecret(plain);
    expect(enc).not.toBe(plain);
    expect(enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('round-trips the aikido clientId:clientSecret combined form', () => {
    const plain = 'client-id-123:client-secret-xyz';
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });

  it('produces a fresh IV each call (ciphertext differs, plaintext matches)', () => {
    const plain = 'snyk-token-value';
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it('returns empty input unchanged (encrypted_secret NOT NULL guard lives in the route)', () => {
    expect(encryptSecret('')).toBe('');
  });

  it('returns non-encrypted-shaped input unchanged from decryptSecret', () => {
    expect(decryptSecret('plaintext-not-iv-ct-tag')).toBe('plaintext-not-iv-ct-tag');
    expect(decryptSecret('')).toBe('');
  });

  it('returns input unchanged (no throw) when ciphertext is tampered', () => {
    const enc = encryptSecret('tamper-me');
    const [iv, ct, tag] = enc.split(':');
    // Flip the last hex nibble of the ciphertext to break the GCM auth tag.
    const flipped = ct.slice(0, -1) + (ct.slice(-1) === '0' ? '1' : '0');
    const tampered = `${iv}:${flipped}:${tag}`;
    expect(() => decryptSecret(tampered)).not.toThrow();
    expect(decryptSecret(tampered)).toBe(tampered);
  });
});
