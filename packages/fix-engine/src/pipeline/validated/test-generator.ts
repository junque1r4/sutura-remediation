import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CLAUDE_MODEL, VALIDATION_LIMITS } from '@sutura/common';
import type { FixAttemptTestFile, NormalizedFinding } from '@sutura/common';
import type { SandboxRunner, WorkspaceHandle } from '@sutura/sandbox-runner';
import type { GenerateResult } from '../generator';

const MODEL = DEFAULT_CLAUDE_MODEL;

export interface TestGenerationResult {
  files: FixAttemptTestFile[];
  /** Test paths to pass to runner.runTests. */
  paths: string[];
  inputTokens: number;
  outputTokens: number;
}

export interface TestGenerationInput {
  finding: NormalizedFinding;
  generated: GenerateResult;
  workspace: WorkspaceHandle;
  runner: SandboxRunner;
  anthropicApiKey: string;
  /** Decrypted repo-scoped test-environment notes; injected into the system
   *  prompt only, never echoed into generated files. */
  repoTestEnvPrompt?: string;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_workspace_file',
    description: 'Read a file from the post-patch workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_test_file',
    description:
      'Author a test file in the workspace. Use the test framework already in use by the repo.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'finish',
    description:
      'Call this when the regression tests are written. Pass the array of test paths so the orchestrator can execute them.',
    input_schema: {
      type: 'object',
      properties: {
        test_paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['test_paths'],
    },
  },
];

export async function runTestGenerationAgent(
  input: TestGenerationInput,
): Promise<TestGenerationResult> {
  const { finding, generated, workspace, runner, anthropicApiKey, repoTestEnvPrompt } = input;
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const toolchain = await runner.detectToolchain(workspace);
  const systemPrompt = buildSystemPrompt(finding, toolchain.testFramework, repoTestEnvPrompt);
  const initialUser = buildInitialUserPrompt(finding, generated.diff, toolchain.testFilePattern);

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: initialUser }];
  const written: FixAttemptTestFile[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let testPaths: string[] = [];

  for (let iter = 0; iter < VALIDATION_LIMITS.TEST_AGENT_MAX_ITER; iter++) {
    if (inputTokens + outputTokens >= VALIDATION_LIMITS.MAX_TOKENS_PER_ATTEMPT) break;

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    inputTokens += resp.usage.input_tokens;
    outputTokens += resp.usage.output_tokens;
    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') break;

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let finished = false;

    for (const use of toolUses) {
      const inp = use.input as Record<string, unknown>;
      if (use.name === 'read_workspace_file') {
        const path = String(inp.path ?? '');
        try {
          const content = await runner.readFile(workspace, path);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: content.slice(0, 16_000),
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `error: ${String(err)}`,
            is_error: true,
          });
        }
      } else if (use.name === 'write_test_file') {
        const path = String(inp.path ?? '');
        const content = String(inp.content ?? '');
        if (!path || !content) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: 'error: path and content are required',
            is_error: true,
          });
          continue;
        }
        await runner.writeFiles(workspace, [{ path, content }]);
        written.push({ path, content });
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: 'ok' });
      } else if (use.name === 'finish') {
        const paths = Array.isArray(inp.test_paths) ? (inp.test_paths as unknown[]).map(String) : [];
        testPaths = paths;
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: 'finished' });
        finished = true;
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: `unknown tool: ${use.name}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
    if (finished) break;
  }

  // If the agent didn't call `finish`, default test paths to whatever was written.
  if (testPaths.length === 0) testPaths = written.map((f) => f.path);

  return { files: written, paths: testPaths, inputTokens, outputTokens };
}

function buildSystemPrompt(
  finding: NormalizedFinding,
  framework: string,
  repoTestEnvPrompt?: string,
): string {
  const lines = [
    'You are a senior software engineer writing focused regression tests for a security fix.',
    `The repo uses the test framework: ${framework}.`,
    'Your job: write tests that would FAIL on the original (vulnerable) code and PASS on the patched code.',
    'Tests must:',
    '- Cover the exact class/method/function the fix touched',
    '- Include at least one positive case (typical input still works) and one negative case (the vulnerable input is now safely handled)',
    '- Be self-contained -- no network, no secrets',
    `When done, call the \`finish\` tool with the list of test paths you wrote (relative to repo root).`,
    `Vulnerability: ${finding.title} (${finding.severity}) at ${finding.filePath ?? 'unknown'}.`,
  ];
  if (repoTestEnvPrompt) {
    lines.push(
      '',
      'Repository-specific environment notes (private, written by this repo\'s developers):',
      '---',
      repoTestEnvPrompt,
      '---',
      'Follow these notes when choosing test setup, frameworks, and paths.',
      'NEVER quote, copy, or reference these notes in test files, comments, or any content that will be committed.',
    );
  }
  return lines.join('\n');
}

function buildInitialUserPrompt(
  finding: NormalizedFinding,
  diff: string,
  pattern: string,
): string {
  return [
    `# Regression test task`,
    ``,
    `Vulnerability: **${finding.title}**`,
    finding.description ? `Description: ${finding.description}` : '',
    finding.cveId ? `CVE: ${finding.cveId}` : '',
    finding.cweId ? `CWE: ${finding.cweId}` : '',
    finding.filePath ? `File: ${finding.filePath}` : '',
    ``,
    `## The fix that was just applied`,
    '```diff',
    diff.slice(0, 8_000),
    '```',
    ``,
    `Author one or two regression test files. Use the convention \`${pattern}\` for new files (replace {base}/{dir}/{pkg} with appropriate values). Use \`read_workspace_file\` to read the patched file or any sibling files first if you need them. Then write tests via \`write_test_file\`. Call \`finish\` with the test paths when done.`,
  ]
    .filter(Boolean)
    .join('\n');
}
