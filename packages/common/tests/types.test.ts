import { describe, it, expect } from 'vitest';
import type { NormalizedFinding, FixAttempt, Organization } from '../src';

describe('common types', () => {
  it('should allow constructing a NormalizedFinding', () => {
    const finding: NormalizedFinding = {
      externalId: 'CVE-2024-0001',
      scanner: 'snyk',
      title: 'Prototype Pollution in lodash',
      description: 'lodash < 4.17.21 is vulnerable to prototype pollution',
      severity: 'high',
      repo: 'org/api-service',
      rawPayload: {},
    };

    expect(finding.scanner).toBe('snyk');
    expect(finding.severity).toBe('high');
  });

  it('should allow constructing a FixAttempt', () => {
    const attempt: FixAttempt = {
      id: '1',
      findingId: '1',
      orgId: '1',
      promptSnapshot: 'fix this',
      generatedDiff: '--- a/file\n+++ b/file',
      testResult: 'pass',
      claudeModel: 'claude-sonnet-4-20250514',
      claudeTokensUsed: 1500,
      createdAt: new Date(),
    };

    expect(attempt.testResult).toBe('pass');
  });

  it('should allow constructing an Organization', () => {
    const org: Organization = {
      id: '1',
      name: 'Test Org',
      plan: 'pilot',
      settings: {
        autoFixSeverityThreshold: 'high',
        autoMerge: false,
        branchStrategy: { targetBranch: 'develop', namingConvention: 'vulnfix/{id}' },
        notificationChannels: [],
        reviewAssignment: {},
      },
      customPrompts: {},
      createdAt: new Date(),
    };

    expect(org.settings.autoMerge).toBe(false);
  });
});
