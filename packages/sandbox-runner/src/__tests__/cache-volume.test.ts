import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar-stream';
import {
  cacheVolumeName,
  manifestHash,
  ensureCacheVolume,
  removeCacheVolume,
  listCacheVolumes,
  getCacheVolumeManifest,
  recreateCacheVolume,
  manifestFingerprintFromTar,
  gcCacheVolumes,
  CACHE_VOLUME_PREFIX,
  CACHE_MANIFEST_LABEL,
} from '../cache-volume';

/** Build a minimal uncompressed tar buffer from a {name: content} map. */
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

const ORG = '00000000-0000-0000-0000-000000000001';

describe('cacheVolumeName', () => {
  it('is deterministic and prefixed', () => {
    const n = cacheVolumeName(ORG, 'example-org/ExampleApp.BackEndAPI');
    expect(n).toMatch(new RegExp(`^${CACHE_VOLUME_PREFIX}[a-f0-9]{12}$`));
    expect(cacheVolumeName(ORG, 'example-org/ExampleApp.BackEndAPI')).toBe(n);
  });

  it('differs by org and by repo', () => {
    expect(cacheVolumeName(ORG, 'a/b')).not.toBe(cacheVolumeName(ORG, 'a/c'));
    expect(cacheVolumeName(ORG, 'a/b')).not.toBe(
      cacheVolumeName('00000000-0000-0000-0000-000000000002', 'a/b'),
    );
  });
});

describe('manifestHash', () => {
  it('changes when a lockfile changes and is order-independent', () => {
    expect(manifestHash({ 'packages.lock.json': 'a' })).not.toBe(
      manifestHash({ 'packages.lock.json': 'b' }),
    );
    expect(manifestHash({ a: '1', b: '2' })).toBe(manifestHash({ b: '2', a: '1' }));
  });

  it('treats absent (null) manifests as empty', () => {
    expect(manifestHash({ 'go.mod': null })).toBe(manifestHash({}));
  });
});

describe('volume lifecycle', () => {
  it('ensureCacheVolume creates the named volume', async () => {
    const createVolume = vi.fn(async () => ({}));
    const docker = { createVolume } as never;
    await ensureCacheVolume(docker, 'sutura-cache-abc');
    expect(createVolume).toHaveBeenCalledWith({
      Name: 'sutura-cache-abc',
      Labels: { 'sutura.cache': 'true' },
    });
  });

  it('listCacheVolumes returns only sutura-cache-* names', async () => {
    const listVolumes = vi.fn(async () => ({
      Volumes: [{ Name: 'sutura-cache-aaa' }, { Name: 'other' }, { Name: 'sutura-cache-bbb' }],
    }));
    const docker = { listVolumes } as never;
    expect(await listCacheVolumes(docker)).toEqual(['sutura-cache-aaa', 'sutura-cache-bbb']);
  });

  it('removeCacheVolume forces removal and swallows missing-volume errors', async () => {
    const remove = vi.fn(async () => {
      throw new Error('no such volume');
    });
    const docker = { getVolume: vi.fn(() => ({ remove })) } as never;
    await expect(removeCacheVolume(docker, 'sutura-cache-zzz')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith({ force: true });
  });

  it('ensureCacheVolume stamps the manifest label when given a fingerprint', async () => {
    const createVolume = vi.fn(async () => ({}));
    const docker = { createVolume } as never;
    await ensureCacheVolume(docker, 'sutura-cache-abc', 'deadbeef');
    expect(createVolume).toHaveBeenCalledWith({
      Name: 'sutura-cache-abc',
      Labels: { 'sutura.cache': 'true', [CACHE_MANIFEST_LABEL]: 'deadbeef' },
    });
  });

  it('getCacheVolumeManifest returns the stored fingerprint, or null when absent', async () => {
    const inspect = vi.fn(async () => ({ Labels: { [CACHE_MANIFEST_LABEL]: 'cafe' } }));
    const docker = { getVolume: vi.fn(() => ({ inspect })) } as never;
    expect(await getCacheVolumeManifest(docker, 'sutura-cache-abc')).toBe('cafe');

    const noLabel = { getVolume: vi.fn(() => ({ inspect: vi.fn(async () => ({ Labels: {} })) })) } as never;
    expect(await getCacheVolumeManifest(noLabel, 'sutura-cache-abc')).toBeNull();
  });

  it('getCacheVolumeManifest returns null when the volume does not exist', async () => {
    const inspect = vi.fn(async () => {
      throw new Error('no such volume');
    });
    const docker = { getVolume: vi.fn(() => ({ inspect })) } as never;
    expect(await getCacheVolumeManifest(docker, 'sutura-cache-missing')).toBeNull();
  });

  it('recreateCacheVolume removes the stale volume then creates it with the new label', async () => {
    const calls: string[] = [];
    const remove = vi.fn(async () => {
      calls.push('remove');
    });
    const createVolume = vi.fn(async () => {
      calls.push('create');
    });
    const docker = { getVolume: vi.fn(() => ({ remove })), createVolume } as never;
    await recreateCacheVolume(docker, 'sutura-cache-abc', 'newhash');
    expect(calls).toEqual(['remove', 'create']);
    expect(createVolume).toHaveBeenCalledWith({
      Name: 'sutura-cache-abc',
      Labels: { 'sutura.cache': 'true', [CACHE_MANIFEST_LABEL]: 'newhash' },
    });
  });
});

describe('gcCacheVolumes', () => {
  const NOW = 1_000_000_000_000;
  const DAY = 24 * 60 * 60_000;

  function dockerWith(volumes: Array<{ Name: string; CreatedAt?: string }>) {
    const removed: string[] = [];
    const docker = {
      listVolumes: vi.fn(async () => ({ Volumes: volumes })),
      getVolume: vi.fn((name: string) => ({
        inspect: vi.fn(async () => volumes.find((v) => v.Name === name) ?? {}),
        remove: vi.fn(async () => {
          removed.push(name);
        }),
      })),
    } as never;
    return { docker, removed };
  }

  it('removes only cache volumes older than the TTL', async () => {
    const { docker } = dockerWith([
      { Name: 'sutura-cache-old', CreatedAt: new Date(NOW - 20 * DAY).toISOString() },
      { Name: 'sutura-cache-new', CreatedAt: new Date(NOW - 1 * DAY).toISOString() },
      { Name: 'unrelated', CreatedAt: new Date(NOW - 99 * DAY).toISOString() },
    ]);
    const removed = await gcCacheVolumes(docker, 14 * DAY, NOW);
    expect(removed).toEqual(['sutura-cache-old']);
  });

  it('is a no-op when the TTL is zero or negative (GC disabled)', async () => {
    const { docker } = dockerWith([
      { Name: 'sutura-cache-old', CreatedAt: new Date(NOW - 99 * DAY).toISOString() },
    ]);
    expect(await gcCacheVolumes(docker, 0, NOW)).toEqual([]);
  });
});

describe('manifestFingerprintFromTar', () => {
  it('hashes top-level dependency manifests and changes when one changes', async () => {
    const a = await manifestFingerprintFromTar(
      await makeTar({ 'package.json': '{"name":"a"}', 'src/index.ts': 'x' }),
    );
    const b = await manifestFingerprintFromTar(
      await makeTar({ 'package.json': '{"name":"b"}', 'src/index.ts': 'x' }),
    );
    expect(a).not.toBe(b);
  });

  it('ignores non-manifest files (source changes do not bust the cache)', async () => {
    const a = await manifestFingerprintFromTar(
      await makeTar({ 'package.json': '{"name":"a"}', 'src/index.ts': 'one' }),
    );
    const b = await manifestFingerprintFromTar(
      await makeTar({ 'package.json': '{"name":"a"}', 'src/index.ts': 'two' }),
    );
    expect(a).toBe(b);
  });

  it('gunzips a gzipped tarball (GitHub returns tar.gz)', async () => {
    const plain = await makeTar({ 'package.json': '{"name":"a"}' });
    const gz = gzipSync(plain);
    // Same content, gzipped vs not, must produce the SAME fingerprint -- and not throw.
    expect(await manifestFingerprintFromTar(gz)).toBe(await manifestFingerprintFromTar(plain));
  });
});
