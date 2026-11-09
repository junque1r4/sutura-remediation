import { describe, expect, it, vi } from 'vitest';
import { ensureSandboxImagesPulled } from '../image-prep';

const listImages = vi.fn();

vi.mock('dockerode', () => {
  return {
    default: class MockDocker {
      listImages = listImages;
    },
  };
});

function withTags(tags: string[]) {
  listImages.mockResolvedValue(tags.map((t) => ({ RepoTags: [t] })));
}

describe('ensureSandboxImagesPulled', () => {
  it('reports required images missing when absent', async () => {
    withTags(['sutura/sandbox-base:latest']);
    const res = await ensureSandboxImagesPulled({ socketPath: '/dev/null' });
    expect(res.missingRequired).toEqual([
      'sutura/sandbox-node:latest',
      'sutura/sandbox-python:latest',
    ]);
    expect(res.present).toContain('sutura/sandbox-base:latest');
  });

  it('reports java missing as optional when absent', async () => {
    withTags([
      'sutura/sandbox-base:latest',
      'sutura/sandbox-node:latest',
      'sutura/sandbox-python:latest',
    ]);
    const res = await ensureSandboxImagesPulled({ socketPath: '/dev/null' });
    expect(res.missingOptional).toEqual(['sutura/sandbox-java:latest']);
  });

  it('does not report go/ruby: no Dockerfiles ship for them, so the warning is unactionable', async () => {
    withTags([
      'sutura/sandbox-base:latest',
      'sutura/sandbox-node:latest',
      'sutura/sandbox-python:latest',
      'sutura/sandbox-java:latest',
    ]);
    const res = await ensureSandboxImagesPulled({ socketPath: '/dev/null' });
    expect(res.missingRequired).toEqual([]);
    expect(res.missingOptional).toEqual([]);
  });

  it('tolerates images with no RepoTags', async () => {
    listImages.mockResolvedValue([{ RepoTags: undefined }, { RepoTags: ['x:y'] }]);
    const res = await ensureSandboxImagesPulled({ socketPath: '/dev/null' });
    expect(res.missingRequired).toHaveLength(3);
  });
});
