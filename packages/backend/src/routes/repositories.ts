import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { listIndices } from '../db/codebase-indices';
import { enqueueIndexJob } from '../queue/enqueue';

export const repositoriesRouter = Router();

// GET / -- list codebase indices for org
repositoriesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const indices = await listIndices(authReq.orgId);

    res.json(
      indices.map((idx) => ({
        id: idx.id,
        orgId: idx.org_id,
        repo: idx.repo,
        branch: idx.branch,
        lastIndexedAt: idx.last_indexed_at,
        fileCount: idx.file_count,
        chunkCount: idx.chunk_count,
        vectorNamespace: idx.vector_namespace,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /*repo/index -- enqueue index job (body: { branch?, githubToken })
// Note: /*repo captures slashes in owner/repo format (Express 5 / path-to-regexp v8 syntax)
repositoriesRouter.post('/*repo/index', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const repo = String(req.params['repo']);
    const { branch = 'main', githubToken } = req.body as { branch?: string; githubToken: string };

    if (!githubToken) {
      res.status(400).json({ error: 'githubToken is required' });
      return;
    }

    const jobId = await enqueueIndexJob({ repo, branch, orgId: authReq.orgId, githubToken });
    res.status(202).json({ jobId, message: 'Index job enqueued' });
  } catch (err) {
    next(err);
  }
});
