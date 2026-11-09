-- Migration 016: persist the AI vulnerability analysis narrative.
--
-- The finding detail page renders an AI-generated analysis (Risk Assessment,
-- Root Cause, Recommended Fix, Proposed Diff, References). Until now that
-- markdown lived ONLY in the browser's sessionStorage (per-tab, 1h TTL), so it
-- was lost on tab close, reload in a new tab, re-login, or redeploy. This table
-- persists it server-side, one row per analysis run, so re-analyzing never
-- destroys the prior analysis. The detail page surfaces the most recent row.
--
-- A separate table (not columns on `findings`) keeps the large markdown blob out
-- of the findings list query, which selects * at pageSize 500.
--
-- Idempotent (CREATE ... IF NOT EXISTS) to match migrate.ts's already-exists
-- tolerance.

CREATE TABLE IF NOT EXISTS finding_analyses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id    UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id),
  analysis_md   TEXT NOT NULL,
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest-analysis-per-finding lookup: ORDER BY created_at DESC LIMIT 1.
CREATE INDEX IF NOT EXISTS idx_finding_analyses_latest
  ON finding_analyses (finding_id, created_at DESC);
