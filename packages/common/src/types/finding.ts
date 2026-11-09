export type Scanner = 'aikido' | 'snyk' | 'sonarqube' | 'github_dependabot';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type FindingStatus = 'open' | 'fixing' | 'fixed' | 'wont_fix' | 'failed';

export interface NormalizedFinding {
  externalId: string;
  scanner: Scanner;
  title: string;
  description: string;
  severity: Severity;
  cvssScore?: number;
  epssScore?: number;
  cweId?: string;
  cveId?: string;
  filePath?: string;
  lineRange?: [number, number];
  repo: string;
  packageName?: string;
  currentVersion?: string;
  fixedVersion?: string;
  rawPayload: Record<string, unknown>;
}
