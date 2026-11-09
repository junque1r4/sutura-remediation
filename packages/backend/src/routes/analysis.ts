import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { createFindingAnalysis } from '../db/analysis';
import { getFinding } from '../db/findings';
import { dbAnalysisToApiResponse } from '../db/types';

// Internal router for the dashboard's analyze route to persist the AI analysis
// markdown once the stream completes. JWT-authenticated (mounted behind
// authMiddleware in index.ts), so org identity comes from the verified token
// claims (req.orgId) — never the request body.
export const internalAnalysisRouter = Router();

internalAnalysisRouter.post(
  '/analysis',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = (req as AuthenticatedRequest).orgId;
      const body = req.body as {
        findingId?: string | null;
        analysisMarkdown?: string | null;
        model?: string | null;
        inputTokens?: number;
        outputTokens?: number;
      };

      if (!body.findingId || !body.analysisMarkdown) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      // The analysis is keyed to a finding; confirm it exists and belongs to
      // this org before persisting (IDOR guard, mirrors GET /findings/:id).
      const finding = await getFinding(body.findingId);
      if (!finding || finding.org_id !== orgId) {
        res.status(404).json({ error: 'Finding not found' });
        return;
      }

      const row = await createFindingAnalysis({
        finding_id: body.findingId,
        org_id: orgId,
        analysis_md: body.analysisMarkdown,
        model: body.model ?? null,
        input_tokens: body.inputTokens ?? 0,
        output_tokens: body.outputTokens ?? 0,
      });

      res.status(201).json(dbAnalysisToApiResponse(row));
    } catch (err) {
      next(err);
    }
  },
);
