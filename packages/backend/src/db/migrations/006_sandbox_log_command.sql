-- Migration 006: store the actual command run for each sandbox step.
--
-- Existing rows render with `command = NULL` and the UI shows "—" for the
-- chip, so no backfill is needed.

ALTER TABLE sandbox_logs ADD COLUMN command TEXT;
