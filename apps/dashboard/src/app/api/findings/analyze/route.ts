import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CLAUDE_MODEL } from '@sutura/common';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getConnectionSecret } from '@/lib/connections-client.server';
import { getInstallationFromOrg, githubApiFetch } from '@/lib/github';
import { runAnalysisAgent, callSignature, type AgentEvent } from '@/lib/agent/loop';
import { dispatchTool, type ToolContext } from '@/lib/agent/github-tools';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface AnalyzeRequest {
  title: string;
  description: string | null;
  severity: string;
  cveId: string | null;
  cweId: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  filePath: string | null;
  lineRange: [number, number] | null;
  repo: string;
  scannerSource: string;
  findingId?: string | null;
  packageName?: string | null;
  currentVersion?: string | null;
  fixedVersion?: string | null;
  rawPayload?: Record<string, unknown> | null;
}

const LOCKFILE_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Pipfile\.lock|go\.sum|Gemfile\.lock|Cargo\.lock)$/;

function isScaFinding(f: AnalyzeRequest): boolean {
  return Boolean(f.packageName) || (f.filePath != null && LOCKFILE_RE.test(f.filePath));
}

function guessManifestPath(filePath: string | null | undefined): string {
  if (!filePath) return 'package.json';
  const base = filePath.split('/').pop() ?? filePath;
  switch (base) {
    case 'package-lock.json':
    case 'yarn.lock':
    case 'pnpm-lock.yaml':
      return filePath.replace(/[^/]+$/, 'package.json');
    case 'Pipfile.lock':
      return filePath.replace(/[^/]+$/, 'Pipfile');
    case 'go.sum':
      return filePath.replace(/[^/]+$/, 'go.mod');
    case 'Gemfile.lock':
      return filePath.replace(/[^/]+$/, 'Gemfile');
    case 'Cargo.lock':
      return filePath.replace(/[^/]+$/, 'Cargo.toml');
    default:
      return 'package.json';
  }
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return [
    ...lines.slice(0, maxLines),
    `... (truncated, ${lines.length - maxLines} more lines)`,
  ].join('\n');
}

const MODEL = DEFAULT_CLAUDE_MODEL;
const MAX_TOKENS_PER_TURN = 4096;

async function recordAnalysis(params: {
  auth: { userId: string; email: string; orgId: string; role: string };
  findingId: string | null;
  analysisMarkdown: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  if (!params.findingId || !params.analysisMarkdown.trim()) return;
  const backendUrl =
    process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';
  try {
    const token = signBackendToken({
      sub: params.auth.userId,
      email: params.auth.email,
      org_id: params.auth.orgId,
      role: params.auth.role,
    });
    await fetch(`${backendUrl}/internal/analysis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        findingId: params.findingId,
        analysisMarkdown: params.analysisMarkdown,
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
      }),
    });
  } catch {
    // non-fatal: a persistence failure must not break the analysis stream.
  }
}

async function recordAnalysisTokens(params: {
  auth: { userId: string; email: string; orgId: string; role: string };
  findingId: string | null;
  findingTitle: string | null;
  findingSeverity: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  prompt: string;
  response: string;
}): Promise<void> {
  const backendUrl = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';
  try {
    // The /internal/* backend routes are JWT-guarded (no legacy shared-secret).
    // Org identity travels in the signed token; the backend resolves it from the
    // verified claim, so we never send an orgId in the body (single-tenant).
    const token = signBackendToken({
      sub: params.auth.userId,
      email: params.auth.email,
      org_id: params.auth.orgId,
      role: params.auth.role,
    });
    await fetch(`${backendUrl}/internal/token-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        operation: 'analysis',
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        findingId: params.findingId,
        findingTitle: params.findingTitle,
        findingSeverity: params.findingSeverity,
        prompt: params.prompt,
        response: params.response,
      }),
    });
  } catch {
    // non-fatal: don't break analysis stream on telemetry failure
  }
}

function buildSystemPrompt(finding: AnalyzeRequest, owner: string, repo: string): string {
  const lineHint = finding.lineRange
    ? `${finding.filePath}:${finding.lineRange[0]}-${finding.lineRange[1]}`
    : finding.filePath ?? '(no specific file reported)';

  const header = [
    'You are a senior application security engineer reviewing a vulnerability finding.',
    `The repository under review is \`${owner}/${repo}\` (default branch).`,
    'You have read-only access via three tools: `read_file`, `list_directory`, and `grep_code`.',
  ];

  const job = isScaFinding(finding)
    ? [
        '## Your job',
        'This is a third-party DEPENDENCY vulnerability (SCA finding). The fix is almost certainly',
        'a manifest version bump — NOT a source-code patch.',
        '',
        '- Do NOT grep the source for the package name. Transitive deps will not appear there.',
        '- Do NOT try to read the lockfile (`package-lock.json`, etc.) — it is too large to fetch.',
        '- The relevant manifest is already in the initial user message under `## Repo context`,',
        '  formatted exactly as `read_file` would return it (with line numbers). Cite line numbers',
        '  directly from that block. Do NOT call `read_file` on the manifest again.',
        '',
        'Steps:',
        '1. Read the manifest in `## Repo context`. Determine whether the vulnerable package is a',
        '   DIRECT dep (listed in `dependencies`/`devDependencies` or equivalent) or TRANSITIVE.',
        '2. The Proposed Diff MUST target the manifest, not source code:',
        '   - Direct dep → bump the version constraint to one that satisfies `>= fixedVersion`.',
        '   - Transitive (npm) → add an `overrides` block; (yarn/pnpm) → `resolutions`; otherwise',
        '     upgrade the parent dep that pulls it in.',
      ]
    : [
        '## Your job',
        '1. Read the actual code the scanner flagged. Start with `read_file` at the reported location:',
        `   ${lineHint}.`,
        '2. Confirm or refute the finding by examining the real code, not just the scanner metadata.',
        '3. If needed, follow data flow: use `grep_code` to find call sites or definitions, and ',
        '   `list_directory` / `read_file` to inspect related files.',
        '4. Once you have enough evidence, produce the final structured response.',
      ];

  const guidelines = [
    '## Investigation guidelines',
    '- Always cite specific files and line numbers in your reasoning, drawn from what you actually read.',
    '- Prefer narrow line ranges (e.g. 50 lines around the reported issue) over fetching whole files.',
    '- If a tool returns an error (file moved, access denied, no matches), adapt and try another approach.',
    '- Do NOT repeat the same failing tool call — the loop will reject duplicate failures.',
    '- GitHub code search allows roughly 10 searches per minute, so budget `grep_code` calls: choose',
    '  queries deliberately, never repeat an identical query, and prefer `read_file` / `list_directory`',
    '  when you already know the path.',
    '- Stop investigating and write the final response once you have enough to give a grounded verdict.',
  ];

  const format = [
    '## Final response format',
    'When you have finished investigating, respond with EXACTLY these headers, in this order:',
    '',
    '### Risk Assessment',
    'What this vulnerability means in practical terms for THIS codebase, given what you read. ',
    'What could an attacker do? How likely is exploitation? 3–5 sentences.',
    '',
    '### Root Cause',
    'The technical reason the vulnerability exists, citing specific lines you read (e.g. ',
    '`src/auth.ts:142-148`, or `package.json:23` for SCA findings). 2–4 sentences.',
    '',
    '### Recommended Fix',
    'The fix approach in plain language, grounded in the actual code. 2–4 sentences.',
    '',
    '### Proposed Diff',
    'A valid unified diff that fixes the vulnerability. Wrap it in a ```diff fenced block. The diff',
    'MUST apply cleanly to the file content you fetched — do not invent surrounding lines.',
    'For SCA findings the diff targets the MANIFEST (e.g. `package.json`), not source code.',
    '',
    '### References',
    '2–3 markdown links to NVD, CWE, GHSA, or relevant advisories.',
  ];

  return [...header, '', ...job, '', ...guidelines, '', ...format].join('\n');
}

interface RepoContext {
  rootListing: string | null;
  manifest: { path: string; content: string } | null;
  /**
   * Maps canonical tool-call signatures to the exact text shown in the user
   * message. Passed to the agent loop so re-fetches of pre-included context
   * are short-circuited without a GitHub round-trip.
   */
  cache: Map<string, string>;
}

function buildInitialUserMessage(finding: AnalyzeRequest, repoCtx: RepoContext): string {
  const lines: string[] = [];
  lines.push('## Scanner finding');
  lines.push(`- Title: ${finding.title}`);
  lines.push(`- Severity: ${finding.severity.toUpperCase()}`);
  lines.push(`- Scanner: ${finding.scannerSource}`);
  if (finding.cveId) lines.push(`- CVE: ${finding.cveId}`);
  if (finding.cweId) lines.push(`- CWE: ${finding.cweId}`);
  if (finding.cvssScore !== null) lines.push(`- CVSS: ${finding.cvssScore}`);
  if (finding.epssScore !== null) lines.push(`- EPSS: ${(finding.epssScore * 100).toFixed(1)}%`);
  if (finding.filePath) {
    let fileInfo = `- File: ${finding.filePath}`;
    if (finding.lineRange) fileInfo += ` (lines ${finding.lineRange[0]}-${finding.lineRange[1]})`;
    lines.push(fileInfo);
  }
  if (finding.description) {
    lines.push('');
    lines.push('### Scanner description');
    lines.push(finding.description);
  }

  if (finding.packageName) {
    lines.push('');
    lines.push('## Package context');
    lines.push(`- Package: ${finding.packageName}`);
    if (finding.currentVersion) lines.push(`- Installed version: ${finding.currentVersion}`);
    if (finding.fixedVersion) lines.push(`- Fixed in: ${finding.fixedVersion}`);
    const raw = finding.rawPayload ?? {};
    const cweClasses = Array.isArray((raw as { cwe_classes?: unknown }).cwe_classes)
      ? ((raw as { cwe_classes: unknown[] }).cwe_classes.filter(
          (c): c is string => typeof c === 'string',
        ) as string[])
      : [];
    if (cweClasses.length > 0) lines.push(`- Aikido CWE classes: ${cweClasses.join(', ')}`);
    const rule = (raw as { rule?: unknown }).rule;
    if (typeof rule === 'string' && rule.length > 0) {
      lines.push(`- Aikido rule: ${rule}`);
    }
  }

  if (repoCtx.rootListing || repoCtx.manifest) {
    lines.push('');
    lines.push('## Repo context');
    lines.push(
      'Cached output of tool calls already made on your behalf, in the exact shape the tools return. ' +
        'Treat as canonical — do NOT re-fetch these paths.',
    );
    if (repoCtx.rootListing) {
      lines.push('');
      lines.push('--- list_directory: / ---');
      lines.push(repoCtx.rootListing);
    }
    if (repoCtx.manifest) {
      lines.push('');
      lines.push(`--- read_file: ${repoCtx.manifest.path} ---`);
      lines.push(repoCtx.manifest.content);
    }
  }

  lines.push('');
  lines.push(
    'Investigate the repository using your tools, then produce the structured analysis.',
  );
  return lines.join('\n');
}

async function prefetchRepoContext(
  finding: AnalyzeRequest,
  toolCtx: ToolContext,
): Promise<RepoContext> {
  const rootPromise = dispatchTool('list_directory', { path: '' }, toolCtx);
  const manifestPath = guessManifestPath(finding.filePath);
  const manifestPromise = isScaFinding(finding)
    ? dispatchTool('read_file', { path: manifestPath }, toolCtx)
    : Promise.resolve(null);

  const [rootResult, manifestResult] = await Promise.all([rootPromise, manifestPromise]);

  const cache = new Map<string, string>();
  const rootListing = rootResult.ok ? rootResult.content : null;
  if (rootListing) {
    cache.set(callSignature('list_directory', { path: '' }), rootListing);
  }

  let manifest: { path: string; content: string } | null = null;
  if (manifestResult && manifestResult.ok) {
    const shown = truncateLines(manifestResult.content, 200);
    manifest = { path: manifestPath, content: shown };
    // Cache the same text we show in the user message so a re-fetch replays
    // identical content. The model never sees a discrepancy.
    cache.set(callSignature('read_file', { path: manifestPath }), shown);
  }

  return { rootListing, manifest, cache };
}

function parseRepo(
  repo: string,
  defaultOwner: string | null,
): { owner: string; name: string } | null {
  if (!repo || repo.toLowerCase() === 'unknown') return null;
  const parts = repo.split('/').filter(Boolean);
  if (parts.length === 2) {
    return { owner: parts[0], name: parts[1] };
  }
  if (parts.length === 1 && defaultOwner) {
    // Scanners like Aikido report a bare repo name. Use the connected GitHub
    // App installation's account as the owner.
    return { owner: defaultOwner, name: parts[0] };
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission('fixes:write');
    const apiKey =
      (await getConnectionSecret('anthropic'))?.secret ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Anthropic API key not configured. Go to Settings to connect Claude AI.' },
        { status: 401 },
      );
    }

    const installation = await getInstallationFromOrg();
    if (!installation) {
      return NextResponse.json(
        { error: 'GitHub App is not connected. Go to Settings to connect GitHub.' },
        { status: 400 },
      );
    }

    const body: AnalyzeRequest = await req.json();
    const repoParts = parseRepo(body.repo ?? '', installation.account ?? null);
    if (!repoParts) {
      return NextResponse.json(
        {
          error:
            `This finding has no repository attached (scanner reported repo: "${body.repo ?? ''}"). ` +
            'The AI agent needs a real repository to read code from.',
        },
        { status: 400 },
      );
    }

    // Pre-flight: confirm the GitHub App installation can actually read this
    // repo before spinning up the agent. GitHub returns 404 (not 403) when an
    // installation isn't granted access to a repo, so a 404 here usually means
    // the repo isn't in the App's "selected repositories" list, not that it
    // doesn't exist.
    try {
      await githubApiFetch<{ id: number; full_name: string }>(
        `/repos/${repoParts.owner}/${repoParts.name}`,
        installation.installationId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.match(/error: (\d{3})/)?.[1] ?? '';
      const fullName = `${repoParts.owner}/${repoParts.name}`;
      const targetType = installation.targetType ?? 'Organization';
      const settingsUrl =
        targetType === 'User'
          ? `https://github.com/settings/installations/${installation.installationId}`
          : `https://github.com/organizations/${repoParts.owner}/settings/installations/${installation.installationId}`;
      if (status === '404') {
        return NextResponse.json(
          {
            error:
              `The connected GitHub App can't see ${fullName}. ` +
              `Either the repo doesn't exist at this exact name, or it isn't included in the App's "Repository access" list. ` +
              `Check ${settingsUrl}.`,
          },
          { status: 400 },
        );
      }
      if (status === '403') {
        return NextResponse.json(
          {
            error:
              `GitHub App lacks permission to read ${fullName}. ` +
              'Make sure the App has "Contents: Read" permission and that the installation is approved on the org.',
          },
          { status: 400 },
        );
      }
      return NextResponse.json(
        { error: `Failed to verify GitHub access to ${fullName}: ${msg}` },
        { status: 502 },
      );
    }

    const client = new Anthropic({ apiKey });
    const toolContext: ToolContext = {
      installationId: installation.installationId,
      owner: repoParts.owner,
      repo: repoParts.name,
    };
    const repoCtx = await prefetchRepoContext(body, toolContext);
    const system = buildSystemPrompt(body, repoParts.owner, repoParts.name);
    const initialUserMessage = buildInitialUserMessage(body, repoCtx);

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        // Accumulate the clean analysis markdown (only `text` events) so it can
        // be persisted to the DB. This matches exactly what the client builds
        // into `localRaw`; the agent's transcriptResponse is unusable here
        // because it interleaves iteration markers and tool-use summaries.
        let analysisMarkdown = '';
        const send = (event: AgentEvent | { type: 'text'; text: string }) => {
          if (event.type === 'text' && typeof event.text === 'string') {
            analysisMarkdown += event.text;
          }
          // Backward-compatible payload shape: text events still expose a top-level `text` field.
          const payload = JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        };

        try {
          const result = await runAnalysisAgent({
            client,
            model: MODEL,
            maxTokens: MAX_TOKENS_PER_TURN,
            system,
            initialUserMessage,
            toolContext,
            preFetched: repoCtx.cache,
            onEvent: send,
          });

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));

          await recordAnalysisTokens({
            auth,
            findingId: body.findingId ?? null,
            findingTitle: body.title ?? null,
            findingSeverity: body.severity ?? null,
            model: MODEL,
            inputTokens: result.totalInputTokens,
            outputTokens: result.totalOutputTokens,
            prompt: result.transcriptPrompt,
            response: result.transcriptResponse,
          });

          // Persist the analysis narrative itself so it survives reloads, new
          // tabs, re-login, and redeploys (replaces the old sessionStorage cache).
          await recordAnalysis({
            auth,
            findingId: body.findingId ?? null,
            analysisMarkdown,
            model: MODEL,
            inputTokens: result.totalInputTokens,
            outputTokens: result.totalOutputTokens,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Stream error';
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to start analysis';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
