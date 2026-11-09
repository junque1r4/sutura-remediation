-- Migration 014: cross-scanner signature dedup.
--
-- The same underlying vulnerability is often reported by more than one scanner
-- (e.g. the same CVE flagged by both Aikido and Snyk). We keep every scanner's
-- row for provenance, but compute a coarse, scanner-independent `signature`
-- (see packages/common/src/signature.ts) and link later duplicates to the
-- earliest-ingested canonical row via `duplicate_of`. Dashboards then hide
-- duplicates by default. The existing (org_id, scanner_source, external_id)
-- unique constraint is unchanged -- it still provides same-scanner idempotency.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) to match
-- migrate.ts's already-exists tolerance.

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS signature    text,
  ADD COLUMN IF NOT EXISTS duplicate_of uuid REFERENCES findings(id);

-- Equality lookup for same-org, same-signature canonical resolution on upsert.
CREATE INDEX IF NOT EXISTS idx_findings_signature
  ON findings (org_id, signature);

-- Partial index so dashboards can cheaply exclude (or list) duplicates.
CREATE INDEX IF NOT EXISTS idx_findings_duplicate_of
  ON findings (duplicate_of)
  WHERE duplicate_of IS NOT NULL;
