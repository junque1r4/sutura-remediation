import { describe, it, expect, vi } from 'vitest';
import type { RunResult, SandboxRunner, WorkspaceHandle } from '@sutura/sandbox-runner';
import { dispatchSandboxTool, type SandboxToolContext } from '../sandbox-tools';

/**
 * The agent's read_file / list_directory / grep_code tools interpolate
 * LLM-supplied paths and queries into `sh -lc` commands run inside the sandbox.
 * That is the real injection surface (the model controls these strings). These
 * tests lock that every such input is shell-escaped before it reaches exec, so
 * a malicious path/query cannot break out of the quoted argument. We capture the
 * exact command strings handed to a stubbed runner.exec.
 */
function ok(stdout: string): RunResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, command: 'mock' };
}

const ws: WorkspaceHandle = { id: 'cid', image: 'sutura/sandbox-base:latest', rootPath: '/work' };

function ctxCapturing(): { ctx: SandboxToolContext; bodies: () => string[] } {
  const cmds: string[][] = [];
  const exec = vi.fn(async (_ws: WorkspaceHandle, cmd: string[]) => {
    cmds.push(cmd);
    // stat probe -> a small size; sed/ls/grep -> some content. Always exit 0.
    return ok('10');
  });
  const runner = { exec } as unknown as SandboxRunner;
  // The `sh -lc` body is the third element of each exec'd argv.
  return { ctx: { runner, workspace: ws }, bodies: () => cmds.map((c) => c[2]) };
}

describe('sandbox tools shell-escape agent-controlled input', () => {
  it('read_file escapes a quote-breakout path', async () => {
    const { ctx, bodies } = ctxCapturing();
    await dispatchSandboxTool('read_file', { path: `secret'.txt;id` }, ctx);
    // shellEscape(`secret'.txt;id`) === `'secret'\''.txt;id'`. Every command the
    // tool issues (the stat probe and the read) must carry the escaped form.
    expect(bodies().length).toBeGreaterThan(0);
    expect(bodies().every((b) => b.includes(`'secret'\\''.txt;id'`))).toBe(true);
  });

  it('list_directory escapes a quote-breakout path', async () => {
    const { ctx, bodies } = ctxCapturing();
    // No trailing slash: normalizeDirPath strips trailing slashes before escaping.
    await dispatchSandboxTool('list_directory', { path: `dir';ls -la` }, ctx);
    // shellEscape(`dir';ls -la`) === `'dir'\'';ls -la'`
    expect(bodies()[0]).toContain(`'dir'\\'';ls -la'`);
  });

  it('grep_code escapes both the query and the path', async () => {
    const { ctx, bodies } = ctxCapturing();
    await dispatchSandboxTool('grep_code', { query: `q';id`, path: `p';ls` }, ctx);
    const body = bodies()[0];
    expect(body).toContain(`'q'\\'';id'`); // escaped query
    expect(body).toContain(`'p'\\'';ls'`); // escaped path
  });

  it('grep_code escapes a command-substitution query', async () => {
    const { ctx, bodies } = ctxCapturing();
    await dispatchSandboxTool('grep_code', { query: '$(id)' }, ctx);
    expect(bodies()[0]).toContain(`'$(id)'`);
  });
});
