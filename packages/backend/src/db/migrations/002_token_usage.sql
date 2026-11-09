-- Sutura: Token usage tracking for Anthropic API calls
CREATE TABLE token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  operation TEXT NOT NULL CHECK (operation IN ('analysis', 'fix_generation')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd NUMERIC(12,6) NOT NULL,
  -- finding_id is TEXT (not UUID FK) because the dashboard analysis flow
  -- stores the scanner external id, while the fix-worker stores a DB UUID.
  -- Both are valid identifiers; FK would force one or the other.
  finding_id TEXT,
  finding_title TEXT,
  finding_severity TEXT,
  fix_attempt_id UUID REFERENCES fix_attempts(id),
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_token_usage_created ON token_usage(created_at DESC);
CREATE INDEX idx_token_usage_org ON token_usage(org_id, created_at DESC);
CREATE INDEX idx_token_usage_operation ON token_usage(operation, created_at DESC);
CREATE INDEX idx_token_usage_finding ON token_usage(finding_id);
CREATE INDEX idx_token_usage_fix_attempt ON token_usage(fix_attempt_id);
