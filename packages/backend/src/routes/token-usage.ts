import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  createTokenUsage,
  listTokenUsage,
  getTokenUsageStats,
  getFindingCostRanking,
  getFindingCostBreakdown,
} from '../db/token-usage';
import { dbTokenUsageToApiResponse } from '../db/types';
import type { TokenUsageOperation } from '../db/types';

export const tokenUsageRouter = Router();

// GET / -- list (auth'd)
tokenUsageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { operation, findingId, page, pageSize } = req.query as Record<string, string>;
    const result = await listTokenUsage(authReq.orgId, {
      operation: operation as TokenUsageOperation | undefined,
      findingId,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
    res.json({
      data: result.data.map(dbTokenUsageToApiResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// GET /stats -- aggregates for org (auth'd)
tokenUsageRouter.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const stats = await getTokenUsageStats(authReq.orgId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /ranking -- findings ranked by total cost
tokenUsageRouter.get('/ranking', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { limit } = req.query as Record<string, string>;
    const data = await getFindingCostRanking(
      authReq.orgId,
      limit ? parseInt(limit, 10) : undefined,
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /findings/:findingId -- per-finding breakdown
tokenUsageRouter.get(
  '/findings/:findingId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const breakdown = await getFindingCostBreakdown(
        authReq.orgId,
        String(req.params.findingId),
      );
      if (!breakdown) {
        res.json({
          findingId: String(req.params.findingId),
          findingTitle: null,
          findingSeverity: null,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          byOperation: [],
        });
        return;
      }
      res.json(breakdown);
    } catch (err) {
      next(err);
    }
  },
);

// Internal router for server-to-server recording and reads from the
// dashboard's Next.js API routes. Now JWT-authenticated: mounted behind
// authMiddleware in index.ts, so org identity is taken from the verified
// token claims (req.orgId) rather than a shared secret + client-supplied
// orgId query param.
export const internalTokenUsageRouter = Router();

internalTokenUsageRouter.get(
  '/token-usage',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = (req as AuthenticatedRequest).orgId;
      const { operation, findingId, page, pageSize } = req.query as Record<string, string>;
      const result = await listTokenUsage(orgId, {
        operation: operation as TokenUsageOperation | undefined,
        findingId,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      });
      res.json({
        data: result.data.map(dbTokenUsageToApiResponse),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      });
    } catch (err) {
      next(err);
    }
  },
);

internalTokenUsageRouter.get(
  '/token-usage/stats',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await getTokenUsageStats((req as AuthenticatedRequest).orgId);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  },
);

internalTokenUsageRouter.get(
  '/token-usage/ranking',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { limit } = req.query as Record<string, string>;
      const data = await getFindingCostRanking(
        (req as AuthenticatedRequest).orgId,
        limit ? parseInt(limit, 10) : undefined,
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  },
);

internalTokenUsageRouter.get(
  '/token-usage/findings/:findingId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const findingId = String(req.params.findingId);
      const breakdown = await getFindingCostBreakdown(
        (req as AuthenticatedRequest).orgId,
        findingId,
      );
      if (!breakdown) {
        res.json({
          findingId,
          findingTitle: null,
          findingSeverity: null,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          byOperation: [],
        });
        return;
      }
      res.json(breakdown);
    } catch (err) {
      next(err);
    }
  },
);

internalTokenUsageRouter.post(
  '/token-usage',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        operation: TokenUsageOperation;
        model: string;
        inputTokens: number;
        outputTokens: number;
        findingId?: string | null;
        findingTitle?: string | null;
        findingSeverity?: string | null;
        fixAttemptId?: string | null;
        prompt: string;
        response: string;
      };

      if (
        !body.operation ||
        !body.model ||
        typeof body.inputTokens !== 'number' ||
        typeof body.outputTokens !== 'number'
      ) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      const row = await createTokenUsage({
        org_id: (req as AuthenticatedRequest).orgId || null,
        operation: body.operation,
        model: body.model,
        input_tokens: body.inputTokens,
        output_tokens: body.outputTokens,
        finding_id: body.findingId ?? null,
        finding_title: body.findingTitle ?? null,
        finding_severity: body.findingSeverity ?? null,
        fix_attempt_id: body.fixAttemptId ?? null,
        prompt: body.prompt ?? '',
        response: body.response ?? '',
      });

      res.status(201).json(dbTokenUsageToApiResponse(row));
    } catch (err) {
      next(err);
    }
  },
);
