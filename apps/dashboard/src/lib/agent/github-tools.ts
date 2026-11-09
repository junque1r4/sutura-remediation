import { getInstallationToken, githubApiFetch } from '@/lib/github';
import { createCodeSearchLimiter, dispatchCodeSearch } from './code-search-limiter';
import {
  GREP_CODE_RESULT_LIMIT,
  LIST_DIRECTORY_ENTRY_LIMIT,
  READ_FILE_BYTE_LIMIT,
  READ_FILE_LINE_LIMIT,
  type AgentToolName,
  type GrepCodeInput,
  type ListDirectoryInput,
  type ReadFileInput,
} from './tools';

export interface ToolContext {
  installationId: number;
  owner: string;
  repo: string;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  summary: string;
  failureClass?: 'too_large';
}

// ---------------------------------------------------------------------------
// GitHub Contents / Search response shapes (only the fields we use)
// ---------------------------------------------------------------------------

interface GhFileContent {
  type: 'file';
  encoding: 'base64' | string;
  size: number;
  content: string;
  sha: string;
  path: string;
}

interface GhDirEntry {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  size: number;
}

interface GhCodeSearchTextMatch {
  fragment: string;
  matches?: { text: string; indices: [number, number] }[];
}

interface GhCodeSearchItem {
  path: string;
  name: string;
  html_url: string;
  text_matches?: GhCodeSearchTextMatch[];
}

interface GhCodeSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GhCodeSearchItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function normalizeDirPath(input: string): string {
  const trimmed = (input ?? '').trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '/') return '';
  return trimmed.replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

function normalizeFilePath(input: string): string {
  return (input ?? '').trim().replace(/^\.?\/+/, '');
}

function err(message: string): ToolResult {
  return { ok: false, content: message, summary: message };
}

type GithubEndpointKind = 'contents' | 'search';

function describeGithubError(
  e: unknown,
  fallback: string,
  endpointKind: GithubEndpointKind = 'contents',
): string {
  const msg = e instanceof Error ? e.message : String(e);
  // githubApiFetch throws "GitHub API error: <status> <body>"
  if (msg.includes('404')) return `${fallback}: not found`;
  if (msg.includes('403')) {
    if (endpointKind === 'search') {
      return `${fallback}: GitHub code search rejected this query — likely rate limit, common-token rejection, or query too short. Try a more specific query.`;
    }
    return `${fallback}: access denied (the GitHub App lacks Contents:Read on this repo)`;
  }
  if (msg.includes('422')) return `${fallback}: invalid request`;
  return `${fallback}: ${msg}`;
}

// Shared across the whole process: GitHub's code-search budget (~10 req/min)
// is per token, not per analysis, so every search serialises through one
// limiter. A 403 gets one retry after the rate window (see dispatchCodeSearch).
const codeSearchLimiter = createCodeSearchLimiter();

async function searchCodeWithMatches(
  qualifiedQuery: string,
  installationId: number,
): Promise<GhCodeSearchResponse> {
  const token = await getInstallationToken(installationId);
  const doFetch = () =>
    fetch(
      `https://api.github.com/search/code?q=${encodeURIComponent(qualifiedQuery)}&per_page=${GREP_CODE_RESULT_LIMIT}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.text-match+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sutura-app',
        },
      },
    );
  const response = await dispatchCodeSearch(doFetch, codeSearchLimiter);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${body}`);
  }
  return (await response.json()) as GhCodeSearchResponse;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function readFile(input: ReadFileInput, ctx: ToolContext): Promise<ToolResult> {
  if (typeof input?.path !== 'string' || input.path.length === 0) {
    return err('read_file: `path` is required (string, relative to repo root).');
  }
  const path = normalizeFilePath(input.path);

  const start = input.start_line;
  const end = input.end_line;
  if (start !== undefined && (!Number.isInteger(start) || start < 1)) {
    return err('read_file: `start_line` must be a positive integer.');
  }
  if (end !== undefined && (!Number.isInteger(end) || end < 1)) {
    return err('read_file: `end_line` must be a positive integer.');
  }
  if (start !== undefined && end !== undefined && end < start) {
    return err('read_file: `end_line` must be greater than or equal to `start_line`.');
  }

  let resp: GhFileContent | GhDirEntry[];
  try {
    resp = await githubApiFetch<GhFileContent | GhDirEntry[]>(
      `/repos/${ctx.owner}/${ctx.repo}/contents/${encodeRepoPath(path)}`,
      ctx.installationId,
    );
  } catch (e) {
    return err(describeGithubError(e, `read_file ${path}`, 'contents'));
  }

  if (Array.isArray(resp)) {
    return err(`read_file: \`${path}\` is a directory, not a file. Use list_directory instead.`);
  }
  if (resp.type !== 'file') {
    return err(`read_file: \`${path}\` is not a regular file (type: ${resp.type}).`);
  }
  if (resp.encoding !== 'base64') {
    return err(`read_file: unexpected encoding \`${resp.encoding}\` for ${path}.`);
  }
  if (resp.size > READ_FILE_BYTE_LIMIT) {
    const message =
      `read_file: \`${path}\` is ${resp.size} bytes (over the ${READ_FILE_BYTE_LIMIT} byte cap). ` +
      'This file is too large to read at all — slicing with start_line/end_line will not work either. ' +
      'Do not retry this file; rely on the pre-fetched context in the initial message.';
    return { ok: false, content: message, summary: message, failureClass: 'too_large' };
  }

  const decoded = Buffer.from(resp.content, 'base64').toString('utf-8');
  const allLines = decoded.split('\n');
  // Preserve trailing newline behavior: split adds a trailing empty for files ending in \n.
  const totalLines = allLines.length === 0 ? 0 : allLines[allLines.length - 1] === '' ? allLines.length - 1 : allLines.length;

  const sliceStart = start ?? 1;
  const sliceEnd = Math.min(end ?? totalLines, totalLines);
  if (sliceStart > totalLines) {
    return err(
      `read_file: \`start_line\` ${sliceStart} is past end of file (${totalLines} lines).`,
    );
  }
  const span = sliceEnd - sliceStart + 1;
  if (span > READ_FILE_LINE_LIMIT) {
    return err(
      `read_file: requested ${span} lines from ${path}, limit is ${READ_FILE_LINE_LIMIT}. ` +
        'Narrow the range and call again.',
    );
  }

  const slice = allLines.slice(sliceStart - 1, sliceEnd);
  const width = String(sliceEnd).length;
  const numbered = slice
    .map((line, i) => {
      const lineno = String(sliceStart + i).padStart(width, ' ');
      return `${lineno} | ${line}`;
    })
    .join('\n');

  const header =
    sliceStart === 1 && sliceEnd === totalLines
      ? `# ${path} (${totalLines} lines)`
      : `# ${path} (lines ${sliceStart}-${sliceEnd} of ${totalLines})`;

  return {
    ok: true,
    content: `${header}\n${numbered}`,
    summary:
      sliceStart === 1 && sliceEnd === totalLines
        ? `read_file ${path} (${totalLines} lines)`
        : `read_file ${path}:${sliceStart}-${sliceEnd}`,
  };
}

async function listDirectory(input: ListDirectoryInput, ctx: ToolContext): Promise<ToolResult> {
  if (typeof input?.path !== 'string') {
    return err('list_directory: `path` is required (use "" or "." for the repo root).');
  }
  const path = normalizeDirPath(input.path);

  let resp: GhFileContent | GhDirEntry[];
  try {
    resp = await githubApiFetch<GhFileContent | GhDirEntry[]>(
      `/repos/${ctx.owner}/${ctx.repo}/contents/${encodeRepoPath(path)}`,
      ctx.installationId,
    );
  } catch (e) {
    return err(describeGithubError(e, `list_directory ${path || '/'}`, 'contents'));
  }

  if (!Array.isArray(resp)) {
    return err(
      `list_directory: \`${path || '/'}\` is a file, not a directory. Use read_file instead.`,
    );
  }

  const entries = resp.slice(0, LIST_DIRECTORY_ENTRY_LIMIT);
  const truncated = resp.length > LIST_DIRECTORY_ENTRY_LIMIT;
  const lines = entries.map((e) => {
    if (e.type === 'dir') return `${e.name}/`;
    if (e.type === 'file') return `${e.name}  (${e.size} bytes)`;
    return `${e.name}  [${e.type}]`;
  });

  const body = lines.length === 0 ? '(empty directory)' : lines.join('\n');
  const header = `# ${path || '/'} (${resp.length} entr${resp.length === 1 ? 'y' : 'ies'}${truncated ? `, showing first ${LIST_DIRECTORY_ENTRY_LIMIT}` : ''})`;

  return {
    ok: true,
    content: `${header}\n${body}`,
    summary: `list_directory ${path || '/'} (${resp.length} entries)`,
  };
}

async function grepCode(input: GrepCodeInput, ctx: ToolContext): Promise<ToolResult> {
  if (typeof input?.query !== 'string' || input.query.trim().length === 0) {
    return err('grep_code: `query` is required.');
  }
  const query = input.query.trim();
  const pathFilter = input.path ? normalizeDirPath(input.path) : '';
  const qualified = pathFilter
    ? `${query} repo:${ctx.owner}/${ctx.repo} path:${pathFilter}`
    : `${query} repo:${ctx.owner}/${ctx.repo}`;

  let resp: GhCodeSearchResponse;
  try {
    resp = await searchCodeWithMatches(qualified, ctx.installationId);
  } catch (e) {
    return err(describeGithubError(e, `grep_code "${query}"`, 'search'));
  }

  if (resp.total_count === 0 || resp.items.length === 0) {
    return {
      ok: true,
      content: `# No matches for "${query}" in ${ctx.owner}/${ctx.repo}${pathFilter ? ` under ${pathFilter}` : ''}.`,
      summary: `grep_code "${query}" (0 matches)`,
    };
  }

  const items = resp.items.slice(0, GREP_CODE_RESULT_LIMIT);
  const blocks = items.map((it) => {
    const matches = it.text_matches ?? [];
    const fragments = matches.length === 0
      ? '  (no inline match fragments returned)'
      : matches
          .slice(0, 3)
          .map((m) => m.fragment.split('\n').map((l) => `    ${l}`).join('\n'))
          .join('\n  ---\n');
    return `## ${it.path}\n${fragments}`;
  });

  const header = `# grep_code "${query}" — ${resp.total_count} total match${resp.total_count === 1 ? '' : 'es'}, showing top ${items.length}`;
  return {
    ok: true,
    content: `${header}\n\n${blocks.join('\n\n')}`,
    summary: `grep_code "${query}" (${resp.total_count} matches)`,
  };
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name as AgentToolName) {
    case 'read_file':
      return readFile((input ?? {}) as ReadFileInput, ctx);
    case 'list_directory':
      return listDirectory((input ?? {}) as ListDirectoryInput, ctx);
    case 'grep_code':
      return grepCode((input ?? {}) as GrepCodeInput, ctx);
    default:
      return err(`Unknown tool \`${name}\`. Available: read_file, list_directory, grep_code.`);
  }
}
