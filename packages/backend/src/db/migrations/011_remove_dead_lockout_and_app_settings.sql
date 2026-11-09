-- Sutura: remove dead per-user lockout state and the unused app_settings table.
--
-- Audit finding: users.locked_until and users.failed_login_count were declared
-- in 007_auth_schema.sql but NEVER written by any code path. The login route
-- read locked_until but nothing ever set it, so the lockout was dead. Real
-- brute-force throttling lives in auth_rate_limits (keyed by email/IP), which
-- is untouched here.
--
-- app_settings was a generic KV table intended for runtime-managed secrets, but
-- integration secrets are stored elsewhere (connections / app config) and no
-- code reads or writes app_settings. Dropping it removes a dead surface.
--
-- Idempotent: every statement is guarded with IF EXISTS, so re-running is a
-- no-op.

ALTER TABLE IF EXISTS users DROP COLUMN IF EXISTS locked_until;
ALTER TABLE IF EXISTS users DROP COLUMN IF EXISTS failed_login_count;

DROP TABLE IF EXISTS app_settings;
