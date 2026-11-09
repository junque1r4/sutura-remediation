import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BackendBreakdown {
  findingId: string;
  findingTitle: string | null;
  findingSeverity: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  byOperation: Array<{
    operation: 'analysis' | 'fix_generation';
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

interface BackendListRow {
  id: string;
  operation: 'analysis' | 'fix_generation';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
}

interface BackendListResponse {
  data: BackendListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const GET = withPermission<{ params: Promise<{ findingId: string }> }>(
  'findings:read',
  async (auth, req, ctx) => {
    const backendUrl =
      process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';
    const token = signBackendToken({
      sub: auth.userId,
      email: auth.email,
      org_id: auth.orgId,
      role: auth.role,
    });

    const { findingId } = await ctx.params;
    // Single-tenant: org identity travels in the signed token, never the query
    // string. Strip any client-supplied orgId so it can never reach the backend.
    const url = new URL(req.url);
    url.searchParams.delete('orgId');
    const search = url.search;
    const headers = { Authorization: `Bearer ${token}` };

    const [breakdownRes, latestRes] = await Promise.all([
      fetch(
        `${backendUrl}/api/token-usage/findings/${encodeURIComponent(findingId)}${search}`,
        { headers, cache: 'no-store' },
      ),
      fetch(
        `${backendUrl}/api/token-usage?findingId=${encodeURIComponent(findingId)}&pageSize=1&page=1`,
        { headers, cache: 'no-store' },
      ),
    ]);

    if (!breakdownRes.ok) {
      const body = await breakdownRes.text();
      return new NextResponse(body, {
        status: breakdownRes.status,
        headers: {
          'Content-Type': breakdownRes.headers.get('Content-Type') ?? 'application/json',
        },
      });
    }

    const breakdown = (await breakdownRes.json()) as BackendBreakdown;

    let lastRun: {
      operation: 'analysis' | 'fix_generation';
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      createdAt: string;
    } | null = null;
    if (latestRes.ok) {
      const list = (await latestRes.json()) as BackendListResponse;
      const row = list.data?.[0];
      if (row) {
        lastRun = {
          operation: row.operation,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: Number(row.costUsd),
          createdAt: row.createdAt,
        };
      }
    }

    return NextResponse.json({ ...breakdown, lastRun });
  },
);
