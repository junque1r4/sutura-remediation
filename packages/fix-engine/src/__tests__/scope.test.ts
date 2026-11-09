import { describe, it, expect, vi } from 'vitest';
import { resolveProjectScope } from '../pipeline/validated/scope';

function makeRunner(stdout: string) {
  return {
    exec: vi.fn(async () => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, command: 'walk' })),
  } as never;
}

const WS = { id: 'ws', image: 'img', rootPath: '/work' } as never;

describe('resolveProjectScope', () => {
  it('returns null (no exec) when filePath is undefined', async () => {
    const runner = makeRunner('');
    const out = await resolveProjectScope(runner, WS, undefined);
    expect(out).toBeNull();
    expect((runner as { exec: ReturnType<typeof vi.fn> }).exec).not.toHaveBeenCalled();
  });

  it('returns the workspace-absolute project dir when a sub-project encloses the file', async () => {
    const runner = makeRunner('ExampleApp.Security\n');
    const out = await resolveProjectScope(runner, WS, 'ExampleApp.Security/Encryption/Engine.cs');
    expect(out).toBe('/work/ExampleApp.Security');
  });

  it('passes the normalized relative path to the walk and runs from /work, air-gapped', async () => {
    const runner = makeRunner('ExampleApp.Security\n');
    await resolveProjectScope(runner, WS, './ExampleApp.Security/Encryption/Engine.cs');
    const call = (runner as { exec: ReturnType<typeof vi.fn> }).exec.mock.calls[0];
    // exec(ws, argv, timeoutMs, opts); argv = ['sh','-c', script, 'scope', relPath]
    expect(call[1][4]).toBe('ExampleApp.Security/Encryption/Engine.cs');
    const opts = call[3];
    expect(opts.cwd).toBe('/work');
    expect(opts.isolateNetwork).toBe(true);
  });

  it('returns null when the only manifest is at the repo root (walk prints nothing)', async () => {
    const runner = makeRunner('');
    const out = await resolveProjectScope(runner, WS, 'src/index.js');
    expect(out).toBeNull();
  });

  it('returns null on a "." result (root)', async () => {
    const runner = makeRunner('.\n');
    const out = await resolveProjectScope(runner, WS, 'Program.cs');
    expect(out).toBeNull();
  });

  it('declines to scope (null) when exec throws', async () => {
    const runner = {
      exec: vi.fn(async () => {
        throw new Error('container gone');
      }),
    } as never;
    const out = await resolveProjectScope(runner, WS, 'a/b/c.cs');
    expect(out).toBeNull();
  });
});
