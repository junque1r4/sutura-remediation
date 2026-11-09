-- Migration 012: pre-fix verification (exploitability) verdict.
--
-- Before generating a fix, the validated-fix orchestrator runs a verification
-- agent that inspects the vulnerable code and decides whether the finding is a
-- real, reachable, exploitable vulnerability. The columns below persist that
-- verdict on the finding so the dashboard can surface it (and so a finding the
-- gate rejected can be shown as "won't fix: skipped by verification gate").
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) to match
-- migrate.ts's already-exists tolerance.

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS verification_verdict jsonb,
  ADD COLUMN IF NOT EXISTS reachable            boolean,
  ADD COLUMN IF NOT EXISTS exploitability       text,
  ADD COLUMN IF NOT EXISTS verified_at          timestamptz;

-- Partial index so dashboards can cheaply list findings that have been verified.
CREATE INDEX IF NOT EXISTS idx_findings_verified_at
  ON findings (verified_at)
  WHERE verified_at IS NOT NULL;
