import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { listAuditLog } from '../db/audit-log';
import { dbAuditLogToApiResponse } from '../db/types';

export const auditLogRouter = Router();

// GET / -- paginated with query params: action, resourceType, search, page, pageSize
auditLogRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { action, resourceType, search, page, pageSize } = req.query as Record<string, string>;

    const result = await listAuditLog(authReq.orgId, {
      action,
      resourceType,
      search,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });

    res.json({
      data: result.data.map(dbAuditLogToApiResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (err) {
    next(err);
  }
});
