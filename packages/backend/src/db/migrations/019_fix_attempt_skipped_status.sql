-- The validated-fix pipeline now records a neutral 'skipped' attempt when it
-- deliberately declines to fix a finding (verification gate judged it not
-- exploitable/unreachable, or triage put it below the auto-fix threshold).
-- Previously these were stored as status='failed'/failure_reason='exhausted'
-- and rendered as a red failed attempt. Widen the status CHECK to accept it.
ALTER TABLE fix_attempts DROP CONSTRAINT IF EXISTS fix_attempts_status_check;
ALTER TABLE fix_attempts ADD CONSTRAINT fix_attempts_status_check
  CHECK (status IN ('running','succeeded','failed','exhausted','skipped'));
