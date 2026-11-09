import { describe, expect, it, vi } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';
import { AIKIDO_UNAVAILABLE, runAikidoLocal } from '../scanners/aikido-local';
import type { RunResult, SandboxRunner, WorkspaceHandle } from '../types';

const ws: WorkspaceHandle = { id: 'wkspc', image: 'sutura/sandbox-base:latest', rootPath: '/work' };

const baseFinding: NormalizedFinding = {
  externalId: 'ext-1',
  scanner: 'aikido',
  title: 'Vulnerable lodash',
  description: '',
  severity: 'high',
  repo: 'acme/widget',
  rawPayload: {},
};

function ok(stdout: string): RunResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, command: 'mock' };
}

function makeRunner(execImpls: Array<(cmd: string[]) => RunResult>): SandboxRunner {
  let callIdx = 0;
  const exec = vi.fn(async (_ws: WorkspaceHandle, cmd: string[]) => {
    const impl = execImpls[callIdx++] ?? (() => ok(''));
    return impl(cmd);
  });
  return {
    createWorkspace: vi.fn(),
    detectToolchain: vi.fn(),
    applyPatch: vi.fn(),
    writeFiles: vi.fn(),
    readFile: vi.fn(),
    install: vi.fn(),
    runTests: vi.fn(),
    cleanup: vi.fn(),
    exec,
  } as unknown as SandboxRunner;
}

describe('runAikidoLocal', () => {
  it('returns AIKIDO_UNAVAILABLE when CLI is not in the image', async () => {
    const runner = makeRunner([() => ok('')]); // probe returns empty -> no bin
    const res = await runAikidoLocal({
      finding: baseFinding,
      ws,
      runner,
      apiKey: 'cid:secret',
    });
    expect(res.verdict).toBe('inconclusive');
    expect(res.tool).toBe(AIKIDO_UNAVAILABLE);
  });

  it('marks verdict resolved when the report contains no matching issues', async () => {
    const runner = makeRunner([
      () => ok('/usr/local/bin/aikido\n'),
      () => ok(JSON.stringify({ issues: [{ id: 'X', cve_id: 'CVE-9999-0000' }] })),
    ]);
    const finding = { ...baseFinding, cveId: 'CVE-2023-1234', packageName: 'lodash' };
    const res = await runAikidoLocal({ finding, ws, runner, apiKey: 'cid:secret' });
    expect(res.tool).toBe('aikido-local');
    expect(res.verdict).toBe('resolved');
    expect(res.matched).toEqual([]);
  });

  it('marks verdict still_vulnerable when the same CVE is reported', async () => {
    const runner = makeRunner([
      () => ok('/usr/local/bin/aikido\n'),
      () =>
        ok(
          JSON.stringify({
            issues: [{ id: 'aikido-7', cve_id: 'CVE-2023-1234', affected_package: 'lodash' }],
          }),
        ),
    ]);
    const finding = { ...baseFinding, cveId: 'CVE-2023-1234', packageName: 'lodash' };
    const res = await runAikidoLocal({ finding, ws, runner, apiKey: 'cid:secret' });
    expect(res.verdict).toBe('still_vulnerable');
    expect(res.matched).toContain('aikido-7');
  });

  it('matches by CWE for SAST findings', async () => {
    const runner = makeRunner([
      () => ok('/usr/local/bin/aikido-cli\n'),
      () =>
        ok(
          JSON.stringify({
            findings: [{ id: 'rule-22', cwe: 'CWE-79', affected_file: 'src/render.ts' }],
          }),
        ),
    ]);
    const finding = { ...baseFinding, cweId: 'CWE-79', filePath: 'src/render.ts' };
    const res = await runAikidoLocal({ finding, ws, runner, apiKey: 'cid:secret' });
    expect(res.verdict).toBe('still_vulnerable');
    expect(res.matched).toContain('rule-22');
  });

  it('returns inconclusive when JSON cannot be parsed', async () => {
    const runner = makeRunner([
      () => ok('/usr/local/bin/aikido\n'),
      () => ok('not json at all'),
    ]);
    const res = await runAikidoLocal({ finding: baseFinding, ws, runner, apiKey: 'cid:secret' });
    expect(res.verdict).toBe('inconclusive');
    expect(res.tool).toBe('aikido-local');
  });
});
