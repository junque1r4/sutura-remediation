/**
 * Stress test for the validated-fix re-scan pipeline.
 *
 * Drives the REAL scanners (`runSecurityScan` + `DockerSandboxRunner`) against
 * real vulnerable / fixed fixtures and asserts the verdict. This is the same
 * code path the orchestrator runs at orchestrator.ts:207 -- it answers the
 * question "does the re-scan actually decide resolved vs still_vulnerable".
 *
 * Run:  node_modules/.bin/tsx packages/sandbox-runner/scripts/stress-rescan.ts
 * Needs: Docker socket + the sutura/sandbox-base image + outbound network.
 */
import * as tar from 'tar-stream';
import { DockerSandboxRunner, runSecurityScan } from '../src/index';
import type { NormalizedFinding, ScanResult, ScanVerdict } from '../src/index';

function buildTar(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on('data', (c: Buffer) => chunks.push(c));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
    for (const [name, content] of Object.entries(files)) {
      // createWorkspace strips one top-level dir, so nest everything under repo/.
      pack.entry({ name: `repo/${name}` }, content);
    }
    pack.finalize();
  });
}

function finding(p: Partial<NormalizedFinding>): NormalizedFinding {
  return {
    externalId: 'stress',
    scanner: 'stress-test',
    title: 'stress fixture',
    description: '',
    severity: 'high',
    repo: 'sutura/stress',
    rawPayload: {},
    ...p,
  };
}

interface CaseResult {
  name: string;
  expected: ScanVerdict;
  got: ScanVerdict;
  tool: string;
  matched: string;
  timedOut: boolean;
  ok: boolean;
  note: string;
}

const results: CaseResult[] = [];

function record(
  name: string,
  expected: ScanVerdict,
  scan: ScanResult,
  note = '',
): void {
  results.push({
    name,
    expected,
    got: scan.verdict,
    tool: scan.tool,
    matched: scan.matched.slice(0, 4).join(',') || '-',
    timedOut: scan.timedOut,
    ok: scan.verdict === expected,
    note,
  });
  const tag = scan.verdict === expected ? 'PASS' : 'FAIL';
  console.log(
    `[${tag}] ${name}\n` +
      `       expected=${expected} got=${scan.verdict} tool=${scan.tool} ` +
      `timedOut=${scan.timedOut} matched=[${scan.matched.slice(0, 6).join(', ')}]`,
  );
  if (scan.verdict !== expected) {
    console.log(`       output tail: ${scan.output.slice(-280).replace(/\n/g, ' ')}`);
  }
}

const VULN_JS = [
  "const { execSync } = require('child_process');",
  'function run(userInput) {',
  "  return execSync('echo ' + userInput).toString();",
  '}',
  'module.exports = { run };',
  '',
].join('\n');

const SAFE_JS = [
  'function run(userInput) {',
  "  return 'echo ' + String(userInput);",
  '}',
  'module.exports = { run };',
  '',
].join('\n');

async function main(): Promise<void> {
  const runner = new DockerSandboxRunner();
  const t0 = Date.now();

  // ---- npm SCA: lodash 4.17.4 has 10+ active advisories ----
  // Reused for 3 cases: bare npm-audit, aikido-fallthrough, and osv-scanner.
  {
    const ws = await runner.createWorkspace(
      await buildTar({
        'package.json': JSON.stringify({
          name: 'vuln-fixture',
          version: '1.0.0',
          dependencies: { lodash: '4.17.4' },
        }),
      }),
    );
    try {
      const inst = await runner.install(ws);
      console.log(`  (npm install exit=${inst.exitCode} ${inst.durationMs}ms)`);

      const f = finding({
        cveId: 'CVE-2019-10744',
        packageName: 'lodash',
        filePath: 'package.json',
      });

      // Case 1: plain OSS path (npm audit).
      record(
        'SCA / vulnerable lodash@4.17.4',
        'still_vulnerable',
        await runSecurityScan(f, ws, runner, {}),
      );

      // Case 2: aikido key set but CLI absent -> must fall through to OSS.
      record(
        'aikido fallthrough -> OSS scanner',
        'still_vulnerable',
        await runSecurityScan(f, ws, runner, { aikidoApiKey: 'fake-client:fake-secret' }),
        'tool should NOT be aikido-unavailable',
      );

      // Case 3: drop package.json so the dispatcher picks osv-scanner.
      await runner.exec(ws, ['rm', '-f', 'package.json'], 10_000);
      record(
        'osv-scanner / vulnerable lodash (lockfile only)',
        'still_vulnerable',
        await runSecurityScan(
          finding({
            cveId: 'CVE-2019-10744',
            packageName: 'lodash',
            filePath: 'package-lock.json',
          }),
          ws,
          runner,
          {},
        ),
      );
    } finally {
      await runner.cleanup(ws).catch(() => {});
    }
  }

  // ---- npm SCA: lodash 4.17.21 is clean ----
  {
    const ws = await runner.createWorkspace(
      await buildTar({
        'package.json': JSON.stringify({
          name: 'safe-fixture',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
        }),
      }),
    );
    try {
      await runner.install(ws);
      record(
        'SCA / patched lodash@4.17.21',
        'resolved',
        await runSecurityScan(
          finding({ cveId: 'CVE-2019-10744', packageName: 'lodash', filePath: 'package.json' }),
          ws,
          runner,
          {},
        ),
      );
    } finally {
      await runner.cleanup(ws).catch(() => {});
    }
  }

  // ---- semgrep SAST: command injection present ----
  {
    const ws = await runner.createWorkspace(await buildTar({ 'app.js': VULN_JS }));
    try {
      record(
        'semgrep / command injection present',
        'still_vulnerable',
        await runSecurityScan(finding({ filePath: 'app.js' }), ws, runner, {}),
      );
    } finally {
      await runner.cleanup(ws).catch(() => {});
    }
  }

  // ---- semgrep SAST: clean file ----
  {
    const ws = await runner.createWorkspace(await buildTar({ 'app.js': SAFE_JS }));
    try {
      record(
        'semgrep / clean file',
        'resolved',
        await runSecurityScan(finding({ filePath: 'app.js' }), ws, runner, {}),
      );
    } finally {
      await runner.cleanup(ws).catch(() => {});
    }
  }

  // ---- pip-audit: Jinja2 2.10 has CVE-2019-10906 ----
  {
    const ws = await runner.createWorkspace(
      await buildTar({ 'requirements.txt': 'jinja2==2.10\n' }),
    );
    try {
      const inst = await runner.install(ws);
      console.log(`  (pip install exit=${inst.exitCode} ${inst.durationMs}ms)`);
      record(
        'SCA / vulnerable jinja2==2.10 (python)',
        'still_vulnerable',
        await runSecurityScan(
          finding({
            cveId: 'CVE-2019-10906',
            packageName: 'jinja2',
            filePath: 'requirements.txt',
          }),
          ws,
          runner,
          {},
        ),
      );
    } finally {
      await runner.cleanup(ws).catch(() => {});
    }
  }

  // ---- no scanner can be selected -> inconclusive ----
  {
    const ws = await runner.createWorkspace(await buildTar({ 'README.md': 'hello\n' }));
    try {
      record(
        'no-scanner-matched / sparse finding',
        'inconclusive',
        await runSecurityScan(finding({}), ws, runner, {}),
      );
    } finally {
      await runner.cleanup(ws).catch(() => {});
    }
  }

  // ---- summary ----
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(72)}`);
  console.log(`STRESS TEST SUMMARY  (${pass}/${results.length} passed, ${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log('='.repeat(72));
  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(46)} ` +
        `exp=${r.expected.padEnd(16)} got=${r.got.padEnd(16)} tool=${r.tool}`,
    );
  }
  console.log('='.repeat(72));
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('STRESS TEST CRASHED:', err);
  process.exit(2);
});
