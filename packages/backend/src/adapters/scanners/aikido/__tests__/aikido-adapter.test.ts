import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AikidoAdapter } from '../aikido-adapter';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTokenResponse(token = 'test-access-token') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
    }),
  };
}

function makeIssuesResponse(issues: unknown[], asDataWrapper = false) {
  const body = asDataWrapper ? { data: issues } : issues;
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'error' }),
  };
}

const baseIssue = {
  id: 42,
  group_id: 1,
  type: 'sca',
  rule: null,
  severity: 'high',
  severity_score: 80,
  status: 'open',
  code_repo_name: 'org/repo',
  affected_package: 'lodash',
  affected_file: null,
  cve_id: 'CVE-2021-23337',
  cwe_classes: ['CWE-77'],
  installed_version: '4.17.0',
  patched_versions: ['4.17.21'],
  first_detected_at: 1700000000,
  start_line: null,
  end_line: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AikidoAdapter', () => {
  let adapter: AikidoAdapter;

  beforeEach(() => {
    adapter = new AikidoAdapter();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // normalizeWebhookPayload
  // -------------------------------------------------------------------------

  describe('normalizeWebhookPayload', () => {
    it('returns a NormalizedFinding for a valid webhook payload', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 101,
          type: 'sca',
          severity_score: 75,
          severity: 'high',
          status: 'open',
          title: 'CVE-2021-23337 in lodash',
          code_repo_name: 'org/my-repo',
          affected_file: '/src/index.ts',
          cwe_classes: ['CWE-77'],
          affected_package: 'lodash',
          installed_version: '4.17.0',
          patched_versions: ['4.17.21'],
        },
      };

      const results = adapter.normalizeWebhookPayload(payload);

      expect(results).toHaveLength(1);
      const finding = results[0];
      expect(finding.externalId).toBe('101');
      expect(finding.scanner).toBe('aikido');
      expect(finding.title).toBe('CVE-2021-23337 in lodash');
      expect(finding.severity).toBe('high');
      expect(finding.cvssScore).toBeCloseTo(7.5);
      expect(finding.cweId).toBe('CWE-77');
      expect(finding.filePath).toBe('/src/index.ts');
      expect(finding.repo).toBe('org/my-repo');
      expect(finding.packageName).toBe('lodash');
      expect(finding.currentVersion).toBe('4.17.0');
      expect(finding.fixedVersion).toBe('4.17.21');
    });

    it('returns empty array when event_type is missing', () => {
      const payload = {
        payload: {
          issue_id: 1,
          type: 'sca',
          severity_score: 50,
          severity: 'medium',
          status: 'open',
        },
      };

      const results = adapter.normalizeWebhookPayload(payload);
      expect(results).toEqual([]);
    });

    it('returns empty array when payload is missing', () => {
      const payload = {
        event_type: 'issue.created',
      };

      const results = adapter.normalizeWebhookPayload(payload);
      expect(results).toEqual([]);
    });

    it('returns empty array for an empty object', () => {
      const results = adapter.normalizeWebhookPayload({});
      expect(results).toEqual([]);
    });

    it('maps all required fields correctly', () => {
      const payload = {
        event_type: 'issue.updated',
        payload: {
          issue_id: 999,
          type: 'sast',
          severity_score: 90,
          severity: 'critical',
          status: 'open',
          title: 'Critical issue',
          code_repo_name: 'org/backend',
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.externalId).toBe('999');
      expect(finding.scanner).toBe('aikido');
      expect(finding.severity).toBe('critical');
      expect(finding.repo).toBe('org/backend');
    });

    it('uses "unknown" as repo when code_repo_name is absent', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 5,
          type: 'sca',
          severity_score: 30,
          severity: 'low',
          status: 'open',
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.repo).toBe('unknown');
    });

    it('falls back to generic title when title field is missing', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 7,
          type: 'sca',
          severity_score: 20,
          severity: 'low',
          status: 'open',
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.title).toBe('Aikido finding #7');
    });

    it('returns undefined for optional fields when absent', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 8,
          type: 'sca',
          severity_score: 40,
          severity: 'medium',
          status: 'open',
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.cweId).toBeUndefined();
      expect(finding.packageName).toBeUndefined();
      expect(finding.fixedVersion).toBeUndefined();
      expect(finding.filePath).toBeUndefined();
      expect(finding.currentVersion).toBeUndefined();
    });

    it('uses first cwe_class as cweId', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 9,
          type: 'sca',
          severity_score: 50,
          severity: 'medium',
          status: 'open',
          cwe_classes: ['CWE-89', 'CWE-22'],
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.cweId).toBe('CWE-89');
    });

    it('caps cvssScore at 10 even if severity_score is large', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 10,
          type: 'sca',
          severity_score: 1000,
          severity: 'critical',
          status: 'open',
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.cvssScore).toBe(10);
    });

    it('sets cvssScore to undefined when severity_score is 0 / falsy', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 11,
          type: 'sca',
          severity_score: 0,
          severity: 'low',
          status: 'open',
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.cvssScore).toBeUndefined();
    });

    it('divides severity_score by 10 for cvssScore', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 12,
          type: 'sca',
          severity_score: 55,
          severity: 'medium',
          status: 'open',
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.cvssScore).toBeCloseTo(5.5);
    });

    it('attaches the raw payload', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 13,
          type: 'sca',
          severity_score: 30,
          severity: 'low',
          status: 'open',
        },
      };

      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.rawPayload).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // fetchFindings
  // -------------------------------------------------------------------------

  describe('fetchFindings', () => {
    it('makes POST /api/oauth/token with Basic auth then GET issues and returns normalized findings', async () => {
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse('my-token'))
        .mockResolvedValueOnce(makeIssuesResponse([baseIssue]));

      const findings = await adapter.fetchFindings({ apiKey: 'client-id:client-secret' });

      // First call: auth
      const [authUrl, authOptions] = mockFetch.mock.calls[0];
      expect(authUrl).toContain('/api/oauth/token');
      expect(authOptions.method).toBe('POST');
      const expectedCredentials = Buffer.from('client-id:client-secret').toString('base64');
      expect(authOptions.headers.Authorization).toBe(`Basic ${expectedCredentials}`);

      // Second call: issues
      const [issuesUrl, issuesOptions] = mockFetch.mock.calls[1];
      expect(issuesUrl).toContain('/api/public/v1/issues/export');
      expect(issuesOptions.headers.Authorization).toBe('Bearer my-token');

      expect(findings).toHaveLength(1);
      expect(findings[0].externalId).toBe('42');
      expect(findings[0].scanner).toBe('aikido');
    });

    it('throws when auth request fails', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401));

      await expect(adapter.fetchFindings({ apiKey: 'id:secret' })).rejects.toThrow(
        'Aikido auth failed: 401',
      );
    });

    it('throws when issues API request fails', async () => {
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce(makeErrorResponse(500));

      await expect(adapter.fetchFindings({ apiKey: 'id:secret' })).rejects.toThrow(
        'Aikido API error: 500',
      );
    });

    it('throws when apiKey does not contain ":"', async () => {
      await expect(adapter.fetchFindings({ apiKey: 'invalid-key-no-colon' })).rejects.toThrow(
        'Aikido API key must be in format client_id:client_secret',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles issues response wrapped in { data: [] }', async () => {
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce(makeIssuesResponse([baseIssue], true));

      const findings = await adapter.fetchFindings({ apiKey: 'id:secret' });
      expect(findings).toHaveLength(1);
    });

    it('handles issues response as a plain array', async () => {
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce(makeIssuesResponse([baseIssue, { ...baseIssue, id: 43 }]));

      const findings = await adapter.fetchFindings({ apiKey: 'id:secret' });
      expect(findings).toHaveLength(2);
    });

    it('returns empty array when no issues', async () => {
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce(makeIssuesResponse([]));

      const findings = await adapter.fetchFindings({ apiKey: 'id:secret' });
      expect(findings).toEqual([]);
    });

    it('labels a container issue by container_repo_name when code_repo_name is null', async () => {
      const containerIssue = {
        ...baseIssue,
        id: 645,
        code_repo_name: null,
        container_repo_name: 'public/cloudnative-pg/postgresql',
        attack_surface: 'docker_container',
        affected_file: '/var/lib/dpkg/status',
      };
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce(makeIssuesResponse([containerIssue]));

      const findings = await adapter.fetchFindings({ apiKey: 'id:secret' });
      expect(findings).toHaveLength(1);
      expect(findings[0].repo).toBe('public/cloudnative-pg/postgresql');
    });

    it('labels a code issue by code_repo_name (container_repo_name ignored)', async () => {
      const codeIssue = {
        ...baseIssue,
        id: 646,
        code_repo_name: 'org/repo',
        container_repo_name: 'public/cloudnative-pg/postgresql',
        attack_surface: null,
      };
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce(makeIssuesResponse([codeIssue]));

      const findings = await adapter.fetchFindings({ apiKey: 'id:secret' });
      expect(findings).toHaveLength(1);
      expect(findings[0].repo).toBe('org/repo');
    });

    it('splits apiKey on first ":" only (secret may contain colons)', async () => {
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce(makeIssuesResponse([]));

      await adapter.fetchFindings({ apiKey: 'myid:sec:ret' });

      const [, authOptions] = mockFetch.mock.calls[0];
      const expectedCredentials = Buffer.from('myid:sec:ret').toString('base64');
      expect(authOptions.headers.Authorization).toBe(`Basic ${expectedCredentials}`);
    });
  });

  // -------------------------------------------------------------------------
  // buildTitle (tested via fetchFindings -> normalize)
  // -------------------------------------------------------------------------

  describe('buildTitle (via normalize)', () => {
    async function getTitleForIssue(partial: Partial<typeof baseIssue>) {
      const issue = { ...baseIssue, ...partial };
      mockFetch
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce(makeIssuesResponse([issue]));
      const [finding] = await adapter.fetchFindings({ apiKey: 'id:secret' });
      return finding.title;
    }

    it('CVE + package → "CVE-xxx in package"', async () => {
      const title = await getTitleForIssue({
        cve_id: 'CVE-2021-23337',
        affected_package: 'lodash',
        rule: null,
        affected_file: null,
      });
      expect(title).toBe('CVE-2021-23337 in lodash');
    });

    it('rule + file → "rule in filename"', async () => {
      const title = await getTitleForIssue({
        cve_id: null,
        rule: 'no-eval',
        affected_file: '/src/utils/helper.ts',
        affected_package: null,
        installed_version: null,
      });
      expect(title).toBe('no-eval in helper.ts');
    });

    it('rule only → "rule"', async () => {
      const title = await getTitleForIssue({
        cve_id: null,
        rule: 'no-eval',
        affected_file: null,
        affected_package: null,
        installed_version: null,
      });
      expect(title).toBe('no-eval');
    });

    it('package + installed_version → "Vulnerable package@version"', async () => {
      const title = await getTitleForIssue({
        cve_id: null,
        rule: null,
        affected_file: null,
        affected_package: 'express',
        installed_version: '4.0.0',
      });
      expect(title).toBe('Vulnerable express@4.0.0');
    });

    it('package only → "Vulnerability in package"', async () => {
      const title = await getTitleForIssue({
        cve_id: null,
        rule: null,
        affected_file: null,
        affected_package: 'express',
        installed_version: null,
      });
      expect(title).toBe('Vulnerability in express');
    });

    it('CVE only (no package) → "CVE-xxx"', async () => {
      const title = await getTitleForIssue({
        cve_id: 'CVE-2020-1234',
        affected_package: null,
        rule: null,
        affected_file: null,
        installed_version: null,
      });
      expect(title).toBe('CVE-2020-1234');
    });

    it('fallback → "type finding #id"', async () => {
      const title = await getTitleForIssue({
        id: 99,
        type: 'secret',
        cve_id: null,
        rule: null,
        affected_file: null,
        affected_package: null,
        installed_version: null,
      });
      expect(title).toBe('secret finding #99');
    });
  });

  // -------------------------------------------------------------------------
  // normalizeSeverity (tested via normalizeWebhookPayload)
  // -------------------------------------------------------------------------

  describe('normalizeSeverity', () => {
    const severities = ['critical', 'high', 'medium', 'low'] as const;

    for (const sev of severities) {
      it(`maps "${sev}" → "${sev}"`, () => {
        const payload = {
          event_type: 'issue.created',
          payload: {
            issue_id: 1,
            type: 'sca',
            severity_score: 10,
            severity: sev,
            status: 'open',
          },
        };
        const [finding] = adapter.normalizeWebhookPayload(payload);
        expect(finding.severity).toBe(sev);
      });
    }

    it('maps unknown severity string → "low"', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 2,
          type: 'sca',
          severity_score: 10,
          severity: 'unknown-severity',
          status: 'open',
        },
      };
      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.severity).toBe('low');
    });

    it('maps empty string severity → "low"', () => {
      const payload = {
        event_type: 'issue.created',
        payload: {
          issue_id: 3,
          type: 'sca',
          severity_score: 10,
          severity: '',
          status: 'open',
        },
      };
      const [finding] = adapter.normalizeWebhookPayload(payload);
      expect(finding.severity).toBe('low');
    });
  });
});
