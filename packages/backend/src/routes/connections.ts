import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  listConnections,
  getConnection,
  upsertConnection,
  deleteConnection,
  dbConnectionToStatus,
  isIntegrationProvider,
} from '../db/connections';
import type { IntegrationProvider } from '../db/connections';
import { encryptSecret, decryptSecret } from '../lib/secret-encryption';

/**
 * Org-scoped integration connection CRUD. The org identity is taken from the
 * verified JWT (req.orgId) set by authMiddleware -- there is no requirePermission
 * gate here; the backend trusts the signed token. The provider SECRET is
 * encrypted on write and NEVER returned by list/get/PUT (status shape only).
 */
export const connectionsRouter = Router();

/** Parse + validate :provider; respond 400 and return null if invalid. */
function readProvider(req: Request, res: Response): IntegrationProvider | null {
  const provider = String(req.params.provider);
  if (!isIntegrationProvider(provider)) {
    res.status(400).json({ error: 'Invalid provider' });
    return null;
  }
  return provider;
}

// GET / -- list all configured connections for the org (no secrets)
connectionsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const rows = await listConnections(authReq.orgId);
    res.json({ connections: rows.map(dbConnectionToStatus) });
  } catch (err) {
    next(err);
  }
});

// GET /:provider -- status for one provider (404 if not connected, no secret)
connectionsRouter.get('/:provider', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = readProvider(req, res);
    if (!provider) return;
    const authReq = req as AuthenticatedRequest;
    const row = await getConnection(authReq.orgId, provider);
    if (!row) {
      res.status(404).json({ error: 'Not connected' });
      return;
    }
    res.json(dbConnectionToStatus(row));
  } catch (err) {
    next(err);
  }
});

// PUT /:provider -- create/replace (upsert). Plaintext secret arrives ONCE and
// is encrypted immediately; only ciphertext is stored. Response is status shape.
connectionsRouter.put('/:provider', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = readProvider(req, res);
    if (!provider) return;
    const authReq = req as AuthenticatedRequest;
    const body = (req.body ?? {}) as {
      secret?: unknown;
      maskedIdentifier?: unknown;
      metadata?: unknown;
    };

    // Reject empty secret BEFORE encrypting: encryptSecret('') returns '' and
    // encrypted_secret is NOT NULL.
    const secret = typeof body.secret === 'string' ? body.secret : '';
    if (!secret) {
      res.status(400).json({ error: 'Missing or empty secret' });
      return;
    }

    const row = await upsertConnection({
      org_id: authReq.orgId,
      provider,
      encrypted_secret: encryptSecret(secret),
      masked_identifier:
        typeof body.maskedIdentifier === 'string' ? body.maskedIdentifier : null,
      metadata_json:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : {},
      connected_by: authReq.actor,
    });

    res.json(dbConnectionToStatus(row));
  } catch (err) {
    next(err);
  }
});

// DELETE /:provider -- remove (idempotent, 204 even if nothing existed)
connectionsRouter.delete('/:provider', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = readProvider(req, res);
    if (!provider) return;
    const authReq = req as AuthenticatedRequest;
    await deleteConnection(authReq.orgId, provider);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * INTERNAL decrypt endpoint. Mounted under /internal behind authMiddleware (NOT
 * /api), so it is reachable only by the dashboard server-side with a freshly
 * signed backend token -- never by the browser. Returns the DECRYPTED secret +
 * metadata for consumer routes that still run the vendor call dashboard-side.
 */
export const internalConnectionsRouter = Router();

internalConnectionsRouter.get(
  '/connections/:provider/secret',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = readProvider(req, res);
      if (!provider) return;
      const authReq = req as AuthenticatedRequest;
      const row = await getConnection(authReq.orgId, provider);
      if (!row) {
        res.status(404).json({ error: 'Not connected' });
        return;
      }
      res.json({
        provider,
        secret: decryptSecret(row.encrypted_secret),
        metadata: row.metadata_json ?? {},
      });
    } catch (err) {
      next(err);
    }
  },
);
