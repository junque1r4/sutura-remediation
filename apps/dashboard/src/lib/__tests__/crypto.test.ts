import { describe, it, expect } from 'vitest';
import { encryptJson, decryptJson } from '../crypto';

const SECRET = 'a-strong-32-byte-or-longer-test-secret-value-1234567890';

describe('crypto: encryptJson / decryptJson', () => {
  it('round-trips an object back to the original value', () => {
    const data = {
      token: 'snyk-pat-abc123',
      orgId: 'org_singleton',
      nested: { scopes: ['read', 'write'], count: 2 },
    };

    const encrypted = encryptJson(data, SECRET);
    const decrypted = decryptJson<typeof data>(encrypted, SECRET);

    expect(decrypted).toEqual(data);
  });

  it('produces ciphertext that is not the plaintext JSON', () => {
    const data = { token: 'super-secret-token' };
    const plaintext = JSON.stringify(data);

    const encrypted = encryptJson(data, SECRET);

    expect(encrypted).not.toEqual(plaintext);
    expect(encrypted).not.toContain('super-secret-token');
  });

  it('emits the "iv:ct:authTag" hex format', () => {
    const encrypted = encryptJson({ a: 1 }, SECRET);
    const parts = encrypted.split(':');

    expect(parts).toHaveLength(3);
    const [ivHex, ctHex, authTagHex] = parts;
    // IV is 16 bytes -> 32 hex chars; GCM auth tag is 16 bytes -> 32 hex chars.
    expect(ivHex).toMatch(/^[0-9a-f]{32}$/);
    expect(authTagHex).toMatch(/^[0-9a-f]{32}$/);
    expect(ctHex).toMatch(/^[0-9a-f]+$/);
  });

  it('returns null for a tampered ciphertext (auth tag mismatch)', () => {
    const encrypted = encryptJson({ token: 'abc' }, SECRET);
    const [ivHex, ctHex, authTagHex] = encrypted.split(':');

    // Flip the last hex nibble of the ciphertext to break the GCM auth tag.
    const lastChar = ctHex.slice(-1);
    const flipped = lastChar === '0' ? '1' : '0';
    const tamperedCt = ctHex.slice(0, -1) + flipped;
    const tampered = `${ivHex}:${tamperedCt}:${authTagHex}`;

    expect(decryptJson(tampered, SECRET)).toBeNull();
  });

  it('returns null for a malformed string (missing segments)', () => {
    expect(decryptJson('not-a-valid-payload', SECRET)).toBeNull();
    expect(decryptJson('', SECRET)).toBeNull();
    expect(decryptJson('aaaa:bbbb', SECRET)).toBeNull();
  });

  it('returns null when decrypting with the wrong secret', () => {
    const encrypted = encryptJson({ token: 'abc' }, SECRET);
    expect(decryptJson(encrypted, 'a-different-wrong-secret-value')).toBeNull();
  });
});
