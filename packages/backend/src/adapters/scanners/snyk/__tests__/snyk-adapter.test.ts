import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SnykAdapter } from '../snyk-adapter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validWebhookPayload = {
  newIssues: [
    {
      id: 'SNYK-JS-LODASH-567746',
      issueType: 'vuln',
      pkgName: 'lodash',
      pkgVersions: ['4.17.15'],
      priorityScore: 686,
      issueData: {
        id: 'SNYK-JS-LODASH-567746',
        title: 'Prototype Pollution',
        severity: 'high',
        cvssScore: 7.7,
        cwe: ['CWE-400', 'CWE-1321'],
        cve: 'CVE-2020-8203',
        description: 'Affected versions of lodash are vulnerable to Prototype Pollution.',
      },
      fixInfo: {
        nearestFixedInVersion: '4.17.21',
      },
    },
  ],
  project: { name: 'acme/backend' },
};

const criticalIssuePayload = {
  newIssues: [
    {
      id: 'SNYK-JS-AXIOS-6032459',
      issueType: 'vuln',
      pkgName: 'axios',
      pkgVersions: ['0.21.1'],
      priorityScore: 900,
      issueData: {
        id: 'SNYK-JS-AXIOS-6032459',
        title: 'Server-Side Request Forgery (SSRF)',
        severity: 'critical',
        cvssScore: 9.8,
        cwe: ['CWE-918'],
        cve: 'CVE-2023-45857',
      },
      fixInfo: {},
    },
  ],
  project: { name: 'acme/frontend' },
};

const minimalIssuePayload = {
  newIssues: [
    {
      id: 'SNYK-PYTHON-REQUESTS-001',
      issueType: 'vuln',
      pkgName: 'requests',
      pkgVersions: ['2.25.0'],
      priorityScore: 300,
      issueData: {
        id: 'SNYK-PYTHON-REQUESTS-001',
        title: 'ReDoS vulnerability',
        severity: 'medium',
        // no cvssScore, cwe, cve, description
      },
      // no fixInfo
    },
  ],
  project: { name: 'acme/service' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SnykAdapter', () => {
  let adapter: SnykAdapter;

  beforeEach(() => {
    adapter = new SnykAdapter();
  });

  describe('name', () => {
    it('is "snyk"', () => {
      expect(adapter.name).toBe('snyk');
    });
  });

  // -------------------------------------------------------------------------
  // normalizeWebhookPayload
  // -------------------------------------------------------------------------

  describe('normalizeWebhookPayload', () => {
    it('returns [] for null payload', () => {
      expect(adapter.normalizeWebhookPayload(null)).toEqual([]);
    });

    it('returns [] for non-object payload', () => {
      expect(adapter.normalizeWebhookPayload('invalid')).toEqual([]);
      expect(adapter.normalizeWebhookPayload(42)).toEqual([]);
    });

    it('returns [] when newIssues is missing', () => {
      expect(adapter.normalizeWebhookPayload({ project: { name: 'test' } })).toEqual([]);
    });

    it('returns [] when project is missing', () => {
      expect(adapter.normalizeWebhookPayload({ newIssues: [] })).toEqual([]);
    });

    it('returns [] for empty newIssues array', () => {
      const result = adapter.normalizeWebhookPayload({
        newIssues: [],
        project: { name: 'acme/test' },
      });
      expect(result).toEqual([]);
    });

    it('maps a valid payload with all fields correctly', () => {
      const findings = adapter.normalizeWebhookPayload(validWebhookPayload);

      expect(findings).toHaveLength(1);
      const f = findings[0];

      expect(f.scanner).toBe('snyk');
      expect(f.externalId).toBe('SNYK-JS-LODASH-567746');
      expect(f.title).toBe('Prototype Pollution');
      expect(f.description).toBe('Affected versions of lodash are vulnerable to Prototype Pollution.');
      expect(f.severity).toBe('high');
      expect(f.cvssScore).toBe(7.7);
      expect(f.cweId).toBe('CWE-400');
      expect(f.cveId).toBe('CVE-2020-8203');
      expect(f.packageName).toBe('lodash');
      expect(f.currentVersion).toBe('4.17.15');
      expect(f.fixedVersion).toBe('4.17.21');
      expect(f.repo).toBe('acme/backend');
    });

    it('maps severity correctly for all levels', () => {
      const severities = ['critical', 'high', 'medium', 'low'] as const;

      for (const severity of severities) {
        const payload = {
          newIssues: [
            {
              id: `issue-${severity}`,
              issueType: 'vuln',
              pkgName: 'pkg',
              pkgVersions: ['1.0.0'],
              priorityScore: 100,
              issueData: { id: `issue-${severity}`, title: 'Test', severity },
            },
          ],
          project: { name: 'test/repo' },
        };
        const findings = adapter.normalizeWebhookPayload(payload);
        expect(findings[0].severity).toBe(severity);
      }
    });

    it('defaults unknown severity to "low"', () => {
      const payload = {
        newIssues: [
          {
            id: 'issue-unknown',
            issueType: 'vuln',
            pkgName: 'pkg',
            pkgVersions: ['1.0.0'],
            priorityScore: 100,
            issueData: { id: 'issue-unknown', title: 'Test', severity: 'informational' },
          },
        ],
        project: { name: 'test/repo' },
      };
      const findings = adapter.normalizeWebhookPayload(payload);
      expect(findings[0].severity).toBe('low');
    });

    it('maps critical severity and no fixedVersion when fixInfo is empty', () => {
      const findings = adapter.normalizeWebhookPayload(criticalIssuePayload);
      expect(findings).toHaveLength(1);
      const f = findings[0];

      expect(f.severity).toBe('critical');
      expect(f.cvssScore).toBe(9.8);
      expect(f.cweId).toBe('CWE-918');
      expect(f.cveId).toBe('CVE-2023-45857');
      expect(f.fixedVersion).toBeUndefined();
      expect(f.repo).toBe('acme/frontend');
    });

    it('handles missing optional fields gracefully', () => {
      const findings = adapter.normalizeWebhookPayload(minimalIssuePayload);
      expect(findings).toHaveLength(1);
      const f = findings[0];

      expect(f.cvssScore).toBeUndefined();
      expect(f.cweId).toBeUndefined();
      expect(f.cveId).toBeUndefined();
      expect(f.fixedVersion).toBeUndefined();
      expect(f.description).toBe('ReDoS vulnerability');
    });

    it('uses first CWE from the array', () => {
      const findings = adapter.normalizeWebhookPayload(validWebhookPayload);
      // validWebhookPayload has cwe: ['CWE-400', 'CWE-1321']
      expect(findings[0].cweId).toBe('CWE-400');
    });

    it('uses first pkgVersion as currentVersion', () => {
      const payload = {
        newIssues: [
          {
            id: 'test-id',
            issueType: 'vuln',
            pkgName: 'express',
            pkgVersions: ['4.17.1', '4.17.2'],
            priorityScore: 500,
            issueData: { id: 'test-id', title: 'XSS', severity: 'medium' },
          },
        ],
        project: { name: 'test/repo' },
      };
      const findings = adapter.normalizeWebhookPayload(payload);
      expect(findings[0].currentVersion).toBe('4.17.1');
    });

    it('preserves the raw payload', () => {
      const findings = adapter.normalizeWebhookPayload(validWebhookPayload);
      expect(findings[0].rawPayload).toBeDefined();
      expect((findings[0].rawPayload as { id: string }).id).toBe('SNYK-JS-LODASH-567746');
    });
  });

  // -------------------------------------------------------------------------
  // fetchFindings
  // -------------------------------------------------------------------------

  describe('fetchFindings', () => {
    it('calls Snyk REST API with correct URL and auth header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const config = { apiKey: 'test-token', orgId: 'org-123' };
      await adapter.fetchFindings(config);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.snyk.io/rest/orgs/org-123/issues?version=2024-10-15&limit=100',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test-token',
          }),
        }),
      );

      vi.unstubAllGlobals();
    });

    it('uses custom baseUrl when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const config = {
        apiKey: 'test-token',
        orgId: 'org-456',
        baseUrl: 'https://custom.snyk.io',
      };
      await adapter.fetchFindings(config);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.snyk.io/rest/orgs/org-456/issues?version=2024-10-15&limit=100',
        expect.anything(),
      );

      vi.unstubAllGlobals();
    });

    it('returns empty array when data is empty', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }));

      const result = await adapter.fetchFindings({ apiKey: 'key', orgId: 'org' });
      expect(result).toEqual([]);

      vi.unstubAllGlobals();
    });

    it('throws when the API returns a non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      }));

      await expect(
        adapter.fetchFindings({ apiKey: 'bad-key', orgId: 'org' }),
      ).rejects.toThrow('Snyk API error: 401');

      vi.unstubAllGlobals();
    });

    it('maps API issues to NormalizedFinding[]', async () => {
      const mockIssue: Record<string, unknown> = {
        id: 'api-issue-001',
        attributes: {
          title: 'Insecure Deserialization',
          severity: 'high',
          description: 'Object deserialization vulnerability.',
          coordinates: [
            {
              representations: [
                { dependency: { package_name: 'serialize-js', package_version: '0.5.0' } },
              ],
            },
          ],
          problems: [
            { id: 'CVE-2021-12345', type: 'vulnerability', source: 'NVD' },
          ],
        },
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [mockIssue] }),
      }));

      const result = await adapter.fetchFindings({ apiKey: 'key', orgId: 'org' });

      expect(result).toHaveLength(1);
      const f = result[0];
      expect(f.scanner).toBe('snyk');
      expect(f.externalId).toBe('api-issue-001');
      expect(f.title).toBe('Insecure Deserialization');
      expect(f.severity).toBe('high');
      expect(f.cveId).toBe('CVE-2021-12345');
      expect(f.packageName).toBe('serialize-js');
      expect(f.currentVersion).toBe('0.5.0');

      vi.unstubAllGlobals();
    });
  });
});
