import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the db layer before importing the route module ---
const getFinding = vi.fn();
const getFindingByExternal = vi.fn();

vi.mock('../../db/findings', () => ({
  listFindings: vi.fn(),
  getFinding: (...args: unknown[]) => getFinding(...args),
  getFindingByExternal: (...args: unknown[]) => getFindingByExternal(...args),
  updateFindingStatus: vi.fn(),
}));
vi.mock('../../db/analysis', () => ({ getLatestFindingAnalysis: vi.fn() }));

import { resolveFinding } from '../findings';

const ORG = 'org-1';
const UUID = '11111111-2222-3333-4444-555555555555';

describe('resolveFinding', () => {
  beforeEach(() => {
    getFinding.mockReset().mockResolvedValue(null);
    getFindingByExternal.mockReset().mockResolvedValue(null);
  });

  it('returns the UUID hit without trying the external lookup', async () => {
    const row = { id: UUID, org_id: ORG };
    getFinding.mockResolvedValue(row);

    const result = await resolveFinding(UUID, ORG);

    expect(result).toBe(row);
    expect(getFindingByExternal).not.toHaveBeenCalled();
  });

  it('falls back to scanner-externalId for synthetic deep-link ids', async () => {
    const row = { id: UUID, org_id: ORG };
    getFindingByExternal.mockResolvedValue(row);

    const result = await resolveFinding('aikido-76125716', ORG);

    expect(result).toBe(row);
    expect(getFindingByExternal).toHaveBeenCalledWith(ORG, 'aikido', '76125716');
  });

  it('keeps dashes after the first one inside the external id', async () => {
    await resolveFinding('snyk-SNYK-JS-AXIOS-12345', ORG);
    expect(getFindingByExternal).toHaveBeenCalledWith(ORG, 'snyk', 'SNYK-JS-AXIOS-12345');
  });

  it('returns null for unparseable ids without hitting the external lookup', async () => {
    expect(await resolveFinding('nodashhere', ORG)).toBeNull();
    expect(await resolveFinding('-leading', ORG)).toBeNull();
    expect(await resolveFinding('trailing-', ORG)).toBeNull();
    expect(getFindingByExternal).not.toHaveBeenCalled();
  });
});
