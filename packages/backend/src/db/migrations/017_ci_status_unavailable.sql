-- The CI watcher now degrades to 'unavailable' instead of throwing when it
-- cannot read check runs (e.g. the GitHub App lacks Checks: Read). Widen the
-- ci_check_status CHECK to accept the new value.
ALTER TABLE fix_attempts DROP CONSTRAINT IF EXISTS fix_attempts_ci_check_status_check;
ALTER TABLE fix_attempts ADD CONSTRAINT fix_attempts_ci_check_status_check
  CHECK (ci_check_status IN ('pending','success','failure','error','timed_out','unavailable'));
