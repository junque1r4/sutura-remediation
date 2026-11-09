-- VulnFix Platform: Initial Schema
-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pilot',
  settings_json JSONB NOT NULL DEFAULT '{}',
  custom_prompts_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Findings ingested from scanners
CREATE TABLE findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  scanner_source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  cvss_score NUMERIC(3,1),
  epss_score NUMERIC(5,4),
  cwe_id TEXT,
  cve_id TEXT,
  file_path TEXT,
  line_range INT4RANGE,
  repo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixing', 'fixed', 'wont_fix', 'failed')),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (org_id, scanner_source, external_id)
);

-- Fix attempts
CREATE TABLE fix_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id UUID NOT NULL REFERENCES findings(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  prompt_snapshot TEXT NOT NULL,
  generated_diff TEXT,
  test_result TEXT CHECK (test_result IN ('pass', 'fail', 'skip')),
  pr_url TEXT,
  pr_status TEXT CHECK (pr_status IN ('open', 'merged', 'closed', 'edited')),
  claude_model TEXT NOT NULL,
  claude_tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Codebase index metadata
CREATE TABLE codebase_indices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  last_indexed_at TIMESTAMPTZ,
  file_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  vector_namespace TEXT NOT NULL,
  UNIQUE (org_id, repo, branch)
);

-- Audit log
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_findings_org_status ON findings(org_id, status);
CREATE INDEX idx_findings_org_severity ON findings(org_id, severity);
CREATE INDEX idx_fix_attempts_finding ON fix_attempts(finding_id);
CREATE INDEX idx_audit_log_org ON audit_log(org_id, created_at DESC);
