import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  listFindings,
  getFinding,
  getFindingByExternal,
  updateFindingStatus,
} from '../db/findings';
import { getLatestFindingAnalysis } from '../db/analysis';
import { dbFindingToApiResponse, dbAnalysisToApiResponse } from '../db/types';
import type { DbFinding } from '../db/types';
import type { FindingStatus, Severity } from '@sutura/common';

export const findingsRouter = Router();

/**
 * Resolve a route id that is either the backend UUID or the dashboard's
 * synthetic `<scanner>-<externalId>` form (e.g. `aikido-76125716`). Deep links
 * use the synthetic form, and the finding may not be in the client's paginated
 * list, so the API must resolve it directly. Org-scoped via the external
 * lookup; UUID hits are org-checked by the callers.
 */
export async function resolveFinding(idParam: string, orgId: string): Promise<DbFinding | null> {
  const byUuid = await getFinding(idParam);
  if (byUuid) return byUuid;
  const dash = idParam.indexOf('-');
  if (dash <= 0 || dash === idParam.length - 1) return null;
  const scanner = idParam.slice(0, dash);
  const externalId = idParam.slice(dash + 1);
  return getFindingByExternal(orgId, scanner, externalId);
}

// GET / -- list with filters (query params: status, severity, scanner, repo, page, pageSize)
findingsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { status, severity, scanner, repo, page, pageSize, hideDuplicates } =
      req.query as Record<string, string | undefined>;

    const result = await listFindings(authReq.orgId, {
      status: status as FindingStatus | undefined,
      severity: severity as Severity | undefined,
      scanner,
      repo,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      // Cross-scanner duplicates are hidden by default; pass ?hideDuplicates=false
      // to include them. Any other value (or omission) keeps the default.
      hideDuplicates: hideDuplicates === 'false' ? false : undefined,
    });

    res.json({
      data: result.data.map(dbFindingToApiResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id -- single finding (org-scoped). Accepts the backend UUID or the
// dashboard's `<scanner>-<externalId>` deep-link id.
findingsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const finding = await resolveFinding(String(req.params.id), authReq.orgId);
    // Treat cross-org access as not found to avoid leaking existence (IDOR).
    if (!finding || finding.org_id !== authReq.orgId) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }
    res.json(dbFindingToApiResponse(finding));
  } catch (err) {
    next(err);
  }
});

// GET /:id/analysis -- latest persisted AI analysis for a finding (org-scoped).
// Returns null when no analysis has been run yet.
findingsRouter.get('/:id/analysis', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const finding = await resolveFinding(String(req.params.id), authReq.orgId);
    // Treat cross-org access as not found to avoid leaking existence (IDOR).
    if (!finding || finding.org_id !== authReq.orgId) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }
    const analysis = await getLatestFindingAnalysis(finding.id);
    res.json(analysis ? dbAnalysisToApiResponse(analysis) : null);
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/status -- update status { status: FindingStatus } (org-scoped)
findingsRouter.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { status } = req.body as { status: FindingStatus };
    if (!status) {
      res.status(400).json({ error: 'status is required' });
      return;
    }
    // Verify the finding belongs to the caller's org before mutating it (IDOR).
    const existing = await getFinding(String(req.params.id));
    if (!existing || existing.org_id !== authReq.orgId) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }
    const finding = await updateFindingStatus(String(req.params.id), status);
    res.json(dbFindingToApiResponse(finding));
  } catch (err) {
    next(err);
  }
});
