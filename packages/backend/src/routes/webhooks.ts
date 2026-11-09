import { Router, raw } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { getConfig } from '../config';
import { AikidoAdapter } from '../adapters/scanners/aikido/aikido-adapter';
import { upsertFindings } from '../db/findings';
import { logAction } from '../db/audit-log';
import { getSingletonOrgId, setGithubIntegration } from '../db/organizations';
import type { NormalizedFinding, Severity, GitHubIntegration } from '@sutura/common';

export const webhooksRouter = Router();

const aikidoAdapter = new AikidoAdapter();

/**
 * Capture the raw request bytes for webhook routes so the HMAC can be computed
 * over exactly what the scanner signed (re-serializing JSON would not match the
 * sender's byte stream and breaks verification).
 *
 * NOTE: index.ts mounts a global `express.json()` before this router. If that
 * global parser has already consumed the body for `application/json` requests,
 * `req.rawBody` MUST be populated by a `verify` callback on that global parser
 * (see followUps for the exact index.ts change). This router-level raw parser
 * is the fallback that captures the bytes when they have not been consumed yet
 * (e.g. non-JSON content types) and also parses the JSON payload from them.
 */
webhooksRouter.use(raw({ type: '*/*', limit: '10mb' }));

/** Resolve the raw request bytes regardless of which parser captured them. */
function getRawBody(req: Request): Buffer | null {
  const stashed = (req as Request & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(stashed) && stashed.length > 0) return stashed;
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return req.body;
  return null;
}

/** Parse the webhook JSON payload from the captured raw bytes. */
function parseJsonBody(req: Request): unknown {
  const raw = getRawBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return {};
  }
}

// Helper: verify HMAC signature over the raw request bytes.
function verifyHmac(payload: Buffer, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws on length mismatch -- guard to keep it constant-time-ish.
  if (expectedBuf.length !== signatureBuf.length) return false;
  try {
    return crypto.timingSafeEqual(signatureBuf, expectedBuf);
  } catch {
    return false;
  }
}

// POST /aikido
webhooksRouter.post('/aikido', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = getConfig();
    const signature = req.headers['x-aikido-signature'] as string | undefined;

    if (config.AIKIDO_WEBHOOK_SECRET) {
      if (!signature) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }
      const rawBody = getRawBody(req);
      if (!rawBody || !verifyHmac(rawBody, signature, config.AIKIDO_WEBHOOK_SECRET)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    // Single-tenant: the HMAC above authenticates the origin. The org identity
    // is the one immutable organization row, never a client-supplied header.
    const orgId = await getSingletonOrgId();
    const payload = parseJsonBody(req);
    const findings = aikidoAdapter.normalizeWebhookPayload(payload);

    await upsertFindings(orgId, findings);

    await logAction({
      org_id: orgId,
      actor: 'webhook:aikido',
      action: 'webhook.aikido.received',
      resource_type: 'finding',
      metadata_json: { count: findings.length },
    });

    res.json({ received: true, count: findings.length });
  } catch (err) {
    next(err);
  }
});

// POST /snyk
webhooksRouter.post('/snyk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = getConfig();
    const signature = req.headers['x-snyk-webhook-hmac-sha256'] as string | undefined;

    if (config.SNYK_WEBHOOK_SECRET) {
      if (!signature) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }
      const rawBody = getRawBody(req);
      if (!rawBody || !verifyHmac(rawBody, signature, config.SNYK_WEBHOOK_SECRET)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    // Single-tenant: the HMAC above authenticates the origin. The org identity
    // is the one immutable organization row, never a client-supplied header.
    const orgId = await getSingletonOrgId();

    // Minimal inline normalization -- Task 14 will create the full SnykAdapter
    const payload = parseJsonBody(req) as {
      newIssues?: Array<{
        id?: string;
        issueData?: {
          title?: string;
          description?: string;
          severity?: string;
          cvssScore?: number;
          identifiers?: { CWE?: string[]; CVE?: string[] };
        };
        pkgName?: string;
        pkgVersions?: string[];
      }>;
      project?: { name?: string };
    };

    const findings: NormalizedFinding[] = (payload.newIssues ?? []).map((issue) => {
      const data = issue.issueData ?? {};
      const severityRaw = (data.severity ?? 'low').toLowerCase();
      const severity: Severity = (['critical', 'high', 'medium', 'low'] as const).includes(
        severityRaw as Severity,
      )
        ? (severityRaw as Severity)
        : 'low';

      return {
        externalId: issue.id ?? `snyk-${Date.now()}`,
        scanner: 'snyk' as const,
        title: data.title ?? 'Snyk finding',
        description: data.description ?? '',
        severity,
        cvssScore: data.cvssScore,
        cweId: data.identifiers?.CWE?.[0],
        cveId: data.identifiers?.CVE?.[0],
        repo: payload.project?.name ?? 'unknown',
        packageName: issue.pkgName,
        currentVersion: issue.pkgVersions?.[0],
        rawPayload: issue as unknown as Record<string, unknown>,
      };
    });

    await upsertFindings(orgId, findings);

    await logAction({
      org_id: orgId,
      actor: 'webhook:snyk',
      action: 'webhook.snyk.received',
      resource_type: 'finding',
      metadata_json: { count: findings.length },
    });

    res.json({ received: true, count: findings.length });
  } catch (err) {
    next(err);
  }
});

// Whether we have already logged that the GitHub webhook secret is unset, so we
// only warn once instead of on every delivery.
let warnedMissingGithubSecret = false;

interface GithubInstallationPayload {
  action?: string;
  installation?: {
    id?: number;
    target_type?: 'Organization' | 'User';
    account?: { login?: string; avatar_url?: string };
  };
}

// POST /github -- GitHub App `installation` lifecycle webhook. This is the
// durable fix for the recurring "Connect can't capture the installation id"
// bug: GitHub pushes us the installation id on install/uninstall so the org
// record stays in sync without relying on the OAuth-style callback (which never
// fires for an already-installed App).
webhooksRouter.post('/github', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const secret = getConfig().GITHUB_WEBHOOK_SECRET;

    // No secret configured: no-op gracefully (never crash). We cannot trust an
    // unauthenticated payload to mutate the org record, so just ack.
    if (!secret) {
      if (!warnedMissingGithubSecret) {
        console.warn(
          '[webhook:github] GITHUB_WEBHOOK_SECRET is not set; ignoring GitHub webhook deliveries',
        );
        warnedMissingGithubSecret = true;
      }
      res.status(204).end();
      return;
    }

    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!signature) {
      res.status(401).json({ error: 'Missing signature' });
      return;
    }
    const rawBody = getRawBody(req);
    // GitHub sends the signature as "sha256=<hex>"; verifyHmac compares the hex
    // digest, so strip the prefix before comparing.
    const providedHex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
    if (!rawBody || !verifyHmac(rawBody, providedHex, secret)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const event = req.headers['x-github-event'] as string | undefined;

    // installation_repositories (and the ping event) carry no installation
    // lifecycle change we need to persist -- just acknowledge.
    if (event !== 'installation') {
      res.json({ received: true, event: event ?? 'unknown', action: null });
      return;
    }

    const payload = parseJsonBody(req) as GithubInstallationPayload;
    const action = payload.action;
    const orgId = await getSingletonOrgId();

    if (action === 'created' || action === 'new_permissions_accepted') {
      const inst = payload.installation;
      if (!inst || typeof inst.id !== 'number') {
        res.status(400).json({ error: 'Missing installation in payload' });
        return;
      }
      const github: GitHubIntegration = {
        installationId: inst.id,
        account: inst.account?.login ?? 'unknown',
        avatarUrl: inst.account?.avatar_url ?? '',
        targetType: inst.target_type ?? 'Organization',
        connectedAt: new Date().toISOString(),
      };
      await setGithubIntegration(orgId, github);
      await logAction({
        org_id: orgId,
        actor: 'webhook:github',
        action: 'webhook.github.installation.created',
        resource_type: 'organization',
        metadata_json: { installationId: inst.id, account: github.account },
      });
      res.json({ received: true, action });
      return;
    }

    if (action === 'deleted') {
      await setGithubIntegration(orgId, null);
      await logAction({
        org_id: orgId,
        actor: 'webhook:github',
        action: 'webhook.github.installation.deleted',
        resource_type: 'organization',
        metadata_json: { installationId: payload.installation?.id ?? null },
      });
      res.json({ received: true, action });
      return;
    }

    // Other installation actions (suspend/unsuspend, etc.): acknowledge without
    // mutating the record.
    res.json({ received: true, action: action ?? null });
  } catch (err) {
    next(err);
  }
});
