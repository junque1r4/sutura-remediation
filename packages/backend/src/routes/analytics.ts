import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  getOverview,
  getTrend,
  getFixPerformance,
  getRemediationFunnel,
  getScannerBreakdown,
  getCweBreakdown,
  listRepos,
  type RangeKey,
  type AnalyticsFilters,
} from '../db/analytics';

const VALID_RANGES: RangeKey[] = ['7d', '30d', '90d'];

function parseFilters(req: Request): AnalyticsFilters {
  const rangeQ = String(req.query.range ?? '30d');
  const range: RangeKey = (VALID_RANGES as string[]).includes(rangeQ)
    ? (rangeQ as RangeKey)
    : '30d';
  const repoQ = req.query.repo;
  const repo = typeof repoQ === 'string' && repoQ.length > 0 ? repoQ : null;
  return { range, repo };
}

export const analyticsRouter = Router();

analyticsRouter.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    res.json(await getOverview(authReq.orgId, parseFilters(req)));
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/trend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    res.json({ data: await getTrend(authReq.orgId, parseFilters(req)) });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get(
  '/fix-performance',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      res.json({ data: await getFixPerformance(authReq.orgId, parseFilters(req)) });
    } catch (err) {
      next(err);
    }
  },
);

analyticsRouter.get('/repos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    res.json({ data: await listRepos(authReq.orgId) });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/funnel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    res.json({ data: await getRemediationFunnel(authReq.orgId, parseFilters(req)) });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get(
  '/breakdown/scanner',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      res.json({ data: await getScannerBreakdown(authReq.orgId, parseFilters(req)) });
    } catch (err) {
      next(err);
    }
  },
);

analyticsRouter.get(
  '/breakdown/cwe',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      res.json({ data: await getCweBreakdown(authReq.orgId, parseFilters(req)) });
    } catch (err) {
      next(err);
    }
  },
);

// Internal variant -- now JWT-authenticated (mounted behind authMiddleware in
// index.ts). Org identity comes from the verified token claims (req.orgId),
// not a shared secret + client-supplied orgId query param.
export const internalAnalyticsRouter = Router();

internalAnalyticsRouter.get(
  '/analytics/overview',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getOverview((req as AuthenticatedRequest).orgId, parseFilters(req)));
    } catch (err) {
      next(err);
    }
  },
);

internalAnalyticsRouter.get(
  '/analytics/trend',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await getTrend((req as AuthenticatedRequest).orgId, parseFilters(req)) });
    } catch (err) {
      next(err);
    }
  },
);

internalAnalyticsRouter.get(
  '/analytics/fix-performance',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await getFixPerformance((req as AuthenticatedRequest).orgId, parseFilters(req)) });
    } catch (err) {
      next(err);
    }
  },
);

internalAnalyticsRouter.get(
  '/analytics/repos',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await listRepos((req as AuthenticatedRequest).orgId) });
    } catch (err) {
      next(err);
    }
  },
);

internalAnalyticsRouter.get(
  '/analytics/funnel',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await getRemediationFunnel((req as AuthenticatedRequest).orgId, parseFilters(req)) });
    } catch (err) {
      next(err);
    }
  },
);

internalAnalyticsRouter.get(
  '/analytics/breakdown/scanner',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await getScannerBreakdown((req as AuthenticatedRequest).orgId, parseFilters(req)) });
    } catch (err) {
      next(err);
    }
  },
);

internalAnalyticsRouter.get(
  '/analytics/breakdown/cwe',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await getCweBreakdown((req as AuthenticatedRequest).orgId, parseFilters(req)) });
    } catch (err) {
      next(err);
    }
  },
);
