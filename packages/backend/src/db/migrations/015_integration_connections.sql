-- Migration 015: org-scoped integration connections (encrypted-at-rest).
--
-- Replaces the per-integration encrypted httpOnly cookies (Anthropic / Snyk /
-- Aikido) with a single org-scoped table. The provider SECRET is encrypted at
-- rest server-side via lib/secret-encryption.ts (AES-256-GCM keyed by
-- sha256(INTEGRATION_ENCRYPTION_KEY)); only the ciphertext is stored here and it
-- is NEVER returned to the browser. Non-secret display/config fields live in
-- masked_identifier + metadata_json. Background workers read+decrypt directly
-- from this table (no request cookie). GitHub is intentionally NOT migrated --
-- it already lives in organizations.settings_json.integrations.github.
--
-- UNIQUE (org_id, provider) gives one connection per provider per org and makes
-- the INSERT ... ON CONFLICT upsert in db/connections.ts work.
--
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS, inline CHECK -- no CREATE TYPE)
-- to match migrate.ts's already-exists tolerance.

CREATE TABLE IF NOT EXISTS integration_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('anthropic', 'snyk', 'aikido')),
  encrypted_secret  TEXT NOT NULL,
  masked_identifier TEXT,
  metadata_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_by      TEXT,
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integration_connections_org
  ON integration_connections (org_id);
