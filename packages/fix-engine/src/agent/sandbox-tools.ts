import { shellEscape, type SandboxRunner, type WorkspaceHandle } from '@sutura/sandbox-runner';
import {
  GREP_CODE_RESULT_LIMIT,
  LIST_DIRECTORY_ENTRY_LIMIT,
  READ_FILE_BYTE_LIMIT,
  READ_FILE_LINE_LIMIT,
  type GrepCodeInput,
  type ListDirectoryInput,
  type ReadFileInput,
} from './types';

export interface SandboxToolContext {
  runner: SandboxRunner;
  workspace: WorkspaceHandle;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  summary: string;
  failureClass?: 'too_large';
}

const TOOL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Path normalisation -- keep loop's canonicalToolInput in lockstep
// ---------------------------------------------------------------------------

function normalizeFilePath(input: string): string {
  return (input ?? '').trim().replace(/^\.?\/+/, '');
}

function normalizeDirPath(input: string): string {
  const trimmed = (input ?? '').trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '/') return '';
  return trimmed.replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

function normalizeQuery(input: string): string {
  let s = (input ?? '').trim();
  while (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function err(message: string): ToolResult {
  return { ok: false, content: message, summary: message };
}

function rejectsTraversal(path: string): boolean {
  // Reject any segment of `..` to keep the agent confined to /work.
  return path.split('/').some((seg) => seg === '..');
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

async function readFile(input: ReadFileInput, ctx: SandboxToolContext): Promise<ToolResult> {
  const path = normalizeFilePath(input.path);
  if (!path) return err('read_file: path is required');
  if (rejectsTraversal(path)) return err(`read_file: invalid path "${path}"`);

  const start = typeof input.start_line === 'number' && input.start_line > 0 ? input.start_line : 1;
  const requestedEnd =
    typeof input.end_line === 'number' && input.end_line > 0 ? input.end_line : null;

  // Byte-cap probe first: skip the read entirely for files over the limit.
  const sizeRes = await ctx.runner.exec(
    ctx.workspace,
    ['sh', '-lc', `stat -c %s ${shellEscape(path)} 2>/dev/null || stat -f %z ${shellEscape(path)}`],
    TOOL_TIMEOUT_MS,
  );
  if (sizeRes.exitCode !== 0) {
    return err(`read_file ${path}: not found`);
  }
  const sizeBytes = parseInt(sizeRes.stdout.trim(), 10) || 0;
  if (sizeBytes > READ_FILE_BYTE_LIMIT && requestedEnd === null && start === 1) {
    return {
      ok: false,
      content:
        `read_file ${path}: file is ${sizeBytes} bytes which exceeds the ${READ_FILE_BYTE_LIMIT}-byte cap. ` +
        'Re-call with a narrow start_line/end_line slice (max ' +
        String(READ_FILE_LINE_LIMIT) +
        ' lines).',
      summary: `read_file ${path}: too large`,
      failureClass: 'too_large',
    };
  }

  // Slice via sed; cap the upper end so a single call can't return more than
  // READ_FILE_LINE_LIMIT lines even if end_line was huge.
  const cappedEnd = Math.min(requestedEnd ?? start + READ_FILE_LINE_LIMIT - 1, start + READ_FILE_LINE_LIMIT - 1);
  const sedRange = `${start},${cappedEnd}`;
  const cmd = `sed -n '${sedRange}p' ${shellEscape(path)} | nl -ba -w1 -s$'\\t'`;
  const res = await ctx.runner.exec(ctx.workspace, ['sh', '-lc', cmd], TOOL_TIMEOUT_MS);
  if (res.exitCode !== 0) {
    return err(`read_file ${path}: ${res.stderr || res.stdout || 'read failed'}`);
  }

  // `nl -ba` numbers from 1 within the sed slice; we want absolute line numbers.
  // Re-prefix manually.
  const lines = res.stdout.split('\n');
  // sed adds a trailing empty line for files that end with a newline; drop it.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const numbered = lines
    .map((l, i) => {
      // Strip the existing nl prefix (`<num>\t<text>`)
      const tab = l.indexOf('\t');
      let text = tab >= 0 ? l.slice(tab + 1) : l;
      // Hide the file's leading UTF-8 BOM (invisible byte on line 1): the model
      // can't reproduce it reliably and copies a BOM-less line into the diff,
      // breaking `git apply`. The apply path's reconcileLeadingBom repair pass
      // puts the BOM back deterministically, so the model never needs to see it.
      if (start + i === 1) text = text.replace(/^﻿/, '');
      return `${start + i}\t${text}`;
    })
    .join('\n');

  if (lines.length === 0) {
    return {
      ok: true,
      content: `(empty slice ${start}-${cappedEnd} of ${path})`,
      summary: `read_file ${path}:${start}-${cappedEnd} (empty)`,
    };
  }

  return {
    ok: true,
    content: numbered,
    summary: `read_file ${path}:${start}-${start + lines.length - 1}`,
  };
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

async function listDirectory(
  input: ListDirectoryInput,
  ctx: SandboxToolContext,
): Promise<ToolResult> {
  const path = normalizeDirPath(input.path);
  if (rejectsTraversal(path)) return err(`list_directory: invalid path "${path}"`);

  const target = path === '' ? '.' : path;
  const res = await ctx.runner.exec(
    ctx.workspace,
    [
      'sh',
      '-lc',
      `ls -laF --color=never ${shellEscape(target)} 2>/dev/null | head -n ${LIST_DIRECTORY_ENTRY_LIMIT + 1}`,
    ],
    TOOL_TIMEOUT_MS,
  );
  if (res.exitCode !== 0) {
    return err(`list_directory ${path || '/'}: not found or not a directory`);
  }

  // Drop the leading "total N" line that ls prints.
  const lines = res.stdout.split('\n').filter((l) => l && !l.startsWith('total '));
  const truncated = lines.length > LIST_DIRECTORY_ENTRY_LIMIT;
  const sliced = truncated ? lines.slice(0, LIST_DIRECTORY_ENTRY_LIMIT) : lines;

  return {
    ok: true,
    content:
      sliced.join('\n') +
      (truncated ? `\n... (truncated to ${LIST_DIRECTORY_ENTRY_LIMIT} entries)` : ''),
    summary: `list_directory ${path || '/'} (${sliced.length}${truncated ? '+' : ''} entries)`,
  };
}

// ---------------------------------------------------------------------------
// grep_code
// ---------------------------------------------------------------------------

async function grepCode(input: GrepCodeInput, ctx: SandboxToolContext): Promise<ToolResult> {
  const query = normalizeQuery(input.query);
  if (!query) return err('grep_code: query is required');

  const path = input.path !== undefined ? normalizeDirPath(input.path) : '';
  if (rejectsTraversal(path)) return err(`grep_code: invalid path "${path}"`);

  const target = path === '' ? '.' : path;
  // -F = fixed string (no regex), -n = line numbers, -r = recursive,
  // --binary-files=without-match = skip binaries, --exclude-dir to skip noise.
  const cmd =
    `grep -rnF --binary-files=without-match ` +
    `--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build ` +
    `${shellEscape(query)} ${shellEscape(target)} 2>/dev/null | head -n ${GREP_CODE_RESULT_LIMIT}`;

  const res = await ctx.runner.exec(ctx.workspace, ['sh', '-lc', cmd], TOOL_TIMEOUT_MS);
  // grep returns 1 when there are no matches; that's not an error to the agent.
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    return err(`grep_code "${query}": ${res.stderr || 'search failed'}`);
  }

  const lines = res.stdout.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) {
    return {
      ok: true,
      content: `(no matches for "${query}" under ${path || '/'})`,
      summary: `grep_code "${query}": 0 results`,
    };
  }

  return {
    ok: true,
    content: lines.join('\n'),
    summary: `grep_code "${query}": ${lines.length} result${lines.length === 1 ? '' : 's'}`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function dispatchSandboxTool(
  name: string,
  input: unknown,
  ctx: SandboxToolContext,
): Promise<ToolResult> {
  if (name === 'read_file') {
    return readFile(input as ReadFileInput, ctx);
  }
  if (name === 'list_directory') {
    return listDirectory(input as ListDirectoryInput, ctx);
  }
  if (name === 'grep_code') {
    return grepCode(input as GrepCodeInput, ctx);
  }
  return err(`unknown tool: ${name}`);
}
