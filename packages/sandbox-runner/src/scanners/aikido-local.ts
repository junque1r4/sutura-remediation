import { VALIDATION_LIMITS } from '@sutura/common';
import type { NormalizedFinding } from '@sutura/common';
import type { RunResult, SandboxRunner, ScanResult, WorkspaceHandle } from '../types';
import { shellEscape } from '../shell-escape';

const SCAN_TIMEOUT = VALIDATION_LIMITS.SCAN_TIMEOUT_MS;

/**
 * Sentinel reasons surfaced via ScanResult.tool when Aikido cannot produce a
 * verdict; the dispatcher in scanners.ts uses these to decide whether to fall
 * back to OSS scanners (npm audit / pip-audit / osv-scanner / semgrep).
 */
export const AIKIDO_UNAVAILABLE = 'aikido-unavailable';
export const AIKIDO_UNSUPPORTED = 'aikido-unsupported-finding';

interface AikidoCliIssue {
  id?: string;
  cve_id?: string;
  cwe?: string;
  cwe_id?: string;
  rule?: string;
  rule_id?: string;
  affected_file?: string;
  file?: string;
  affected_package?: string;
  package?: string;
  severity?: string;
}

interface AikidoCliReport {
  issues?: AikidoCliIssue[];
  findings?: AikidoCliIssue[];
  results?: AikidoCliIssue[];
}

export interface RunAikidoLocalInput {
  finding: NormalizedFinding;
  ws: WorkspaceHandle;
  runner: SandboxRunner;
  apiKey: string;
}

/**
 * Run Aikido's local-scan CLI inside the sandbox container against /work and
 * decide whether the original finding is still present. Returns
 * `verdict: 'inconclusive'` with `tool: AIKIDO_UNAVAILABLE` when the CLI is not
 * installed in the sandbox image, so the caller can fall back to OSS scanners.
 *
 * Operators are expected to bake `aikido` (or `aikido-cli`) into the sandbox
 * base image. The CLI binary name is configurable via the `AIKIDO_CLI_BIN`
 * env var inside the container; default is `aikido`.
 */
export async function runAikidoLocal(input: RunAikidoLocalInput): Promise<ScanResult> {
  const { finding, ws, runner, apiKey } = input;

  // Detect the CLI. Tolerate either `aikido` or `aikido-cli`.
  const probe = await runner.exec(
    ws,
    ['sh', '-lc', 'command -v aikido || command -v aikido-cli || true'],
    5_000,
  );
  const bin = probe.stdout.trim().split('\n').filter(Boolean).pop();
  if (!bin) {
    return inconclusive(AIKIDO_UNAVAILABLE, 'Aikido CLI not found in sandbox image');
  }

  // Run the scan. We deliberately keep the invocation generic so the same code
  // works whether the CLI is the SCA-only or the full SAST+SCA build; the JSON
  // shape we parse is best-effort and tolerant of all known variants.
  const cmd = ['sh', '-lc', `${shellEscape(bin)} scan --json --cwd /work || true`];
  const res = await runner.exec(ws, cmd, SCAN_TIMEOUT, {
    isolateNetwork: false,
    env: { AIKIDO_API_KEY: apiKey },
  });
  if (res.timedOut) return inconclusive('aikido-local', 'Timed out', res.command, true);

  // The CLI may exit non-zero when issues are present; we look at JSON, not
  // exit code, to decide.
  const report = parseReport(res);
  if (!report) {
    return inconclusive('aikido-local', tail(res.stdout || res.stderr), res.command);
  }

  const allIssues = collectIssues(report);
  const matched = matchIssuesToFinding(finding, allIssues);

  return {
    verdict: matched.length > 0 ? 'still_vulnerable' : 'resolved',
    tool: 'aikido-local',
    output: tail(res.stdout),
    matched,
    timedOut: false,
    command: res.command,
  };
}

// ---------------- helpers ----------------

function inconclusive(tool: string, output: string, command = '', timedOut = false): ScanResult {
  return { verdict: 'inconclusive', tool, output: tail(output), matched: [], timedOut, command };
}

function parseReport(res: RunResult): AikidoCliReport | null {
  const tryParse = (s: string): AikidoCliReport | null => {
    try {
      return JSON.parse(s) as AikidoCliReport;
    } catch {
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(s.slice(start, end + 1)) as AikidoCliReport;
        } catch {
          return null;
        }
      }
      return null;
    }
  };
  return tryParse(res.stdout) ?? tryParse(res.stderr);
}

function collectIssues(report: AikidoCliReport): AikidoCliIssue[] {
  return [
    ...(report.issues ?? []),
    ...(report.findings ?? []),
    ...(report.results ?? []),
  ];
}

/**
 * Decide whether an Aikido CLI issue still represents the original finding.
 * Match on the strongest available identifier in this order: CVE, then CWE,
 * then file+package, then file. Any positive match is sufficient.
 */
function matchIssuesToFinding(
  finding: NormalizedFinding,
  issues: AikidoCliIssue[],
): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    if (matches(finding, issue)) {
      const id = issue.id ?? issue.cve_id ?? issue.rule_id ?? issue.rule ?? 'aikido-issue';
      out.push(id);
    }
  }
  return out;
}

function matches(finding: NormalizedFinding, issue: AikidoCliIssue): boolean {
  if (finding.cveId && issue.cve_id && eqIgnoreCase(finding.cveId, issue.cve_id)) return true;
  const issueCwe = issue.cwe ?? issue.cwe_id;
  if (finding.cweId && issueCwe && eqIgnoreCase(finding.cweId, issueCwe)) return true;
  const issueFile = issue.affected_file ?? issue.file;
  const issuePkg = issue.affected_package ?? issue.package;
  if (finding.filePath && issueFile && samePath(finding.filePath, issueFile)) {
    if (finding.packageName && issuePkg) {
      return eqIgnoreCase(finding.packageName, issuePkg);
    }
    return true;
  }
  if (finding.packageName && issuePkg && eqIgnoreCase(finding.packageName, issuePkg)) {
    return true;
  }
  return false;
}

function eqIgnoreCase(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function samePath(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return norm(a) === norm(b) || norm(a).endsWith(norm(b)) || norm(b).endsWith(norm(a));
}

function tail(s: string): string {
  return s.length > VALIDATION_LIMITS.MAX_LOG_BYTES
    ? s.slice(s.length - VALIDATION_LIMITS.MAX_LOG_BYTES)
    : s;
}
