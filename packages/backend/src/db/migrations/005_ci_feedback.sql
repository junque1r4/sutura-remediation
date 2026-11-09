-- Migration 005: CI feedback loop.
--
-- After submitMultiFile() opens the PR, the orchestrator polls GitHub
-- check_runs for the head commit until a verdict is reached. The columns
-- below persist that verdict (and any captured failure logs) so the
-- dashboard can render a "CI" tab and so retries can feed CI logs back to
-- the agent.

ALTER TABLE fix_attempts
  ADD COLUMN pr_head_sha     TEXT,
  ADD COLUMN ci_check_status TEXT
    CHECK (ci_check_status IN ('pending','success','failure','error','timed_out')),
  ADD COLUMN ci_failure_logs TEXT,
  ADD COLUMN ci_polled_at    TIMESTAMPTZ;
