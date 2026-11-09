-- Sutura: Supply-chain SBOM inventory and OSV-derived vulnerabilities.
-- Used by the /supply-chain page to look up libraries when a new
-- supply-chain attack is announced and to cross-reference every component
-- against the OSV.dev vulnerability database.

CREATE TABLE IF NOT EXISTS sbom_components (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repo_aikido_id  TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  package_name    TEXT NOT NULL,
  version         TEXT NOT NULL,
  ecosystem       TEXT,
  purl            TEXT,
  scope           TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, repo_aikido_id, package_name, version)
);

CREATE INDEX IF NOT EXISTS idx_sbom_components_org_name
  ON sbom_components (org_id, lower(package_name));
CREATE INDEX IF NOT EXISTS idx_sbom_components_org_ecosystem
  ON sbom_components (org_id, ecosystem);
CREATE INDEX IF NOT EXISTS idx_sbom_components_org_repo
  ON sbom_components (org_id, repo_aikido_id);

CREATE TABLE IF NOT EXISTS sbom_vulnerabilities (
  id              BIGSERIAL PRIMARY KEY,
  component_id    BIGINT NOT NULL REFERENCES sbom_components(id) ON DELETE CASCADE,
  osv_id          TEXT NOT NULL,
  severity        TEXT,
  summary         TEXT,
  fixed_versions  TEXT[] NOT NULL DEFAULT '{}',
  details_url     TEXT,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (component_id, osv_id)
);

CREATE INDEX IF NOT EXISTS idx_sbom_vulnerabilities_component
  ON sbom_vulnerabilities (component_id);

CREATE TABLE IF NOT EXISTS sbom_sync_runs (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'success', 'error')),
  repos_synced        INT NOT NULL DEFAULT 0,
  repos_failed        INT NOT NULL DEFAULT 0,
  components_upserted INT NOT NULL DEFAULT 0,
  vulns_found         INT NOT NULL DEFAULT 0,
  error_message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbom_sync_runs_org_started
  ON sbom_sync_runs (org_id, started_at DESC);
