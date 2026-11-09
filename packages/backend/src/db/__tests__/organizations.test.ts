import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrganizationSettings, CustomPrompts } from '@sutura/common';

// --- Mock the pg pool before importing the repository ---
const mockQuery = vi.fn();

vi.mock('../client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Import AFTER mock registration
import {
  getOrganization,
  createOrganization,
  updateSettings,
  updateCustomPrompts,
} from '../organizations';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeDbOrg = (overrides: Record<string, unknown> = {}) => ({
  id: 'org-uuid-001',
  name: 'Acme Corp',
  plan: 'pilot',
  settings_json: {
    autoFixSeverityThreshold: 'high',
    autoMerge: false,
    branchStrategy: { targetBranch: 'main', namingConvention: 'sutura/fix-{id}' },
    notificationChannels: [],
    reviewAssignment: {},
  },
  custom_prompts_json: {},
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

const makeSettings = (overrides: Partial<OrganizationSettings> = {}): OrganizationSettings => ({
  autoFixSeverityThreshold: 'critical',
  autoMerge: true,
  branchStrategy: { targetBranch: 'main', namingConvention: 'sutura/fix-{id}' },
  notificationChannels: [],
  reviewAssignment: {},
  ...overrides,
});

const makeCustomPrompts = (overrides: Partial<CustomPrompts> = {}): CustomPrompts => ({
  environmentSetup: 'Run npm install',
  testingInstructions: 'Run npm test',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('organizations repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getSingletonOrgId (single-tenant invariant)
  // -------------------------------------------------------------------------
  describe('getSingletonOrgId', () => {
    beforeEach(() => {
      // The helper memoizes in module scope; reset modules so each case starts
      // from a clean memo. The '../client' mock is re-applied to fresh imports.
      vi.resetModules();
      vi.clearAllMocks();
    });

    it('returns the id when exactly one organization exists', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'org-uuid-001' }] });
      const { getSingletonOrgId } = await import('../organizations');

      await expect(getSingletonOrgId()).resolves.toBe('org-uuid-001');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM organizations'),
      );
    });

    it('memoizes the result (one query across repeated calls)', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'org-uuid-001' }] });
      const { getSingletonOrgId } = await import('../organizations');

      await getSingletonOrgId();
      await getSingletonOrgId();
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('throws when no organization exists', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const { getSingletonOrgId } = await import('../organizations');

      await expect(getSingletonOrgId()).rejects.toThrow(/expected exactly 1 organization, found 0/);
    });

    it('throws when more than one organization exists', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }] });
      const { getSingletonOrgId } = await import('../organizations');

      await expect(getSingletonOrgId()).rejects.toThrow(/found 2/);
    });
  });

  // -------------------------------------------------------------------------
  // getOrganization
  // -------------------------------------------------------------------------
  describe('getOrganization', () => {
    it('fetches organization by id', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbOrg()] });

      const result = await getOrganization('org-uuid-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM organizations WHERE id'),
        ['org-uuid-001'],
      );
      expect(result?.id).toBe('org-uuid-001');
      expect(result?.name).toBe('Acme Corp');
      expect(result?.plan).toBe('pilot');
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await getOrganization('non-existent');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // createOrganization
  // -------------------------------------------------------------------------
  describe('createOrganization', () => {
    it('inserts organization with provided name and default plan', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbOrg()] });

      const result = await createOrganization({ name: 'Acme Corp' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO organizations'),
        ['Acme Corp', 'pilot'],
      );
      expect(result.id).toBe('org-uuid-001');
    });

    it('uses provided plan when specified', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbOrg({ plan: 'enterprise' })] });

      const result = await createOrganization({ name: 'BigCo', plan: 'enterprise' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO organizations'),
        ['BigCo', 'enterprise'],
      );
      expect(result.plan).toBe('enterprise');
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Duplicate key'));

      await expect(createOrganization({ name: 'Acme Corp' })).rejects.toThrow('Duplicate key');
    });
  });

  // -------------------------------------------------------------------------
  // updateSettings
  // -------------------------------------------------------------------------
  describe('updateSettings', () => {
    it('updates settings_json column', async () => {
      const settings = makeSettings();
      mockQuery.mockResolvedValue({ rows: [makeDbOrg({ settings_json: settings })] });

      const result = await updateSettings('org-uuid-001', settings);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE organizations SET settings_json'),
        [JSON.stringify(settings), 'org-uuid-001'],
      );
      expect(result.settings_json).toMatchObject({ autoMerge: true });
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Update failed'));

      await expect(updateSettings('org-uuid-001', makeSettings())).rejects.toThrow('Update failed');
    });
  });

  // -------------------------------------------------------------------------
  // updateCustomPrompts
  // -------------------------------------------------------------------------
  describe('updateCustomPrompts', () => {
    it('updates custom_prompts_json column', async () => {
      const prompts = makeCustomPrompts();
      mockQuery.mockResolvedValue({ rows: [makeDbOrg({ custom_prompts_json: prompts })] });

      const result = await updateCustomPrompts('org-uuid-001', prompts);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE organizations SET custom_prompts_json'),
        [JSON.stringify(prompts), 'org-uuid-001'],
      );
      expect(result.custom_prompts_json).toMatchObject({ environmentSetup: 'Run npm install' });
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Update failed'));

      await expect(updateCustomPrompts('org-uuid-001', makeCustomPrompts())).rejects.toThrow(
        'Update failed',
      );
    });
  });
});
