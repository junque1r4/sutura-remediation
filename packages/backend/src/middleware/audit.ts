import type { Request, Response, NextFunction } from 'express';
import { logAction } from '../db/audit-log';
import type { AuthenticatedRequest } from './auth';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  res.on('finish', () => {
    if (res.statusCode >= 400) return;

    const authReq = req as AuthenticatedRequest;
    const orgId = authReq.orgId;
    const actor = authReq.actor;

    if (!orgId || !actor) return;

    const action = `${req.method} ${req.path}`;

    logAction({
      org_id: orgId,
      actor,
      action,
      metadata_json: { method: req.method, path: req.path, status: res.statusCode },
    }).catch((err: unknown) => {
      console.error('[audit] Failed to log action:', err);
    });
  });

  next();
}
