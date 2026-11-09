import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the pg pool before importing the repository ---
const mockQuery = vi.fn();

vi.mock('../client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Use a deterministic key so encryptSecret/decryptSecret round-trip.
process.env.INTEGRATION_ENCRYPTION_KEY =
  process.env.INTEGRATION_ENCRYPTION_KEY ?? 'test-integration-encryption-key-1234567890';

// Import AFTER mock registration.
import { getConnectionSecret } from '../connections';
import { encryptSecret } from '../../lib/secret-encryption';

const ORG = 'org-uuid-001';

function makeRow(encrypted_secret: string) {
  return {
    id: 'conn-1',
    org_id: ORG,
    provider: 'anthropic',
    encrypted_secret,
    masked_identifier: 'sk-ant-api0...abcd',
    metadata_json: {},
    connected_by: 'user@example.com',
    connected_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('getConnectionSecret (worker-side DB resolver)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns the decrypted plaintext secret for a connected provider', async () => {
    const plaintext = 'sk-ant-api03-secret-value';
    mockQuery.mockResolvedValueOnce({ rows: [makeRow(encryptSecret(plaintext))] });

    const secret = await getConnectionSecret(ORG, 'anthropic');

    expect(secret).toBe(plaintext);
    // Scoped by org + provider.
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('integration_connections'), [
      ORG,
      'anthropic',
    ]);
  });

  it('returns null when the provider is not connected (no row)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getConnectionSecret(ORG, 'snyk')).toBeNull();
  });

  it('returns null when the stored secret decrypts to an empty string', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow('')] });
    expect(await getConnectionSecret(ORG, 'anthropic')).toBeNull();
  });

  it('round-trips the combined aikido clientId:clientSecret secret', async () => {
    const combined = 'client-id-123:client-secret-456';
    mockQuery.mockResolvedValueOnce({ rows: [makeRow(encryptSecret(combined))] });

    const secret = await getConnectionSecret(ORG, 'aikido');
    expect(secret).toBe(combined);
    expect(secret?.split(':')).toEqual(['client-id-123', 'client-secret-456']);
  });
});
