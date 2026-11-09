import { describe, it, expect } from 'vitest';
import { triage } from '../pipeline/triage';
import type { NormalizedFinding } from '@sutura/common';

function makeFinding(severity: NormalizedFinding['severity']): NormalizedFinding {
  return {
    externalId: 'test-123',
    scanner: 'snyk',
    title: 'Test vulnerability',
    description: 'A test vulnerability',
    severity,
    repo: 'owner/repo',
    rawPayload: {},
  };
}

describe('triage', () => {
  describe('default threshold (medium)', () => {
    it('should skip low severity findings', () => {
      const result = triage(makeFinding('low'));
      expect(result.shouldFix).toBe(false);
      expect(result.reason).toContain('low');
      expect(result.reason).toContain('medium');
    });

    it('should fix medium severity findings', () => {
      const result = triage(makeFinding('medium'));
      expect(result.shouldFix).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should fix high severity findings', () => {
      const result = triage(makeFinding('high'));
      expect(result.shouldFix).toBe(true);
    });

    it('should fix critical severity findings', () => {
      const result = triage(makeFinding('critical'));
      expect(result.shouldFix).toBe(true);
    });
  });

  describe('custom threshold', () => {
    it('should skip medium findings when threshold is high', () => {
      const result = triage(makeFinding('medium'), 'high');
      expect(result.shouldFix).toBe(false);
      expect(result.reason).toContain('medium');
      expect(result.reason).toContain('high');
    });

    it('should skip low findings when threshold is critical', () => {
      const result = triage(makeFinding('low'), 'critical');
      expect(result.shouldFix).toBe(false);
    });

    it('should fix critical findings when threshold is critical', () => {
      const result = triage(makeFinding('critical'), 'critical');
      expect(result.shouldFix).toBe(true);
    });

    it('should fix high findings when threshold is high', () => {
      const result = triage(makeFinding('high'), 'high');
      expect(result.shouldFix).toBe(true);
    });

    it('should fix critical findings when threshold is low', () => {
      const result = triage(makeFinding('critical'), 'low');
      expect(result.shouldFix).toBe(true);
    });
  });

  it('should return the finding unchanged', () => {
    const finding = makeFinding('high');
    const result = triage(finding);
    expect(result.finding).toBe(finding);
  });
});
