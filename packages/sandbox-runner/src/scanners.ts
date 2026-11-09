import { VALIDATION_LIMITS } from '@sutura/common';
import type { NormalizedFinding } from '@sutura/common';
import type { ScanOptions, ScanResult, ScanVerdict, SandboxRunner, WorkspaceHandle } from './types';
import { AIKIDO_UNAVAILABLE, AIKIDO_UNSUPPORTED, runAikidoLocal } from './scanners/aikido-local';
import { shellEscape } from './shell-escape';

const SCAN_TIMEOUT = VALIDATION_LIMITS.SCAN_TIMEOUT_MS;

/**
 * Run a local re-analysis to confirm the patched workspace no longer exhibits
 * the original vulnerability. When an Aikido API key is supplied, runs Aikido's
 * local CLI inside the sandbox first; if the CLI is unavailable or returns
 * inconclusive, falls back to per-language OSS scanners.
 */
export async function runSecurityScan(
  finding: NormalizedFinding,
  ws: WorkspaceHandle,
  runner: SandboxRunner,
  options: ScanOptions = {},
): Promise<ScanResult> {
  if (options.aikidoApiKey) {
    const aikido = await runAikidoLocal({ finding, ws, runner, apiKey: options.aikidoApiKey });
    const fellThrough =
      aikido.verdict === 'inconclusive' &&
      (aikido.tool === AIKIDO_UNAVAILABLE || aikido.tool === AIKIDO_UNSUPPORTED);
    if (!fellThrough) return aikido;
    // Fall through to OSS scanners as a safety net.
  }

  return await runOssFallback(finding, ws, runner);
}

/**
 * Lockfile / dependency manifest path patterns. When the finding's file_path
 * matches one of these AND a CVE is reported, treat the finding as SCA even
 * if `packageName` wasn't populated by the ingester (real-world Aikido /
 * Snyk payloads frequently omit it).
 */
const LOCKFILE_PATTERNS = [
  /package-lock\.json$/i,
  /package\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /requirements.*\.txt$/i,
  /pyproject\.toml$/i,
  /poetry\.lock$/i,
  /Pipfile(\.lock)?$/i,
  /go\.(mod|sum)$/i,
  /Gemfile(\.lock)?$/i,
  /pom\.xml$/i,
  /build\.gradle(\.kts)?$/i,
];

function looksLikeDependencyManifest(filePath: string | undefined): boolean {
  if (!filePath) return false;
  return LOCKFILE_PATTERNS.some((re) => re.test(filePath));
}

async function runOssFallback(
  finding: NormalizedFinding,
  ws: WorkspaceHandle,
  runner: SandboxRunner,
): Promise<ScanResult> {
  // SCA whenever the finding has a packageName, OR the reported file is a
  // dependency manifest with a CVE attached. The latter covers Aikido /
  // Snyk findings that report a lockfile + CVE but leave packageName empty.
  const isSCA =
    !!finding.packageName ||
    (!!finding.cveId && looksLikeDependencyManifest(finding.filePath));

  if (isSCA) {
    // osv-scanner is CVE-precise: it matches the finding's CVE against each
    // advisory's aliases, so a fix that clears the specific CVE reads as
    // `resolved` even when the package still carries unrelated advisories
    // (common for unmaintained-but-popular packages like lodash). It also
    // covers every ecosystem. npm audit / pip-audit are package-granular
    // fallbacks, used only when osv-scanner can't produce a verdict.
    const osv = await runOsvScanner(finding, ws, runner);
    if (osv.verdict !== 'inconclusive') return osv;

    const npmTry = await tryNpmAudit(finding, ws, runner);
    if (npmTry && npmTry.verdict !== 'inconclusive') return npmTry;

    const pipTry = await tryPipAudit(finding, ws, runner);
    if (pipTry && pipTry.verdict !== 'inconclusive') return pipTry;

    return npmTry ?? pipTry ?? osv;
  }

  // SAST: rule-based finding tied to a file/CWE
  if (finding.cweId || finding.filePath) {
    return await runSemgrep(finding, ws, runner);
  }

  return inconclusive('no-scanner-matched', 'Could not determine appropriate validation scanner.', '');
}

// ---------------- npm audit ----------------

async function tryNpmAudit(
  finding: NormalizedFinding,
  ws: WorkspaceHandle,
  runner: SandboxRunner,
): Promise<ScanResult | null> {
  const hasPkg = await runner.exec(ws, ['sh', '-lc', 'test -f package.json && echo yes || echo no'], 5_000);
  if (hasPkg.stdout.trim() !== 'yes') return null;

  const cmd = ['sh', '-lc', 'npm audit --json --omit=dev || true'];
  const res = await runner.exec(ws, cmd, SCAN_TIMEOUT, { isolateNetwork: false });
  if (res.timedOut) return inconclusive('npm-audit', 'Timed out', res.command, true);

  const parsed = parseJson(res.stdout);
  if (!parsed) return inconclusive('npm-audit', res.stdout || res.stderr, res.command);

  // `npm audit --json` keys `vulnerabilities` by package name and exposes
  // advisory identity only as GitHub Security Advisory (GHSA) URLs -- it does
  // NOT emit CVE ids. So decide by package name: if the finding's package is
  // still flagged, the fix didn't clear it. With no package name, fall back to
  // "any vulnerability present".
  const vulnPackages = collectNpmAuditPackages(parsed);
  const pkgLower = finding.packageName?.toLowerCase();
  const stillVuln = pkgLower
    ? vulnPackages.some((p) => p.toLowerCase() === pkgLower)
    : vulnPackages.length > 0;
  const matched = pkgLower
    ? stillVuln
      ? [finding.packageName as string]
      : []
    : vulnPackages;
  return {
    verdict: (stillVuln ? 'still_vulnerable' : 'resolved') as ScanVerdict,
    tool: 'npm-audit',
    output: trim(res.stdout),
    matched,
    timedOut: false,
    command: res.command,
  };
}

/** Package names npm audit still flags as vulnerable (keys of `vulnerabilities`). */
function collectNpmAuditPackages(report: unknown): string[] {
  const r = report as { vulnerabilities?: Record<string, unknown> };
  return Object.keys(r.vulnerabilities ?? {});
}

// ---------------- pip-audit ----------------

async function tryPipAudit(
  finding: NormalizedFinding,
  ws: WorkspaceHandle,
  runner: SandboxRunner,
): Promise<ScanResult | null> {
  const probe = await runner.exec(
    ws,
    [
      'sh',
      '-lc',
      'test -f requirements.txt && echo reqs || (test -f pyproject.toml && echo pyproject || echo no)',
    ],
    5_000,
  );
  const kind = probe.stdout.trim();
  if (kind === 'no') return null;

  // Bare `pip-audit` audits the *ambient* interpreter environment, which in the
  // sandbox is the base image's own tooling (semgrep, pip-audit, ...) -- not the
  // repo. Point it at requirements.txt explicitly so the verdict reflects the
  // project's declared dependencies. (pyproject-only projects fall back to the
  // env, which the install step populated via `pip install -e .`.)
  const auditCmd =
    kind === 'reqs'
      ? 'pip-audit --format=json -r requirements.txt || true'
      : 'pip-audit --format=json || true';
  const res = await runner.exec(ws, ['sh', '-lc', auditCmd], SCAN_TIMEOUT, {
    isolateNetwork: false,
  });
  if (res.timedOut) return inconclusive('pip-audit', 'Timed out', res.command, true);

  const parsed = parseJson(res.stdout) as
    | { dependencies?: Array<{ vulns?: Array<{ id?: string; aliases?: string[] }> }> }
    | null;
  if (!parsed) return inconclusive('pip-audit', res.stdout || res.stderr, res.command);

  const matched = new Set<string>();
  for (const dep of parsed.dependencies ?? []) {
    for (const vuln of dep.vulns ?? []) {
      if (vuln.id) matched.add(vuln.id);
      for (const alias of vuln.aliases ?? []) matched.add(alias);
    }
  }
  const arr = Array.from(matched);
  const stillVuln = finding.cveId ? arr.includes(finding.cveId) : arr.length > 0;
  return {
    verdict: stillVuln ? 'still_vulnerable' : 'resolved',
    tool: 'pip-audit',
    output: trim(res.stdout),
    matched: arr,
    timedOut: false,
    command: res.command,
  };
}

// ---------------- osv-scanner ----------------

async function runOsvScanner(
  finding: NormalizedFinding,
  ws: WorkspaceHandle,
  runner: SandboxRunner,
): Promise<ScanResult> {
  const res = await runner.exec(
    ws,
    ['sh', '-lc', 'osv-scanner --format=json . || true'],
    SCAN_TIMEOUT,
    { isolateNetwork: false },
  );
  if (res.timedOut) return inconclusive('osv-scanner', 'Timed out', res.command, true);

  const parsed = parseJson(res.stdout) as
    | {
        results?: Array<{
          packages?: Array<{ vulnerabilities?: Array<{ id?: string; aliases?: string[] }> }>;
        }>;
      }
    | null;
  if (!parsed) return inconclusive('osv-scanner', res.stdout || res.stderr, res.command);

  const matched = new Set<string>();
  for (const r of parsed.results ?? []) {
    for (const p of r.packages ?? []) {
      for (const v of p.vulnerabilities ?? []) {
        if (v.id) matched.add(v.id);
        for (const a of v.aliases ?? []) matched.add(a);
      }
    }
  }
  const arr = Array.from(matched);
  const stillVuln = finding.cveId ? arr.includes(finding.cveId) : arr.length > 0;
  return {
    verdict: stillVuln ? 'still_vulnerable' : 'resolved',
    tool: 'osv-scanner',
    output: trim(res.stdout),
    matched: arr,
    timedOut: false,
    command: res.command,
  };
}

// ---------------- semgrep ----------------

async function runSemgrep(
  finding: NormalizedFinding,
  ws: WorkspaceHandle,
  runner: SandboxRunner,
): Promise<ScanResult> {
  const target = finding.filePath ? shellEscape(finding.filePath) : '.';
  const res = await runner.exec(
    ws,
    [
      'sh',
      '-lc',
      // `--config=auto` is rejected when `--metrics=off` (semgrep needs metrics
      // to resolve the auto ruleset); use the pinned `p/default` pack instead --
      // it ships the security rules and runs fully offline-friendly.
      `semgrep --config=p/default --json --metrics=off --error --no-git-ignore ${target} || true`,
    ],
    SCAN_TIMEOUT,
    { isolateNetwork: false },
  );
  if (res.timedOut) return inconclusive('semgrep', 'Timed out', res.command, true);

  const parsed = parseJson(res.stdout) as
    | { results?: Array<{ check_id?: string; extra?: { metadata?: { cwe?: string[] } } }> }
    | null;
  if (!parsed) return inconclusive('semgrep', res.stdout || res.stderr, res.command);

  const wantedCwe = finding.cweId ?? '';
  const matched = new Set<string>();
  for (const r of parsed.results ?? []) {
    const cwes = r.extra?.metadata?.cwe ?? [];
    if (wantedCwe && cwes.some((c) => c.includes(wantedCwe))) {
      if (r.check_id) matched.add(r.check_id);
    } else if (!wantedCwe && r.check_id) {
      matched.add(r.check_id);
    }
  }
  const arr = Array.from(matched);
  return {
    verdict: arr.length > 0 ? 'still_vulnerable' : 'resolved',
    tool: 'semgrep',
    output: trim(res.stdout),
    matched: arr,
    timedOut: false,
    command: res.command,
  };
}

// ---------------- helpers ----------------

function inconclusive(tool: string, output: string, command = '', timedOut = false): ScanResult {
  return { verdict: 'inconclusive', tool, output: trim(output), matched: [], timedOut, command };
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Some scanners emit log noise before the JSON; try the last brace block.
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function trim(s: string): string {
  return s.length > VALIDATION_LIMITS.MAX_LOG_BYTES
    ? s.slice(s.length - VALIDATION_LIMITS.MAX_LOG_BYTES)
    : s;
}
