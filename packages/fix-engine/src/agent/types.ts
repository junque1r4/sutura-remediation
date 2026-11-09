import type Anthropic from '@anthropic-ai/sdk';

export type AgentToolName = 'read_file' | 'list_directory' | 'grep_code';

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface ListDirectoryInput {
  path: string;
}

export interface GrepCodeInput {
  query: string;
  path?: string;
}

/**
 * Caps mirror the dashboard's analyze flow (apps/dashboard/src/lib/agent/tools.ts).
 * Diverging would let the fix agent read 10x more text than the analyze agent
 * for no reason; both ultimately feed Sonnet 4 with the same 200k input cap.
 */
export const READ_FILE_LINE_LIMIT = 1500;
export const READ_FILE_BYTE_LIMIT = 1_000_000;
export const LIST_DIRECTORY_ENTRY_LIMIT = 200;
export const GREP_CODE_RESULT_LIMIT = 10;

const READ_FILE_TOOL: Anthropic.Tool = {
  name: 'read_file',
  description:
    'Read a file from the workspace and return its contents with line numbers prefixed. ' +
    'Pass `start_line` and `end_line` (1-based, inclusive) to fetch only a slice -- strongly preferred ' +
    'for files larger than ~200 lines. Maximum slice is ' +
    String(READ_FILE_LINE_LIMIT) +
    ' lines per call; if you need more, make additional calls. The repository is already extracted ' +
    'inside a sandbox; only provide the path relative to the repo root.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file relative to the repository root (e.g. "src/auth/session.ts").',
      },
      start_line: {
        type: 'integer',
        minimum: 1,
        description: '1-based first line to include (inclusive). Omit to start at line 1.',
      },
      end_line: {
        type: 'integer',
        minimum: 1,
        description:
          '1-based last line to include (inclusive). Omit to read to end of file (subject to the line limit).',
      },
    },
    required: ['path'],
  },
};

const LIST_DIRECTORY_TOOL: Anthropic.Tool = {
  name: 'list_directory',
  description:
    'List the entries (files and subdirectories) at a given path in the workspace. Use this to ' +
    'discover sibling files (tests, related modules) before reading them. Returns up to ' +
    String(LIST_DIRECTORY_ENTRY_LIMIT) +
    ' entries.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Directory path relative to the repository root. Use "." or "" for the repository root.',
      },
    },
    required: ['path'],
  },
};

const GREP_CODE_TOOL: Anthropic.Tool = {
  name: 'grep_code',
  description:
    'Search the workspace for a string or symbol. Useful for finding call sites, definitions, or ' +
    'other usages of a function/class/identifier. Matching is literal (no regex); results are capped ' +
    'at ' +
    String(GREP_CODE_RESULT_LIMIT) +
    '. If the search returns nothing useful, fall back to `list_directory` + `read_file`.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The text or identifier to search for (e.g. "verifyToken", "rawQuery(").',
      },
      path: {
        type: 'string',
        description:
          'Optional path filter to narrow the search to a subdirectory (e.g. "src/auth").',
      },
    },
    required: ['query'],
  },
};

export const FIX_AGENT_TOOLS: Anthropic.Tool[] = [
  READ_FILE_TOOL,
  LIST_DIRECTORY_TOOL,
  GREP_CODE_TOOL,
];
