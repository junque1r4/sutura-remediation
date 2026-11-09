import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the pg pool before importing the module under test ---
const mockQuery = vi.fn();

vi.mock('../client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Encryption helpers read the key from env at call time.
process.env.INTEGRATION_ENCRYPTION_KEY = 'test-key-for-repo-prompts';

import { encryptSecret, decryptSecret } from '../../lib/secret-encryption';
import {
  upsertRepoPrompt,
  listRepoPrompts,
  getRepoPromptSecret,
  deleteRepoPrompt,
  getDerivedToolchain,
  upsertToolchainCheck,
  listToolchainChecks,
} from '../repo-prompts';
import type { SerializedToolchain } from '@sutura/common';

const VALID_TOOLCHAIN: SerializedToolchain = {
  language: 'dotnet',
  image: 'sutura/sandbox-base:latest',
  restoreCmd: ['sh', '-lc', 'dotnet restore'],
  testCmd: ['sh', '-lc', 'dotnet test --no-restore'],
  cachePaths: [],
  restoreNeedsPatch: false,
  appendTestPaths: false,
  testFramework: 'xunit',
  testFilePattern: 'Tests/{base}SuturaTests.cs',
};

beforeEach(() => {
  mockQuery.mockReset();
});

describe('upsertRepoPrompt', () => {
  it('encrypts before insert and builds a safe preview', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ repo: 'acme/api', kind: 'test_environment', prompt_preview: 'Use dotnet 8.', prompt_length: 32, updated_at: '2026-06-11T00:00:00Z' }],
    });

    await upsertRepoPrompt({
      orgId: 'org-1',
      repo: 'acme/api',
      kind: 'test_environment',
      prompt: 'Use dotnet 8.\nSecret detail here',
      createdBy: 'dev@acme.com',
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO repo_prompts'), expect.any(Array));
    const params = mockQuery.mock.calls[0][1] as unknown[];
    const stored = params.find((p) => typeof p === 'string' && (p as string).split(':').length === 3) as string;
    expect(stored).toBeDefined();
    expect(stored).not.toContain('dotnet'); // ciphertext, not plaintext
    expect(decryptSecret(stored)).toBe('Use dotnet 8.\nSecret detail here');
    // preview is first line only -- no second line content
    const preview = params.find((p) => p === 'Use dotnet 8.');
    expect(preview).toBeDefined();
    expect(params).not.toContain('Use dotnet 8.\nSecret detail here');
    // prompt_length param present
    expect(params).toContain('Use dotnet 8.\nSecret detail here'.length);
  });

  it('truncates the preview to 80 chars of the first line with an ellipsis', async () => {
    const longFirstLine = 'A'.repeat(120);
    mockQuery.mockResolvedValue({
      rows: [{ repo: 'acme/api', kind: 'test_environment', prompt_preview: 'p', prompt_length: 1, updated_at: null }],
    });

    await upsertRepoPrompt({ orgId: 'org-1', repo: 'acme/api', kind: 'test_environment', prompt: `${longFirstLine}\nrest` });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    const preview = params.find((p) => typeof p === 'string' && (p as string).endsWith('…')) as string;
    expect(preview).toBe(`${'A'.repeat(80)}…`);
  });

  it('rejects an empty or oversized prompt without querying', async () => {
    await expect(
      upsertRepoPrompt({ orgId: 'org-1', repo: 'acme/api', kind: 'test_environment', prompt: '' }),
    ).rejects.toThrow(/prompt/);
    await expect(
      upsertRepoPrompt({ orgId: 'org-1', repo: 'acme/api', kind: 'test_environment', prompt: 'x'.repeat(16_385) }),
    ).rejects.toThrow(/prompt/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('listRepoPrompts', () => {
  it('maps rows to status objects that never expose ciphertext or plaintext', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        repo: 'acme/api',
        kind: 'test_environment',
        prompt_preview: 'Use dotnet 8.',
        prompt_length: 32,
        updated_at: '2026-06-11T00:00:00Z',
      }],
    });

    const result = await listRepoPrompts('org-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM repo_prompts'), ['org-1']);
    // The SELECT must not request the encrypted column.
    expect(mockQuery.mock.calls[0][0]).not.toContain('encrypted_prompt');
    expect(result).toEqual([{
      repo: 'acme/api',
      kind: 'test_environment',
      hasPrompt: true,
      preview: 'Use dotnet 8.',
      promptLength: 32,
      updatedAt: '2026-06-11T00:00:00Z',
    }]);
    for (const entry of result) {
      expect(Object.keys(entry)).not.toContain('encrypted_prompt');
      expect(Object.keys(entry)).not.toContain('prompt');
    }
  });
});

describe('getRepoPromptSecret', () => {
  it('decrypts the stored prompt', async () => {
    const encrypted = encryptSecret('Use dotnet 8.\nSecret detail here');
    mockQuery.mockResolvedValue({ rows: [{ encrypted_prompt: encrypted }] });

    const secret = await getRepoPromptSecret('org-1', 'acme/api', 'test_environment');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT encrypted_prompt FROM repo_prompts'),
      ['org-1', 'acme/api', 'test_environment'],
    );
    expect(secret).toBe('Use dotnet 8.\nSecret detail here');
  });

  it('returns null when no prompt exists', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRepoPromptSecret('org-1', 'acme/api', 'test_environment')).toBeNull();
  });
});

describe('deleteRepoPrompt', () => {
  it('deletes the prompt and downgrades a custom_ready check to needs_prompt', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await deleteRepoPrompt('org-1', 'acme/api', 'test_environment');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain('DELETE FROM repo_prompts');
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'acme/api', 'test_environment']);
    const downgradeSql = mockQuery.mock.calls[1][0] as string;
    expect(downgradeSql).toContain('UPDATE repo_toolchain_checks');
    expect(downgradeSql).toContain(`'needs_prompt'`);
    expect(downgradeSql).toContain('derived_config_encrypted = NULL');
    expect(downgradeSql).toContain(`'custom_ready'`);
    expect(mockQuery.mock.calls[1][1]).toEqual(['org-1', 'acme/api']);
  });
});

describe('upsertToolchainCheck', () => {
  it('encrypts the derived config before insert', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        repo: 'acme/api', status: 'custom_ready', language: 'dotnet',
        test_framework: 'xunit', detail: null, checked_at: '2026-06-11T00:00:00Z',
      }],
    });

    const result = await upsertToolchainCheck({
      orgId: 'org-1', repo: 'acme/api', status: 'custom_ready',
      language: 'dotnet', testFramework: 'xunit', derivedConfig: VALID_TOOLCHAIN,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    const stored = params.find((p) => typeof p === 'string' && (p as string).split(':').length === 3) as string;
    expect(stored).toBeDefined();
    expect(stored).not.toContain('dotnet');
    expect(JSON.parse(decryptSecret(stored))).toEqual(VALID_TOOLCHAIN);
    expect(result).toEqual({
      repo: 'acme/api', status: 'custom_ready', language: 'dotnet',
      testFramework: 'xunit', detail: null, checkedAt: '2026-06-11T00:00:00Z',
    });
  });

  it('stores NULL config when no derived config is provided', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ repo: 'acme/api', status: 'needs_prompt', language: null, test_framework: null, detail: 'hint', checked_at: '2026-06-11T00:00:00Z' }],
    });

    const result = await upsertToolchainCheck({ orgId: 'org-1', repo: 'acme/api', status: 'needs_prompt', detail: 'hint' });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain(null);
    expect(params.some((p) => typeof p === 'string' && (p as string).split(':').length === 3)).toBe(false);
    expect(result.status).toBe('needs_prompt');
    expect(result.detail).toBe('hint');
  });
});

describe('listToolchainChecks', () => {
  it('maps rows and never selects the encrypted config', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ repo: 'acme/api', status: 'supported', language: 'node', test_framework: 'vitest', detail: null, checked_at: '2026-06-11T00:00:00Z' }],
    });

    const result = await listToolchainChecks('org-1');

    expect(mockQuery.mock.calls[0][0]).not.toContain('derived_config_encrypted');
    expect(result).toEqual([{
      repo: 'acme/api', status: 'supported', language: 'node',
      testFramework: 'vitest', detail: null, checkedAt: '2026-06-11T00:00:00Z',
    }]);
  });
});

describe('getDerivedToolchain', () => {
  it('decrypts and validates a stored toolchain', async () => {
    const encrypted = encryptSecret(JSON.stringify(VALID_TOOLCHAIN));
    mockQuery.mockResolvedValue({ rows: [{ derived_config_encrypted: encrypted }] });

    const result = await getDerivedToolchain('org-1', 'acme/api');

    expect(mockQuery.mock.calls[0][0]).toContain(`status = 'custom_ready'`);
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'acme/api']);
    expect(result).toEqual(VALID_TOOLCHAIN);
  });

  it('returns null when no row or no config exists', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getDerivedToolchain('org-1', 'acme/api')).toBeNull();

    mockQuery.mockResolvedValue({ rows: [{ derived_config_encrypted: null }] });
    expect(await getDerivedToolchain('org-1', 'acme/api')).toBeNull();
  });

  it('returns null for a tampered row that fails validation', async () => {
    // Valid encryption, invalid content: image outside the allowlist.
    const tampered = encryptSecret(JSON.stringify({ ...VALID_TOOLCHAIN, image: 'evil/image:latest' }));
    mockQuery.mockResolvedValue({ rows: [{ derived_config_encrypted: tampered }] });
    expect(await getDerivedToolchain('org-1', 'acme/api')).toBeNull();
  });

  it('returns null for undecryptable garbage', async () => {
    mockQuery.mockResolvedValue({ rows: [{ derived_config_encrypted: 'deadbeef:deadbeef:deadbeef' }] });
    expect(await getDerivedToolchain('org-1', 'acme/api')).toBeNull();
  });
});
