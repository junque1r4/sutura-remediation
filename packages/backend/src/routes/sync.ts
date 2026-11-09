import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { syncAll, syncProvider, isSyncProvider } from '../sync/scanner-sync';

export const syncRouter = Router();

// POST / -- sync all connected scanners for the caller's org.
syncRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const results = await syncAll(authReq.orgId);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// POST /:provider -- sync a single scanner for the caller's org.
syncRouter.post('/:provider', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const provider = String(req.params.provider);
    if (!isSyncProvider(provider)) {
      res.status(400).json({ error: 'Unknown scanner provider' });
      return;
    }
    const result = await syncProvider(authReq.orgId, provider);
    res.json({ results: [result] });
  } catch (err) {
    next(err);
  }
});
