export interface ComponentRow {
  packageName: string;
  version: string;
  ecosystem: string | null;
  purl: string | null;
  repoCount: number;
  vulnCount: number;
  maxSeverity: string | null;
  severityRank: number;
}

export interface KpiResponse {
  total_components: string;
  unique_packages: string;
  vulnerable_components: string;
  repos_covered: string;
}

export interface SyncStatus {
  id: string;
  status: 'running' | 'success' | 'error';
  started_at: string;
  finished_at: string | null;
  repos_synced: number;
  repos_failed: number;
  components_upserted: number;
  vulns_found: number;
  error_message: string | null;
}

export interface LookupMatch {
  packageName: string;
  version: string;
  ecosystem: string | null;
  repoAikidoId: string;
  repoName: string;
  vulnCount: number;
}

export interface DrawerVuln {
  osvId: string;
  severity: string | null;
  summary: string | null;
  fixedVersions: string[];
  detailsUrl: string | null;
}

export interface DrawerRepo {
  repoAikidoId: string;
  repoName: string;
  scope: string | null;
  lastSeenAt: string;
}
