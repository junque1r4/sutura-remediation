import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// The webhooks module does `const aikidoAdapter = new AikidoAdapter()` at module
// init time. We need AikidoAdapter to return a stable mock instance.
// Use a module-level object that we can spy on — defined inside the factory
// via vi.hoisted so variables are available before the mock hoisting.
const { mockNormalizeWebhookPayload } = vi.hoisted(() => ({
  mockNormalizeWebhookPayload: vi.fn(),
}));

vi.mock('../../adapters/scanners/aikido/aikido-adapter', () => ({
  AikidoAdapter: vi.fn().mockImplementation(function () {
    return {
      normalizeWebhookPayload: mockNormalizeWebhookPayload,
    };
  }),
}));

vi.mock('../../config', () => ({
  getConfig: vi.fn().mockReturnValue({
    AIKIDO_WEBHOOK_SECRET: '',
    SNYK_WEBHOOK_SECRET: '',
    GITHUB_WEBHOOK_SECRET: '',
  }),
}));

vi.mock('../../db/findings', () => ({
  upsertFindings: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../db/audit-log', () => ({
  logAction: vi.fn().mockResolvedValue(undefined),
}));

// Single-tenant: the org identity comes from the one organization row, not a
// client header. Mock it to a known UUID so we can assert it is always used.
const SINGLETON_ORG_ID = '11111111-1111-1111-1111-111111111111';
vi.mock('../../db/organizations', () => ({
  getSingletonOrgId: vi.fn(),
  setGithubIntegration: vi.fn(),
}));

import { webhooksRouter } from '../webhooks';
import { getConfig } from '../../config';
import { upsertFindings } from '../../db/findings';
import { logAction } from '../../db/audit-log';
import { getSingletonOrgId, setGithubIntegration } from '../../db/organizations';

function makeReq(overrides: any = {}): any {
  // The handler verifies HMAC over and parses the payload from the raw request
  // bytes (req.rawBody), populated in production by the express.json verify
  // callback in index.ts. Mirror that here so tests drive the real contract.
  const body = overrides.body ?? {};
  return {
    query: {},
    params: {},
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: {},
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeNext(): any {
  return vi.fn();
}

function getHandler(router: any, method: string, path: string): Function {
  const layer = router.stack.find((l: any) => {
    if (!l.route) return false;
    return l.route.path === path && l.route.methods[method];
  });
  if (!layer) throw new Error(`No ${method} ${path} handler found`);
  return layer.route.stack[0].handle;
}

function makeHmacSignature(body: unknown, secret: string): string {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

const aikidoPayload = {
  event_type: 'issue.created',
  payload: {
    issue_id: 123,
    type: 'sast',
    severity_score: 85,
    severity: 'high',
    status: 'open',
    title: 'SQL Injection',
    code_repo_name: 'org/repo',
    affected_file: '/src/app.ts',
    cwe_classes: ['CWE-89'],
  },
};

const normalizedAikidoFinding = {
  externalId: '123',
  scanner: 'aikido',
  title: 'SQL Injection',
  description: 'SQL Injection',
  severity: 'high',
  repo: 'org/repo',
  rawPayload: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to no secrets by default
  vi.mocked(getConfig).mockReturnValue({
    AIKIDO_WEBHOOK_SECRET: '',
    SNYK_WEBHOOK_SECRET: '',
    GITHUB_WEBHOOK_SECRET: '',
  } as any);
  vi.mocked(upsertFindings).mockResolvedValue([]);
  vi.mocked(logAction).mockResolvedValue(undefined as any);
  vi.mocked(getSingletonOrgId).mockResolvedValue(SINGLETON_ORG_ID);
  vi.mocked(setGithubIntegration).mockResolvedValue({} as any);
  // Default: aikido adapter returns one finding
  mockNormalizeWebhookPayload.mockReturnValue([normalizedAikidoFinding]);
});

describe('POST /aikido', () => {
  it('normalizes payload and upserts findings under the singleton org', async () => {
    const handler = getHandler(webhooksRouter, 'post', '/aikido');
    const req = makeReq({ body: aikidoPayload, headers: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(mockNormalizeWebhookPayload).toHaveBeenCalledWith(aikidoPayload);
    expect(upsertFindings).toHaveBeenCalledWith(SINGLETON_ORG_ID, [normalizedAikidoFinding]);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: SINGLETON_ORG_ID,
        actor: 'webhook:aikido',
        action: 'webhook.aikido.received',
      }),
    );
    expect(res.json).toHaveBeenCalledWith({ received: true, count: 1 });
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores a client-supplied x-org-id header and uses the singleton org', async () => {
    const handler = getHandler(webhooksRouter, 'post', '/aikido');
    // Attacker tries to redirect findings to a different org via the header.
    const req = makeReq({ body: aikidoPayload, headers: { 'x-org-id': 'attacker' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(upsertFindings).toHaveBeenCalledWith(SINGLETON_ORG_ID, expect.any(Array));
    expect(upsertFindings).not.toHaveBeenCalledWith('attacker', expect.anything());
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ org_id: SINGLETON_ORG_ID }));
  });

  it('returns 401 for invalid HMAC signature', async () => {
    vi.mocked(getConfig).mockReturnValue({
      AIKIDO_WEBHOOK_SECRET: 'my-secret',
      SNYK_WEBHOOK_SECRET: '',
    } as any);

    const handler = getHandler(webhooksRouter, 'post', '/aikido');
    const req = makeReq({
      body: aikidoPayload,
      headers: { 'x-aikido-signature': 'invalid-sig' },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(upsertFindings).not.toHaveBeenCalled();
  });

  it('accepts valid HMAC signature', async () => {
    const secret = 'my-secret';
    vi.mocked(getConfig).mockReturnValue({
      AIKIDO_WEBHOOK_SECRET: secret,
      SNYK_WEBHOOK_SECRET: '',
    } as any);

    const handler = getHandler(webhooksRouter, 'post', '/aikido');
    const validSig = makeHmacSignature(aikidoPayload, secret);
    const req = makeReq({
      body: aikidoPayload,
      headers: { 'x-aikido-signature': validSig },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(upsertFindings).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true, count: 1 });
  });

  it('skips signature check when no secret configured', async () => {
    vi.mocked(getConfig).mockReturnValue({
      AIKIDO_WEBHOOK_SECRET: '',
      SNYK_WEBHOOK_SECRET: '',
    } as any);

    const handler = getHandler(webhooksRouter, 'post', '/aikido');
    const req = makeReq({
      body: aikidoPayload,
      headers: { 'x-aikido-signature': 'any-value' },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    // Should not return 401 when no secret configured
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(upsertFindings).toHaveBeenCalled();
  });

  it('returns count: 0 when normalized findings is empty', async () => {
    mockNormalizeWebhookPayload.mockReturnValue([]);

    const handler = getHandler(webhooksRouter, 'post', '/aikido');
    const req = makeReq({ body: { event_type: 'unknown', payload: {} }, headers: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ received: true, count: 0 });
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(upsertFindings).mockRejectedValue(err);

    const handler = getHandler(webhooksRouter, 'post', '/aikido');
    const req = makeReq({ body: aikidoPayload, headers: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('POST /snyk', () => {
  const snykPayload = {
    newIssues: [
      {
        id: 'snyk-vuln-1',
        issueData: {
          title: 'Prototype Pollution',
          description: 'A prototype pollution vulnerability',
          severity: 'high',
          cvssScore: 7.5,
          identifiers: { CWE: ['CWE-1321'], CVE: ['CVE-2021-1234'] },
        },
        pkgName: 'lodash',
        pkgVersions: ['4.17.20'],
      },
    ],
    project: { name: 'org/my-app' },
  };

  it('normalizes snyk payload and upserts findings under the singleton org', async () => {
    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    const req = makeReq({ body: snykPayload, headers: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(upsertFindings).toHaveBeenCalledWith(
      SINGLETON_ORG_ID,
      expect.arrayContaining([
        expect.objectContaining({
          externalId: 'snyk-vuln-1',
          scanner: 'snyk',
          title: 'Prototype Pollution',
          severity: 'high',
          cvssScore: 7.5,
          cweId: 'CWE-1321',
          cveId: 'CVE-2021-1234',
          repo: 'org/my-app',
          packageName: 'lodash',
          currentVersion: '4.17.20',
        }),
      ]),
    );
    expect(res.json).toHaveBeenCalledWith({ received: true, count: 1 });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for invalid snyk HMAC signature', async () => {
    vi.mocked(getConfig).mockReturnValue({
      AIKIDO_WEBHOOK_SECRET: '',
      SNYK_WEBHOOK_SECRET: 'snyk-secret',
    } as any);

    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    const req = makeReq({
      body: snykPayload,
      headers: { 'x-snyk-webhook-hmac-sha256': 'invalid-sig' },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(upsertFindings).not.toHaveBeenCalled();
  });

  it('accepts valid snyk HMAC signature', async () => {
    const secret = 'snyk-secret';
    vi.mocked(getConfig).mockReturnValue({
      AIKIDO_WEBHOOK_SECRET: '',
      SNYK_WEBHOOK_SECRET: secret,
    } as any);

    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    const validSig = makeHmacSignature(snykPayload, secret);
    const req = makeReq({
      body: snykPayload,
      headers: { 'x-snyk-webhook-hmac-sha256': validSig },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(upsertFindings).toHaveBeenCalled();
  });

  it('ignores a client-supplied x-org-id header and uses the singleton org', async () => {
    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    // Attacker tries to redirect findings to a different org via the header.
    const req = makeReq({ body: snykPayload, headers: { 'x-org-id': 'attacker' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(upsertFindings).toHaveBeenCalledWith(SINGLETON_ORG_ID, expect.any(Array));
    expect(upsertFindings).not.toHaveBeenCalledWith('attacker', expect.anything());
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ org_id: SINGLETON_ORG_ID }));
  });

  it('handles empty newIssues array', async () => {
    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    const req = makeReq({ body: { newIssues: [], project: { name: 'org/app' } }, headers: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ received: true, count: 0 });
  });

  it('handles missing newIssues field', async () => {
    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    const req = makeReq({ body: { project: { name: 'org/app' } }, headers: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ received: true, count: 0 });
  });

  it('normalizes unknown severity to "low"', async () => {
    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    const req = makeReq({
      body: {
        newIssues: [
          {
            id: 'snyk-2',
            issueData: { title: 'Test', severity: 'UNKNOWN_SEVERITY' },
          },
        ],
        project: { name: 'org/app' },
      },
      headers: {},
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(upsertFindings).toHaveBeenCalledWith(
      SINGLETON_ORG_ID,
      expect.arrayContaining([expect.objectContaining({ severity: 'low' })]),
    );
  });

  it('logs webhook.snyk.received audit action', async () => {
    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    const req = makeReq({ body: snykPayload, headers: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: SINGLETON_ORG_ID,
        actor: 'webhook:snyk',
        action: 'webhook.snyk.received',
        resource_type: 'finding',
        metadata_json: { count: 1 },
      }),
    );
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(upsertFindings).mockRejectedValue(err);

    const handler = getHandler(webhooksRouter, 'post', '/snyk');
    const req = makeReq({ body: snykPayload, headers: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('POST /github', () => {
  const GITHUB_SECRET = 'gh-webhook-secret';

  // GitHub signs the SHA-256 HMAC and sends it as "sha256=<hex>".
  function makeGithubSignature(body: unknown, secret: string): string {
    const hex = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
    return `sha256=${hex}`;
  }

  const installationCreatedPayload = {
    action: 'created',
    installation: {
      id: 124680876,
      target_type: 'Organization',
      account: { login: 'example-org', avatar_url: 'https://avatars.example/example-org.png' },
    },
  };

  function withSecret() {
    vi.mocked(getConfig).mockReturnValue({
      AIKIDO_WEBHOOK_SECRET: '',
      SNYK_WEBHOOK_SECRET: '',
      GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
    } as any);
  }

  it('upserts the org github record on installation.created with a valid signature', async () => {
    withSecret();
    const handler = getHandler(webhooksRouter, 'post', '/github');
    const req = makeReq({
      body: installationCreatedPayload,
      headers: {
        'x-github-event': 'installation',
        'x-hub-signature-256': makeGithubSignature(installationCreatedPayload, GITHUB_SECRET),
      },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(setGithubIntegration).toHaveBeenCalledWith(
      SINGLETON_ORG_ID,
      expect.objectContaining({
        installationId: 124680876,
        account: 'example-org',
        avatarUrl: 'https://avatars.example/example-org.png',
        targetType: 'Organization',
        connectedAt: expect.any(String),
      }),
    );
    expect(res.json).toHaveBeenCalledWith({ received: true, action: 'created' });
    expect(next).not.toHaveBeenCalled();
  });

  it('clears the org github record on installation.deleted', async () => {
    withSecret();
    const payload = { action: 'deleted', installation: { id: 124680876 } };
    const handler = getHandler(webhooksRouter, 'post', '/github');
    const req = makeReq({
      body: payload,
      headers: {
        'x-github-event': 'installation',
        'x-hub-signature-256': makeGithubSignature(payload, GITHUB_SECRET),
      },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(setGithubIntegration).toHaveBeenCalledWith(SINGLETON_ORG_ID, null);
    expect(res.json).toHaveBeenCalledWith({ received: true, action: 'deleted' });
  });

  it('rejects an invalid signature with 401', async () => {
    withSecret();
    const handler = getHandler(webhooksRouter, 'post', '/github');
    const req = makeReq({
      body: installationCreatedPayload,
      headers: {
        'x-github-event': 'installation',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(setGithubIntegration).not.toHaveBeenCalled();
  });

  it('returns 401 when the signature header is missing', async () => {
    withSecret();
    const handler = getHandler(webhooksRouter, 'post', '/github');
    const req = makeReq({
      body: installationCreatedPayload,
      headers: { 'x-github-event': 'installation' },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(setGithubIntegration).not.toHaveBeenCalled();
  });

  it('no-ops with 204 when GITHUB_WEBHOOK_SECRET is unset', async () => {
    // Default mock leaves GITHUB_WEBHOOK_SECRET empty.
    const handler = getHandler(webhooksRouter, 'post', '/github');
    const req = makeReq({
      body: installationCreatedPayload,
      headers: {
        'x-github-event': 'installation',
        'x-hub-signature-256': 'sha256=anything',
      },
    });
    const res = makeRes();
    res.end = vi.fn().mockReturnValue(res);
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(setGithubIntegration).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('acknowledges installation_repositories without mutating the record', async () => {
    withSecret();
    const payload = { action: 'added', repositories_added: [{ id: 1 }] };
    const handler = getHandler(webhooksRouter, 'post', '/github');
    const req = makeReq({
      body: payload,
      headers: {
        'x-github-event': 'installation_repositories',
        'x-hub-signature-256': makeGithubSignature(payload, GITHUB_SECRET),
      },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(setGithubIntegration).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ received: true, event: 'installation_repositories' }),
    );
  });
});
