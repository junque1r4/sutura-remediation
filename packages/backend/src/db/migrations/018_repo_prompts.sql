-- Per-repository developer-authored prompts (encrypted at rest, AES-256-GCM
-- via secret-encryption.ts) and the latest toolchain check per repository.
CREATE TABLE IF NOT EXISTS repo_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'test_environment',
  encrypted_prompt TEXT NOT NULL,
  prompt_preview TEXT NOT NULL DEFAULT '',
  prompt_length INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, repo, kind)
);

CREATE TABLE IF NOT EXISTS repo_toolchain_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('supported','custom_ready','needs_prompt','error')),
  language TEXT,
  test_framework TEXT,
  -- SerializedToolchain JSON, encrypted: derived commands may embed private
  -- registry URLs from the developer prompt.
  derived_config_encrypted TEXT,
  detail TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, repo)
);
