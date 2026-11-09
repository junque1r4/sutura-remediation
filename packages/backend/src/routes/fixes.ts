import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { listFixAttemptsByOrg, getFixAttempt } from '../db/fix-attempts';
import { dbFixAttemptToApiResponse } from '../db/types';
import { enqueueFixJob } from '../queue/enqueue';

export const fixesRouter = Router();

// GET / -- list for org (query: findingId, page, pageSize)
fixesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { findingId, page, pageSize } = req.query as Record<string, string>;

    const result = await listFixAttemptsByOrg(authReq.orgId, {
      findingId,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });

    res.json({
      data: result.data.map(dbFixAttemptToApiResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id -- single fix attempt (org-scoped)
fixesRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const fixAttempt = await getFixAttempt(String(req.params.id));
    if (!fixAttempt || fixAttempt.org_id !== authReq.orgId) {
      res.status(404).json({ error: 'Fix attempt not found' });
      return;
    }
    res.json(dbFixAttemptToApiResponse(fixAttempt));
  } catch (err) {
    next(err);
  }
});

// POST / -- enqueue fix job (body: { findingId })
fixesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { findingId } = req.body as { findingId: string };

    if (!findingId) {
      res.status(400).json({ error: 'findingId is required' });
      return;
    }

    const jobId = await enqueueFixJob({ findingId, orgId: authReq.orgId });
    res.status(202).json({ jobId, message: 'Fix job enqueued' });
  } catch (err) {
    next(err);
  }
});
