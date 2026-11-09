import { NextResponse } from 'next/server';

import type { Finding } from '@/types';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';
import {
  getValidAikidoToken,
  fetchAikidoIssues,
  mapAikidoIssueToFinding,
} from '@/lib/aikido';
import { getConnectionSecret } from '@/lib/connections-client.server';

export async function GET() {
  try {
    await requirePermission('findings:read');

    // Dev mode: return mock findings
    if (process.env.AIKIDO_DEV_MODE === 'true') {
      const mockFindings: Finding[] = [
        {
          id: 'aikido-mock-001',
          orgId: '',
          scannerSource: 'aikido',
          externalId: '10001',
          title: 'SQL Injection in user input handler',
          description: 'Unsanitized user input passed to SQL query allows database manipulation.',
          severity: 'critical',
          cvssScore: 9.1,
          epssScore: null,
          cweId: 'CWE-89',
          cveId: null,
          filePath: 'src/api/users.ts',
          lineRange: [42, 48],
          repo: 'acme/backend',
          status: 'open',
          ingestedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          resolvedAt: null,
          packageName: null,
          currentVersion: null,
          fixedVersion: null,
          rawPayload: null,
        },
        {
          id: 'aikido-mock-002',
          orgId: '',
          scannerSource: 'aikido',
          externalId: '10002',
          title: 'Hardcoded AWS access key detected',
          description: 'AWS access key found hardcoded in configuration file.',
          severity: 'high',
          cvssScore: 8.0,
          epssScore: null,
          cweId: 'CWE-798',
          cveId: null,
          filePath: 'config/deploy.yml',
          lineRange: [15, 15],
          repo: 'acme/infra',
          status: 'open',
          ingestedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          resolvedAt: null,
          packageName: null,
          currentVersion: null,
          fixedVersion: null,
          rawPayload: null,
        },
        {
          id: 'aikido-mock-003',
          orgId: '',
          scannerSource: 'aikido',
          externalId: '10003',
          title: 'Outdated lodash with prototype pollution vulnerability',
          description: 'lodash prior to 4.17.21 is vulnerable to prototype pollution.',
          severity: 'medium',
          cvssScore: 5.6,
          epssScore: null,
          cweId: 'CWE-1321',
          cveId: null,
          filePath: null,
          lineRange: null,
          repo: 'acme/frontend',
          status: 'open',
          ingestedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
          resolvedAt: null,
          packageName: 'lodash',
          currentVersion: '4.17.20',
          fixedVersion: '4.17.21',
          rawPayload: null,
        },
      ];
      return NextResponse.json(mockFindings);
    }

    const secret = await getConnectionSecret('aikido');
    if (!secret) {
      return NextResponse.json({ error: 'Aikido is not connected' }, { status: 401 });
    }
    const [clientId, clientSecret] = secret.secret.split(':');
    const accessToken = await getValidAikidoToken(clientId, clientSecret);
    const issues = await fetchAikidoIssues(accessToken);
    const findings: Finding[] = issues.map(mapAikidoIssueToFinding);

    return NextResponse.json(findings);
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to fetch Aikido issues';
    console.error('[Aikido Issues]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
