-- Validated Fix Pipeline: per-attempt tracking, retry chains, sandbox + scan output

ALTER TABLE fix_attempts
  ADD COLUMN attempt_number    INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN parent_attempt_id UUID    REFERENCES fix_attempts(id),
  ADD COLUMN status            TEXT    NOT NULL DEFAULT 'succeeded'
             CHECK (status IN ('running', 'succeeded', 'failed', 'exhausted')),
  ADD COLUMN test_output       TEXT,
  ADD COLUMN test_files_added  JSONB,
  ADD COLUMN validation_status TEXT
             CHECK (validation_status IN ('resolved', 'still_vulnerable', 'inconclusive')),
  ADD COLUMN scan_output       TEXT,
  ADD COLUMN scan_tool         TEXT,
  ADD COLUMN failure_reason    TEXT;

CREATE INDEX idx_fix_attempts_parent ON fix_attempts(parent_attempt_id);
CREATE INDEX idx_fix_attempts_finding_attempt ON fix_attempts(finding_id, attempt_number);

CREATE TABLE sandbox_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fix_attempt_id  UUID NOT NULL REFERENCES fix_attempts(id) ON DELETE CASCADE,
  step            TEXT NOT NULL CHECK (step IN ('install', 'tests', 'patch', 'scan', 'cleanup')),
  exit_code       INTEGER,
  stdout          TEXT,
  stderr          TEXT,
  duration_ms     INTEGER,
  timed_out       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sandbox_logs_attempt ON sandbox_logs(fix_attempt_id, created_at);
