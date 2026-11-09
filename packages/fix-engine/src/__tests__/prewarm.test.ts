import { describe, it, expect, vi } from 'vitest';
import * as tar from 'tar-stream';
import { ensureWarmCache } from '../pipeline/validated/prewarm';

const ORG = '00000000-0000-0000-0000-000000000001';
const REPO = 'acme/api';

function makeTar(files: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, content] of Object.entries(files)) pack.entry({ name }, content);
  pack.finalize();
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    pack.on('data', (c: Buffer) => chunks.push(c));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function makeRunner(over: Record<string, unknown> = {}) {
  return {
    getCacheVolumeManifest: vi.fn(async () => null),
    recreateCacheVolume: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => ({ id: 'ws', image: 'img', rootPath: '/work' })),
    restore: vi.fn(async () => ({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      command: 'restore',
    })),
    cleanup: vi.fn(async () => {}),
    ...over,
  } as never;
}

describe('ensureWarmCache', () => {
  it('rebuilds the cache and runs restore RW when no warm cache exists', async () => {
    const runner = makeRunner();
    const tarball = await makeTar({ 'package.json': '{"name":"a"}' });

    const out = await ensureWarmCache({ runner, tarball, orgId: ORG, repo: REPO });

    expect(out.ok).toBe(true);
    expect(out.rebuilt).toBe(true);
    expect((runner as { recreateCacheVolume: ReturnType<typeof vi.fn> }).recreateCacheVolume)
      .toHaveBeenCalledTimes(1);
    // The cache volume is mounted READ-WRITE only for the prewarm restore.
    const cwArg = (runner as { createWorkspace: ReturnType<typeof vi.fn> }).createWorkspace
      .mock.calls[0][1];
    expect(cwArg.cacheVolume).toBe(out.volume);
    expect(cwArg.cacheReadOnly).toBe(false);
    expect((runner as { restore: ReturnType<typeof vi.fn> }).restore).toHaveBeenCalledTimes(1);
    expect((runner as { cleanup: ReturnType<typeof vi.fn> }).cleanup).toHaveBeenCalledTimes(1);
  });

  it('reuses a warm cache (no restore) when the fingerprint matches', async () => {
    const tarball = await makeTar({ 'package.json': '{"name":"a"}' });
    // Pre-compute the fingerprint the prewarm will derive, and report it warm.
    const probe = makeRunner();
    await ensureWarmCache({ runner: probe, tarball, orgId: ORG, repo: REPO });
    const fingerprint = (probe as { recreateCacheVolume: ReturnType<typeof vi.fn> })
      .recreateCacheVolume.mock.calls[0][1];

    const runner = makeRunner({ getCacheVolumeManifest: vi.fn(async () => fingerprint) });
    const out = await ensureWarmCache({ runner, tarball, orgId: ORG, repo: REPO });

    expect(out.ok).toBe(true);
    expect(out.rebuilt).toBe(false);
    expect((runner as { recreateCacheVolume: ReturnType<typeof vi.fn> }).recreateCacheVolume)
      .not.toHaveBeenCalled();
    expect((runner as { restore: ReturnType<typeof vi.fn> }).restore).not.toHaveBeenCalled();
  });

  it('declines prewarm (ok:false, no restore) when no recognized manifest is present (e.g. .NET)', async () => {
    const runner = makeRunner();
    // A .NET solution: none of MANIFEST_FILES (package.json, requirements.txt,
    // pom.xml, ...) are present, so the manifest fingerprint is the empty set.
    const tarball = await makeTar({
      'MyApp.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'src/Program.cs': 'class P {}',
    });

    const out = await ensureWarmCache({ runner, tarball, orgId: ORG, repo: REPO });

    // Prewarm's fingerprint model can't key/invalidate a manifest-less ecosystem,
    // and forcing an offline restore from such a cache breaks .NET (SDK workload
    // verification needs network). Decline so the orchestrator uses its networked
    // clean-tree restore instead of a doomed offline one.
    expect(out.ok).toBe(false);
    expect(out.rebuilt).toBe(false);
    expect((runner as { recreateCacheVolume: ReturnType<typeof vi.fn> }).recreateCacheVolume)
      .not.toHaveBeenCalled();
    expect((runner as { restore: ReturnType<typeof vi.fn> }).restore).not.toHaveBeenCalled();
    expect((runner as { createWorkspace: ReturnType<typeof vi.fn> }).createWorkspace)
      .not.toHaveBeenCalled();
  });

  it('reports not-ok and still cleans up when the restore fails', async () => {
    const runner = makeRunner({
      restore: vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'network down',
        durationMs: 1,
        timedOut: false,
        command: 'restore',
      })),
    });
    const tarball = await makeTar({ 'package.json': '{"name":"a"}' });

    const out = await ensureWarmCache({ runner, tarball, orgId: ORG, repo: REPO });

    expect(out.ok).toBe(false);
    expect(out.rebuilt).toBe(true);
    expect(out.error).toContain('network down');
    expect((runner as { cleanup: ReturnType<typeof vi.fn> }).cleanup).toHaveBeenCalledTimes(1);
  });

  it('derives the same volume name for the same (org, repo)', async () => {
    const tarball = await makeTar({ 'package.json': '{"name":"a"}' });
    const r1 = await ensureWarmCache({ runner: makeRunner(), tarball, orgId: ORG, repo: REPO });
    const r2 = await ensureWarmCache({ runner: makeRunner(), tarball, orgId: ORG, repo: REPO });
    expect(r1.volume).toBe(r2.volume);
    expect(r1.volume).toMatch(/^sutura-cache-[a-f0-9]{12}$/);
  });
});
