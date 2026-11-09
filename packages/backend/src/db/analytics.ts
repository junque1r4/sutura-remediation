import { getPool } from './client';

export type RangeKey = '7d' | '30d' | '90d';

export interface AnalyticsFilters {
  range: RangeKey;
  repo?: string | null;
}

export interface SeverityCount {
  severity: 'critical' | 'high' | 'medium' | 'low';
  count: number;
}

export interface OverviewResponse {
  range: RangeKey;
  repo: string | null;
  periodStart: string;
  periodEnd: string;
  openFindings: {
    total: number;
    delta: number;
    bySeverity: SeverityCount[];
  };
  mttrHours: {
    value: number | null;
    delta: number | null;
    sampleSize: number;
  };
  autoFixSuccessRate: {
    value: number | null;
    delta: number | null;
    succeeded: number;
    total: number;
  };
  costUsd: {
    value: number;
    delta: number;
  };
}

export interface TrendBucket {
  date: string;
  ingested: number;
  resolved: number;
}

export interface FixPerformanceBucket {
  date: string;
  resolved: number;
  stillVulnerable: number;
  inconclusive: number;
}

export type FunnelStageKey =
  | 'detected'
  | 'fix_attempted'
  | 'pr_opened'
  | 'pr_merged'
  | 'validated_resolved';

export interface FunnelStage {
  key: FunnelStageKey;
  label: string;
  count: number;
}

export interface BreakdownRow {
  label: string;
  count: number;
}

const RANGE_DAYS: Record<RangeKey, number> = { '7d': 7, '30d': 30, '90d': 90 };

function getPeriodBounds(range: RangeKey): { start: Date; end: Date; prevStart: Date } {
  const days = RANGE_DAYS[range];
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const prevStart = new Date(start.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end, prevStart };
}

function buildOrgClause(orgId: string, alias?: string): { clause: string; param: string[] } {
  const col = alias ? `${alias}.org_id` : 'org_id';
  if (orgId) return { clause: `${col} = $1`, param: [orgId] };
  return { clause: `${col} IS NULL`, param: [] };
}

async function countOpenBySeverity(
  orgId: string,
  repo: string | null,
): Promise<SeverityCount[]> {
  const pool = getPool();
  const { clause: orgClause, param: orgParam } = buildOrgClause(orgId);
  const params: unknown[] = [...orgParam];
  let repoClause = '';
  if (repo) {
    repoClause = ` AND repo = $${params.length + 1}`;
    params.push(repo);
  }
  const { rows } = await pool.query(
    `SELECT severity, COUNT(*)::int AS count
       FROM findings
      WHERE ${orgClause}
        AND status IN ('open','fixing','failed')${repoClause}
      GROUP BY severity`,
    params,
  );
  const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of rows) bySev[r.severity] = r.count;
  return (['critical', 'high', 'medium', 'low'] as const).map((s) => ({
    severity: s,
    count: bySev[s] ?? 0,
  }));
}

async function mttrHours(
  orgId: string,
  repo: string | null,
  start: Date,
  end: Date,
): Promise<{ avg: number | null; sample: number }> {
  const pool = getPool();
  const { clause: orgClause, param: orgParam } = buildOrgClause(orgId);
  const params: unknown[] = [...orgParam, start, end];
  let repoClause = '';
  if (repo) {
    repoClause = ` AND repo = $${params.length + 1}`;
    params.push(repo);
  }
  const startIdx = orgParam.length + 1;
  const endIdx = orgParam.length + 2;
  const { rows } = await pool.query(
    `SELECT
        AVG(EXTRACT(EPOCH FROM (resolved_at - ingested_at)) / 3600.0) AS avg_hours,
        COUNT(*)::int AS sample
       FROM findings
      WHERE ${orgClause}
        AND status = 'fixed'
        AND resolved_at IS NOT NULL
        AND resolved_at >= $${startIdx} AND resolved_at < $${endIdx}${repoClause}`,
    params,
  );
  const avg = rows[0]?.avg_hours;
  return {
    avg: avg === null || avg === undefined ? null : Number(avg),
    sample: rows[0]?.sample ?? 0,
  };
}

async function autoFixSuccess(
  orgId: string,
  repo: string | null,
  start: Date,
  end: Date,
): Promise<{ succeeded: number; total: number }> {
  const pool = getPool();
  const { clause: orgClause, param: orgParam } = buildOrgClause(orgId, 'fa');
  const params: unknown[] = [...orgParam, start, end];
  let repoClause = '';
  if (repo) {
    repoClause = ` AND f.repo = $${params.length + 1}`;
    params.push(repo);
  }
  const startIdx = orgParam.length + 1;
  const endIdx = orgParam.length + 2;
  const { rows } = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE fa.status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE fa.status IN ('succeeded','failed','exhausted'))::int AS total
       FROM fix_attempts fa
       LEFT JOIN findings f ON f.id = fa.finding_id
      WHERE ${orgClause}
        AND fa.completed_at >= $${startIdx} AND fa.completed_at < $${endIdx}${repoClause}`,
    params,
  );
  return {
    succeeded: rows[0]?.succeeded ?? 0,
    total: rows[0]?.total ?? 0,
  };
}

async function costSum(
  orgId: string,
  repo: string | null,
  start: Date,
  end: Date,
): Promise<number> {
  const pool = getPool();
  const { clause: orgClause, param: orgParam } = buildOrgClause(orgId, 'tu');
  const params: unknown[] = [...orgParam, start, end];
  let repoJoin = '';
  let repoClause = '';
  if (repo) {
    repoJoin = ' LEFT JOIN findings f ON f.id = tu.finding_id';
    repoClause = ` AND f.repo = $${params.length + 1}`;
    params.push(repo);
  }
  const startIdx = orgParam.length + 1;
  const endIdx = orgParam.length + 2;
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(tu.cost_usd), 0)::numeric AS cost
       FROM token_usage tu${repoJoin}
      WHERE ${orgClause}
        AND tu.created_at >= $${startIdx} AND tu.created_at < $${endIdx}${repoClause}`,
    params,
  );
  return Number(rows[0]?.cost ?? 0);
}

export async function getOverview(
  orgId: string,
  filters: AnalyticsFilters,
): Promise<OverviewResponse> {
  const { start, end, prevStart } = getPeriodBounds(filters.range);
  const repo = filters.repo || null;

  const [
    openBySeverity,
    mttrCurrent,
    mttrPrev,
    successCurrent,
    successPrev,
    costCurrent,
    costPrev,
  ] = await Promise.all([
    countOpenBySeverity(orgId, repo),
    mttrHours(orgId, repo, start, end),
    mttrHours(orgId, repo, prevStart, start),
    autoFixSuccess(orgId, repo, start, end),
    autoFixSuccess(orgId, repo, prevStart, start),
    costSum(orgId, repo, start, end),
    costSum(orgId, repo, prevStart, start),
  ]);

  const totalOpen = openBySeverity.reduce((a, b) => a + b.count, 0);
  const successRate =
    successCurrent.total > 0 ? successCurrent.succeeded / successCurrent.total : null;
  const prevSuccessRate =
    successPrev.total > 0 ? successPrev.succeeded / successPrev.total : null;

  return {
    range: filters.range,
    repo,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    openFindings: {
      total: totalOpen,
      delta: 0,
      bySeverity: openBySeverity,
    },
    mttrHours: {
      value: mttrCurrent.avg,
      delta:
        mttrCurrent.avg !== null && mttrPrev.avg !== null ? mttrCurrent.avg - mttrPrev.avg : null,
      sampleSize: mttrCurrent.sample,
    },
    autoFixSuccessRate: {
      value: successRate,
      delta:
        successRate !== null && prevSuccessRate !== null ? successRate - prevSuccessRate : null,
      succeeded: successCurrent.succeeded,
      total: successCurrent.total,
    },
    costUsd: {
      value: costCurrent,
      delta: costCurrent - costPrev,
    },
  };
}

export async function getTrend(
  orgId: string,
  filters: AnalyticsFilters,
): Promise<TrendBucket[]> {
  const pool = getPool();
  const { start, end } = getPeriodBounds(filters.range);
  const repo = filters.repo || null;

  const { clause: orgClause, param: orgParam } = buildOrgClause(orgId);
  const params: unknown[] = [...orgParam, start, end];
  let repoClause = '';
  if (repo) {
    repoClause = ` AND repo = $${params.length + 1}`;
    params.push(repo);
  }
  const startIdx = orgParam.length + 1;
  const endIdx = orgParam.length + 2;

  // Two parallel histograms over the same date series. Use generate_series so
  // empty days still appear as { ingested: 0, resolved: 0 }.
  const { rows } = await pool.query(
    `WITH days AS (
       SELECT generate_series(date_trunc('day', $${startIdx}::timestamptz),
                              date_trunc('day', $${endIdx}::timestamptz),
                              interval '1 day') AS day
     ),
     ing AS (
       SELECT date_trunc('day', ingested_at) AS day, COUNT(*)::int AS n
         FROM findings
        WHERE ${orgClause}
          AND ingested_at >= $${startIdx} AND ingested_at < $${endIdx}${repoClause}
        GROUP BY 1
     ),
     res AS (
       SELECT date_trunc('day', resolved_at) AS day, COUNT(*)::int AS n
         FROM findings
        WHERE ${orgClause}
          AND status = 'fixed'
          AND resolved_at IS NOT NULL
          AND resolved_at >= $${startIdx} AND resolved_at < $${endIdx}${repoClause}
        GROUP BY 1
     )
     SELECT days.day AS day,
            COALESCE(ing.n, 0) AS ingested,
            COALESCE(res.n, 0) AS resolved
       FROM days
       LEFT JOIN ing ON ing.day = days.day
       LEFT JOIN res ON res.day = days.day
      ORDER BY days.day`,
    params,
  );

  return rows.map((r) => ({
    date: new Date(r.day).toISOString().slice(0, 10),
    ingested: Number(r.ingested),
    resolved: Number(r.resolved),
  }));
}

export async function getFixPerformance(
  orgId: string,
  filters: AnalyticsFilters,
): Promise<FixPerformanceBucket[]> {
  const pool = getPool();
  const { start, end } = getPeriodBounds(filters.range);
  const repo = filters.repo || null;

  const { clause: orgClause, param: orgParam } = buildOrgClause(orgId, 'fa');
  const params: unknown[] = [...orgParam, start, end];
  let repoClause = '';
  if (repo) {
    repoClause = ` AND f.repo = $${params.length + 1}`;
    params.push(repo);
  }
  const startIdx = orgParam.length + 1;
  const endIdx = orgParam.length + 2;

  const { rows } = await pool.query(
    `WITH days AS (
       SELECT generate_series(date_trunc('day', $${startIdx}::timestamptz),
                              date_trunc('day', $${endIdx}::timestamptz),
                              interval '1 day') AS day
     ),
     attempts AS (
       SELECT date_trunc('day', fa.completed_at) AS day,
              fa.validation_status AS vs
         FROM fix_attempts fa
         LEFT JOIN findings f ON f.id = fa.finding_id
        WHERE ${orgClause}
          AND fa.completed_at IS NOT NULL
          -- Only attempts that actually reached the re-scan have a verdict.
          -- Attempts that failed earlier (no diff, patch reject, install /
          -- test failure, tarball-fetch failure) leave validation_status NULL
          -- and are NOT auto-fix outcomes -- excluding them keeps this chart a
          -- true picture of scanner verdicts rather than pipeline plumbing.
          AND fa.validation_status IS NOT NULL
          AND fa.completed_at >= $${startIdx} AND fa.completed_at < $${endIdx}${repoClause}
     )
     SELECT days.day AS day,
            COUNT(*) FILTER (WHERE attempts.vs = 'resolved')::int AS resolved,
            COUNT(*) FILTER (WHERE attempts.vs = 'still_vulnerable')::int AS still_vulnerable,
            COUNT(*) FILTER (WHERE attempts.vs = 'inconclusive')::int AS inconclusive
       FROM days
       LEFT JOIN attempts ON attempts.day = days.day
      GROUP BY days.day
      ORDER BY days.day`,
    params,
  );

  return rows.map((r) => ({
    date: new Date(r.day).toISOString().slice(0, 10),
    resolved: Number(r.resolved),
    stillVulnerable: Number(r.still_vulnerable),
    inconclusive: Number(r.inconclusive),
  }));
}

export async function getRemediationFunnel(
  orgId: string,
  filters: AnalyticsFilters,
): Promise<FunnelStage[]> {
  const pool = getPool();
  const { start, end } = getPeriodBounds(filters.range);
  const repo = filters.repo || null;

  // Findings-side query (detected). Repo filter is direct on `findings.repo`.
  async function countDetected(): Promise<number> {
    const { clause, param } = buildOrgClause(orgId);
    const params: unknown[] = [...param, start, end];
    let repoClause = '';
    if (repo) {
      repoClause = ` AND repo = $${params.length + 1}`;
      params.push(repo);
    }
    const sIdx = param.length + 1;
    const eIdx = param.length + 2;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM findings
        WHERE ${clause}
          AND ingested_at >= $${sIdx} AND ingested_at < $${eIdx}${repoClause}`,
      params,
    );
    return rows[0]?.n ?? 0;
  }

  // fix_attempts-side queries. We JOIN findings to apply the repo filter.
  async function countAttempts(extraWhere: string, dateCol: 'created_at' | 'completed_at') {
    const { clause, param } = buildOrgClause(orgId, 'fa');
    const params: unknown[] = [...param, start, end];
    let repoClause = '';
    if (repo) {
      repoClause = ` AND f.repo = $${params.length + 1}`;
      params.push(repo);
    }
    const sIdx = param.length + 1;
    const eIdx = param.length + 2;
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT fa.finding_id)::int AS n
         FROM fix_attempts fa
         LEFT JOIN findings f ON f.id = fa.finding_id
        WHERE ${clause}
          AND fa.${dateCol} IS NOT NULL
          AND fa.${dateCol} >= $${sIdx} AND fa.${dateCol} < $${eIdx}
          ${extraWhere}${repoClause}`,
      params,
    );
    return rows[0]?.n ?? 0;
  }

  const [detected, fixAttempted, prOpened, prMerged, validatedResolved] = await Promise.all([
    countDetected(),
    countAttempts('', 'created_at'),
    countAttempts(`AND fa.pr_url IS NOT NULL`, 'created_at'),
    countAttempts(`AND fa.pr_status = 'merged'`, 'completed_at'),
    countAttempts(`AND fa.validation_status = 'resolved'`, 'completed_at'),
  ]);

  return [
    { key: 'detected', label: 'Detected', count: detected },
    { key: 'fix_attempted', label: 'Fix attempted', count: fixAttempted },
    { key: 'pr_opened', label: 'PR opened', count: prOpened },
    { key: 'pr_merged', label: 'PR merged', count: prMerged },
    { key: 'validated_resolved', label: 'Validated resolved', count: validatedResolved },
  ];
}

async function findingsBreakdownBy(
  orgId: string,
  filters: AnalyticsFilters,
  column: 'scanner_source' | 'cwe_id',
  limit: number,
): Promise<BreakdownRow[]> {
  const pool = getPool();
  const { start, end } = getPeriodBounds(filters.range);
  const repo = filters.repo || null;

  const { clause, param } = buildOrgClause(orgId);
  const params: unknown[] = [...param, start, end];
  let repoClause = '';
  if (repo) {
    repoClause = ` AND repo = $${params.length + 1}`;
    params.push(repo);
  }
  const sIdx = param.length + 1;
  const eIdx = param.length + 2;
  const limitIdx = params.length + 1;
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT ${column} AS label, COUNT(*)::int AS count
       FROM findings
      WHERE ${clause}
        AND ingested_at >= $${sIdx} AND ingested_at < $${eIdx}
        AND ${column} IS NOT NULL${repoClause}
      GROUP BY ${column}
      ORDER BY count DESC
      LIMIT $${limitIdx}`,
    params,
  );

  return rows.map((r) => ({ label: r.label as string, count: Number(r.count) }));
}

export async function getScannerBreakdown(
  orgId: string,
  filters: AnalyticsFilters,
): Promise<BreakdownRow[]> {
  return findingsBreakdownBy(orgId, filters, 'scanner_source', 10);
}

export async function getCweBreakdown(
  orgId: string,
  filters: AnalyticsFilters,
): Promise<BreakdownRow[]> {
  return findingsBreakdownBy(orgId, filters, 'cwe_id', 10);
}

export async function listRepos(orgId: string): Promise<string[]> {
  const pool = getPool();
  const { clause: orgClause, param: orgParam } = buildOrgClause(orgId);
  const { rows } = await pool.query(
    `SELECT DISTINCT repo FROM findings WHERE ${orgClause} AND repo IS NOT NULL ORDER BY repo`,
    orgParam,
  );
  return rows.map((r) => r.repo as string);
}
