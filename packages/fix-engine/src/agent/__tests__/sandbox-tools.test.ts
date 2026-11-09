import { describe, expect, it, vi } from 'vitest';
import type { SandboxRunner, WorkspaceHandle, RunResult } from '@sutura/sandbox-runner';
import { dispatchSandboxTool } from '../sandbox-tools';

const ws: WorkspaceHandle = { id: 'ws-1', image: 'sandbox-base', rootPath: '/work' };

function makeRunner(execHandler: (cmd: string[]) => RunResult): SandboxRunner {
  return {
    createWorkspace: vi.fn(),
    detectToolchain: vi.fn(),
    applyPatch: vi.fn(),
    writeFiles: vi.fn(),
    readFile: vi.fn(),
    install: vi.fn(),
    runTests: vi.fn(),
    cleanup: vi.fn(),
    exec: vi.fn(async (_w: WorkspaceHandle, cmd: string[]) => execHandler(cmd)),
  } as unknown as SandboxRunner;
}

const ok = (stdout: string, exitCode = 0): RunResult => ({
  exitCode,
  stdout,
  stderr: '',
  durationMs: 1,
  timedOut: false,
  command: 'mock',
});

describe('dispatchSandboxTool', () => {
  it('read_file rejects empty path', async () => {
    const runner = makeRunner(() => ok(''));
    const r = await dispatchSandboxTool('read_file', { path: '' }, { runner, workspace: ws });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/path is required/);
  });

  it('read_file rejects path traversal', async () => {
    const runner = makeRunner(() => ok(''));
    const r = await dispatchSandboxTool(
      'read_file',
      { path: '../etc/passwd' },
      { runner, workspace: ws },
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/invalid path/);
  });

  it('read_file flags too-large files when no slice requested', async () => {
    let call = 0;
    const runner = makeRunner((cmd) => {
      call++;
      // First call: stat; return a huge size
      if (call === 1) return ok('5000000');
      return ok('unreachable');
    });
    const r = await dispatchSandboxTool(
      'read_file',
      { path: 'huge.bin' },
      { runner, workspace: ws },
    );
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('too_large');
  });

  it('read_file returns numbered slice', async () => {
    let call = 0;
    const runner = makeRunner((cmd) => {
      call++;
      if (call === 1) return ok('100');
      // sed | nl output: "1\tfirst\n2\tsecond\n"
      return ok('1\tfirst\n2\tsecond');
    });
    const r = await dispatchSandboxTool(
      'read_file',
      { path: 'src/x.ts', start_line: 10, end_line: 11 },
      { runner, workspace: ws },
    );
    expect(r.ok).toBe(true);
    // Re-prefixed with absolute line numbers (start=10)
    expect(r.content.split('\n')).toEqual(['10\tfirst', '11\tsecond']);
  });

  it('read_file strips the leading UTF-8 BOM from line 1 only', async () => {
    let call = 0;
    const runner = makeRunner((cmd) => {
      call++;
      if (call === 1) return ok('100');
      // sed | nl output where line 1 carries a BOM (and a later line legitimately
      // does too -- only the absolute line 1 should be stripped).
      return ok('1\t﻿using System;\n2\t﻿notline1');
    });
    const r = await dispatchSandboxTool(
      'read_file',
      { path: 'Engine.cs', start_line: 1, end_line: 2 },
      { runner, workspace: ws },
    );
    expect(r.ok).toBe(true);
    expect(r.content.split('\n')).toEqual(['1\tusing System;', '2\t﻿notline1']);
  });

  it('read_file does not strip a BOM when the slice does not start at line 1', async () => {
    let call = 0;
    const runner = makeRunner((cmd) => {
      call++;
      if (call === 1) return ok('100');
      return ok('1\t﻿midfile');
    });
    const r = await dispatchSandboxTool(
      'read_file',
      { path: 'Engine.cs', start_line: 5, end_line: 5 },
      { runner, workspace: ws },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toBe('5\t﻿midfile');
  });

  it('list_directory drops "total N" and truncates', async () => {
    const longList =
      'total 4\n' +
      Array.from({ length: 250 }, (_, i) => `-rw-r--r-- 1 root root 0 file${i}.txt`).join('\n');
    const runner = makeRunner(() => ok(longList));
    const r = await dispatchSandboxTool('list_directory', { path: '.' }, { runner, workspace: ws });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/truncated to 200 entries/);
    // Should not include the "total 4" header
    expect(r.content.startsWith('total ')).toBe(false);
  });

  it('grep_code returns empty-result message when no matches', async () => {
    const runner = makeRunner(() => ({
      exitCode: 1, // grep convention: 1 = no match
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      command: 'mock',
    }));
    const r = await dispatchSandboxTool(
      'grep_code',
      { query: 'xyzzy' },
      { runner, workspace: ws },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/no matches/);
    expect(r.summary).toMatch(/0 results/);
  });

  it('grep_code summarizes match count', async () => {
    const runner = makeRunner(() =>
      ok('src/a.ts:12:foo()\nsrc/b.ts:34:foo("x")\nsrc/c.ts:56:foo(bar)'),
    );
    const r = await dispatchSandboxTool(
      'grep_code',
      { query: 'foo(' },
      { runner, workspace: ws },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/3 results/);
  });

  it('unknown tool name returns error', async () => {
    const runner = makeRunner(() => ok(''));
    const r = await dispatchSandboxTool('mystery', {}, { runner, workspace: ws });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/unknown tool/);
  });
});
