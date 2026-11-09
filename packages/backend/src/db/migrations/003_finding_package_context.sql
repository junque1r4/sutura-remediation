-- Persist Aikido (and other SCA scanner) package context so the analysis agent
-- can branch on dependency vulnerabilities and propose manifest bumps instead
-- of grepping the source for transitive packages it can't find.

ALTER TABLE findings
  ADD COLUMN package_name    TEXT,
  ADD COLUMN current_version TEXT,
  ADD COLUMN fixed_version   TEXT,
  ADD COLUMN raw_payload     JSONB;

CREATE INDEX idx_findings_org_package ON findings(org_id, package_name)
  WHERE package_name IS NOT NULL;
