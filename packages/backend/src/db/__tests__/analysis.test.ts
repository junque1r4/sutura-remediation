import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the pg pool before importing the repository ---
const mockQuery = vi.fn();

vi.mock('../client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Import AFTER mock registration
import { createFindingAnalysis, getLatestFindingAnalysis } from '../analysis';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

const makeDbAnalysis = (overrides: Record<string, unknown> = {}) => ({
  id: 'analysis-uuid-001',
  finding_id: VALID_UUID,
  org_id: 'org-1',
  analysis_md: '### Risk Assessment\nSerious.',
  model: 'claude-sonnet-4-6',
  input_tokens: 100,
  output_tokens: 50,
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('finding-analyses repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createFindingAnalysis', () => {
    it('inserts an analysis row and returns it', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbAnalysis()] });

      const result = await createFindingAnalysis({
        finding_id: VALID_UUID,
        org_id: 'org-1',
        analysis_md: '### Risk Assessment\nSerious.',
        model: 'claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 50,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO finding_analyses'),
        [VALID_UUID, 'org-1', '### Risk Assessment\nSerious.', 'claude-sonnet-4-6', 100, 50],
      );
      expect(result.id).toBe('analysis-uuid-001');
      expect(result.finding_id).toBe(VALID_UUID);
    });

    it('defaults model to null and token counts to 0', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbAnalysis()] });

      await createFindingAnalysis({
        finding_id: VALID_UUID,
        org_id: 'org-1',
        analysis_md: 'body',
      });

      expect(mockQuery.mock.calls[0][1]).toEqual([VALID_UUID, 'org-1', 'body', null, 0, 0]);
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Insert failed'));

      await expect(
        createFindingAnalysis({ finding_id: VALID_UUID, org_id: 'org-1', analysis_md: 'x' }),
      ).rejects.toThrow('Insert failed');
    });
  });

  describe('getLatestFindingAnalysis', () => {
    it('fetches the most recent analysis ordered by created_at desc', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbAnalysis()] });

      const result = await getLatestFindingAnalysis(VALID_UUID);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY created_at DESC'),
        [VALID_UUID],
      );
      expect(result?.id).toBe('analysis-uuid-001');
    });

    it('returns null without querying for a non-UUID id', async () => {
      const result = await getLatestFindingAnalysis('aikido-12345');
      expect(result).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns null when no analysis exists', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await getLatestFindingAnalysis(VALID_UUID);
      expect(result).toBeNull();
    });
  });
});
