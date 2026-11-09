-- Migration 013: adversarial patch validation (independent grader + bypass).
--
-- After the rescan reports 'resolved', the validated-fix orchestrator runs two
-- adversarial checks before opening a PR: an independent grader that re-verifies
-- the fix from a fresh workspace, and a red-team bypass agent that tries to
-- prove the fix is illusory. The columns below persist those results on the
-- fix attempt so the dashboard can show *why* a fix that "passed" the scan was
-- nonetheless rejected (grader disagreed / bypass succeeded).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) to match migrate.ts's already-exists
-- tolerance.

ALTER TABLE fix_attempts
  ADD COLUMN IF NOT EXISTS grader_verdict    jsonb,
  ADD COLUMN IF NOT EXISTS bypass_attempted  boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS bypass_result     jsonb;
