'use client';

import { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { SeverityBadge, StatusBadge } from '@/components/badge';
import { DiffViewer } from '@/components/diff-viewer';
import { useFindings } from '@/contexts/findings-context';
import {
  fetchFinding,
  fetchFindingTokenCost,
  type FindingCostBreakdown,
} from '@/lib/backend-client';
import type { Finding } from '@/types';
import { classifyRemediationClass, getContainerRemediation } from '@sutura/common';
import { ValidatedFixPanel, useValidatedFix } from './validated-fix-panel';

function isAnalyzableRepo(repo: string | null | undefined): boolean {
  if (!repo) return false;
  if (repo.toLowerCase() === 'unknown') return false;
  const parts = repo.split('/').filter(Boolean);
  // Accept "owner/name" or a bare name — the analyze route fills in the owner
  // from the connected GitHub App installation when only a bare name is given.
  return parts.length === 1 || parts.length === 2;
}

function timeAgo(dateStr: string): string {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now.getTime() - then.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// ---------------------------------------------------------------------------
// Parse analysis markdown into sections
// ---------------------------------------------------------------------------

interface AnalysisResult {
  riskAssessment: string;
  rootCause: string;
  recommendedFix: string;
  proposedDiff: string;
  references: string;
}

function parseAnalysis(raw: string): AnalysisResult {
  const result: AnalysisResult = {
    riskAssessment: '',
    rootCause: '',
    recommendedFix: '',
    proposedDiff: '',
    references: '',
  };

  const sections = raw.split(/^### /m).filter(Boolean);
  for (const section of sections) {
    const newlineIdx = section.indexOf('\n');
    if (newlineIdx === -1) continue;
    const heading = section.slice(0, newlineIdx).trim().toLowerCase();
    const body = section.slice(newlineIdx + 1).trim();

    if (heading.includes('risk assessment')) result.riskAssessment = body;
    else if (heading.includes('root cause')) result.rootCause = body;
    else if (heading.includes('recommended fix')) result.recommendedFix = body;
    else if (heading.includes('proposed diff')) result.proposedDiff = extractDiff(body);
    else if (heading.includes('references')) result.references = body;
  }

  return result;
}

function extractDiff(body: string): string {
  const match = body.match(/```diff\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  const fenced = body.match(/```[\w]*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return body;
}

/** Renders inline markdown: bold, inline code, links */
function renderInline(text: string) {
  // Split by: **bold**, `code`, [link](url)
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((token, i) => {
    const boldMatch = token.match(/^\*\*(.+)\*\*$/);
    if (boldMatch) {
      return <strong key={i} className="font-semibold text-navy">{boldMatch[1]}</strong>;
    }
    const codeMatch = token.match(/^`(.+)`$/);
    if (codeMatch) {
      return (
        <code key={i} className="rounded bg-cream-warm px-1 py-0.5 font-mono text-xs text-navy">
          {codeMatch[1]}
        </code>
      );
    }
    const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={i}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-orange hover:underline"
        >
          {linkMatch[1]}
        </a>
      );
    }
    return <span key={i}>{token}</span>;
  });
}

/** Renders a block of markdown text into paragraphs, lists, and code blocks */
function MarkdownContent({ content }: { content: string }) {
  const blocks = content.split(/\n\n+/);

  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-gray-text">
      {blocks.map((block, i) => {
        const trimmed = block.trim();
        if (!trimmed) return null;

        // Code block
        const codeBlockMatch = trimmed.match(/^```[\w]*\n([\s\S]*?)```$/);
        if (codeBlockMatch) {
          return (
            <pre key={i} className="overflow-x-auto rounded-md bg-navy p-3 font-mono text-xs text-cream/80">
              {codeBlockMatch[1].trim()}
            </pre>
          );
        }

        // Unordered list (lines starting with - or *)
        const lines = trimmed.split('\n');
        const isList = lines.every((l) => /^\s*[-*]\s/.test(l));
        if (isList) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((line, j) => (
                <li key={j}>{renderInline(line.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }

        // Ordered list (lines starting with 1. 2. etc)
        const isOrderedList = lines.every((l) => /^\s*\d+\.\s/.test(l));
        if (isOrderedList) {
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {lines.map((line, j) => (
                <li key={j}>{renderInline(line.replace(/^\s*\d+\.\s+/, ''))}</li>
              ))}
            </ol>
          );
        }

        // Regular paragraph
        return <p key={i}>{renderInline(trimmed)}</p>;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verification gate card
// ---------------------------------------------------------------------------

function VerdictRow({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const color =
    tone === 'good'
      ? 'text-status-success'
      : tone === 'bad'
        ? 'text-status-failed'
        : 'text-navy';
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-text">{label}</span>
      <span className={`font-medium ${color}`}>{value}</span>
    </div>
  );
}

/**
 * Read-only display of the pre-fix verification (exploitability) gate verdict.
 * Renders nothing until a verdict exists. When the gate marked the finding as
 * won't-fix it shows a clear "Skipped" state.
 */
function VerificationCard({ finding }: { finding: Finding }) {
  const verdict = finding.verificationVerdict;
  if (!verdict) return null;

  const skipped =
    finding.status === 'wont_fix' &&
    (verdict.isReal === false || (verdict.reachable === false && verdict.confidence === 'high'));

  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold text-navy">Verification</h2>

      {skipped && (
        <div className="mb-4 rounded-md border border-status-failed/30 bg-status-failed/5 px-3 py-2">
          <p className="text-xs font-semibold text-status-failed">
            Skipped: marked won&apos;t fix by verification gate
          </p>
          <p className="mt-1 text-xs text-gray-text">
            The verification agent judged this finding not worth a fix attempt. No PR was opened.
          </p>
        </div>
      )}

      <div className="mb-3 flex flex-col gap-2">
        <VerdictRow
          label="Real vulnerability"
          value={verdict.isReal ? 'Yes' : 'No'}
          tone={verdict.isReal ? 'bad' : 'good'}
        />
        <VerdictRow
          label="Reachable"
          value={verdict.reachable ? 'Yes' : 'No'}
          tone={verdict.reachable ? 'bad' : 'good'}
        />
        <VerdictRow label="Exploitability" value={verdict.exploitability} />
        <VerdictRow label="Confidence" value={verdict.confidence} />
        {verdict.verifiedAt && (
          <VerdictRow label="Verified" value={timeAgo(verdict.verifiedAt)} tone="neutral" />
        )}
      </div>

      {verdict.reasoning && (
        <div className="rounded-md border border-border bg-cream-warm px-3 py-2">
          <p className="mb-0.5 text-[11px] uppercase tracking-wider text-gray-text">Reasoning</p>
          <p className="text-xs leading-relaxed text-navy">{verdict.reasoning}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress steps for the analysis
// ---------------------------------------------------------------------------

const ANALYSIS_STEPS = [
  'Reading vulnerability data',
  'Assessing risk level',
  'Identifying root cause',
  'Generating fix proposal',
  'Compiling references',
];

function getActiveStep(raw: string): number {
  if (!raw) return 0;
  const lower = raw.toLowerCase();
  if (lower.includes('### references')) return 4;
  if (lower.includes('### proposed diff')) return 3;
  if (lower.includes('### recommended fix')) return 3;
  if (lower.includes('### root cause')) return 2;
  if (lower.includes('### risk assessment')) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Analyze hook
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  status: 'pending' | 'ok' | 'error';
  summary: string;
}

function describeToolInput(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const path = typeof obj.path === 'string' ? obj.path : undefined;
  const start = typeof obj.start_line === 'number' ? obj.start_line : undefined;
  const end = typeof obj.end_line === 'number' ? obj.end_line : undefined;
  const query = typeof obj.query === 'string' ? obj.query : undefined;
  if (name === 'read_file' && path) {
    if (start && end) return `read_file ${path}:${start}-${end}`;
    if (start) return `read_file ${path}:${start}-`;
    return `read_file ${path}`;
  }
  if (name === 'list_directory') return `list_directory ${path || '/'}`;
  if (name === 'grep_code' && query) return `grep_code "${query}"`;
  return name;
}

function useAnalyze(finding: Finding | undefined) {
  const [raw, setRaw] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);

  // Load the persisted analysis from the DB when the finding changes. The
  // analysis is DB-backed (no longer sessionStorage), so it survives reloads,
  // new tabs, re-login, and redeploys. Tool-call activity stays ephemeral.
  useEffect(() => {
    if (!finding) return;
    const findingId = finding.id;
    let cancelled = false;

    setRaw('');
    setDone(false);
    setError(null);
    setToolCalls([]);

    (async () => {
      try {
        const res = await fetch(`/api/findings/${findingId}/analysis`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { analysisMarkdown?: string } | null;
        // Ignore a stale response if the finding changed while we were fetching.
        if (cancelled || !data?.analysisMarkdown) return;
        setRaw(data.analysisMarkdown);
        setDone(true);
      } catch {
        // Non-fatal: leave the page in its "not analyzed yet" state.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [finding]);

  const analyze = useCallback(async (): Promise<string> => {
    if (!finding) return '';
    setAnalyzing(true);
    setDone(false);
    setError(null);
    setRaw('');
    setToolCalls([]);

    // Local accumulator -- React state is async, so we can't read `raw` back
    // synchronously. The promise resolves with this string on success.
    let localRaw = '';

    try {
      const res = await fetch('/api/findings/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          findingId: finding.id,
          title: finding.title,
          description: finding.description,
          severity: finding.severity,
          cveId: finding.cveId,
          cweId: finding.cweId,
          cvssScore: finding.cvssScore,
          epssScore: finding.epssScore,
          filePath: finding.filePath,
          lineRange: finding.lineRange,
          repo: finding.repo,
          scannerSource: finding.scannerSource,
          packageName: finding.packageName,
          currentVersion: finding.currentVersion,
          fixedVersion: finding.fixedVersion,
          rawPayload: finding.rawPayload,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let gotContent = false;

      while (true) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.type === 'error' || parsed.error) {
              throw new Error(parsed.error ?? 'Stream error');
            }
            if (parsed.type === 'tool_call' && typeof parsed.id === 'string') {
              gotContent = true;
              const summary = describeToolInput(parsed.name, parsed.input);
              setToolCalls((prev) => [
                ...prev,
                {
                  id: parsed.id,
                  name: parsed.name,
                  input: parsed.input,
                  status: 'pending',
                  summary,
                },
              ]);
              continue;
            }
            if (parsed.type === 'tool_result' && typeof parsed.id === 'string') {
              gotContent = true;
              setToolCalls((prev) =>
                prev.map((c) =>
                  c.id === parsed.id
                    ? {
                        ...c,
                        status: parsed.ok ? 'ok' : 'error',
                        summary: parsed.summary ?? c.summary,
                      }
                    : c,
                ),
              );
              continue;
            }
            if (parsed.type === 'iteration' || parsed.type === 'done') {
              continue;
            }
            // text events: { type: 'text', text } or legacy { text }
            if (typeof parsed.text === 'string') {
              gotContent = true;
              localRaw += parsed.text;
              setRaw((prev) => prev + parsed.text);
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
              throw e;
            }
          }
        }
      }

      if (!gotContent) {
        throw new Error('No analysis content received. The API key may be invalid or the request was rejected.');
      }

      setDone(true);
      // The backend persists the analysis to the DB when the stream completes
      // (see /api/findings/analyze); no client-side caching needed.
      return localRaw;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Analysis failed';
      setError(msg);
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      setAnalyzing(false);
    }
  }, [finding]);

  return { raw, analyzing, done, error, analyze, toolCalls };
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

function formatUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function operationLabel(op: 'analysis' | 'fix_generation'): string {
  return op === 'analysis' ? 'Analysis' : 'Fix Generation';
}

function useFindingTokenCost(findingId: string | undefined, refreshKey: number) {
  const [data, setData] = useState<FindingCostBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!findingId) return;
    let cancelled = false;
    setLoading(true);
    fetchFindingTokenCost(findingId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [findingId, refreshKey]);

  return { data, loading };
}

export default function FindingDetailPage() {
  const params = useParams<{ id: string }>();
  const { findings, loading } = useFindings();
  // Resolve by either the backend UUID (`f.id` when findings are DB-sourced) or
  // the synthetic `<scanner>-<externalId>` dashboard id (used by fix-attempt
  // "View finding" links and cookie-sourced findings). Matching both keeps every
  // link working regardless of which source populated the list.
  const listFinding = loading
    ? undefined
    : findings.find(
        (f) => f.id === params.id || `${f.scannerSource}-${f.externalId}` === params.id,
      );

  // The provider list is paginated (first page only), so a deep link can point
  // at a finding the list never loaded. Fall back to fetching the single
  // finding by id -- the backend resolves both UUID and `<scanner>-<externalId>`.
  const [fetchedFinding, setFetchedFinding] = useState<Finding | null>(null);
  const [fallbackDone, setFallbackDone] = useState(false);
  useEffect(() => {
    if (loading || listFinding) return;
    let cancelled = false;
    setFallbackDone(false);
    fetchFinding(params.id)
      .then((f) => {
        if (!cancelled) setFetchedFinding(f);
      })
      .catch(() => {
        // 404 or network error: the not-found state below handles it.
      })
      .finally(() => {
        if (!cancelled) setFallbackDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loading, listFinding, params.id]);

  const finding = listFinding ?? fetchedFinding ?? undefined;
  const resolving = loading || (!finding && !fallbackDone);
  const { raw, analyzing, done, error, analyze, toolCalls } = useAnalyze(finding);
  const tokenRefreshKey = analyzing ? 0 : done ? 1 : 2;
  const { data: tokenCost } = useFindingTokenCost(finding?.id, tokenRefreshKey);
  const validatedFix = useValidatedFix(finding?.id ?? '');

  // Orchestrates "analyze first if needed, then trigger fix" so the agent
  // sees the analysis output as priming context. Also forwards the dashboard
  // finding object so the backend can upsert it on first use (cookie-only
  // Aikido findings don't have a backend row until this happens).
  const handleValidatedFix = useCallback(async () => {
    if (!finding) return;
    let analysis = done && raw ? raw : '';
    if (!analysis) {
      try {
        analysis = await analyze();
      } catch {
        // useAnalyze sets the error state; abort silently.
        return;
      }
    }
    await validatedFix.trigger({ priorAnalysis: analysis, finding });
  }, [analyze, done, finding, raw, validatedFix]);

  const analysis = raw ? parseAnalysis(raw) : null;
  const activeStep = getActiveStep(raw);
  const advisory =
    classifyRemediationClass({ repo: finding?.repo, rawPayload: finding?.rawPayload }) ===
    'advisory';
  const remediation = getContainerRemediation(finding?.rawPayload);

  if (resolving) {
    return (
      <>
        <PageHeader
          title="Loading..."
          breadcrumbs={[{ label: 'Findings', href: '/findings' }, { label: '...' }]}
        />
        <div className="h-96 animate-pulse rounded-lg border border-border bg-cream-warm" />
      </>
    );
  }

  if (!finding) {
    return (
      <>
        <PageHeader
          title="Finding Not Found"
          breadcrumbs={[{ label: 'Findings', href: '/findings' }]}
        />
        <div className="rounded-lg border border-border bg-white p-8 text-center">
          <p className="mb-4 text-sm text-gray-text">
            No finding with ID &quot;{params.id}&quot; was found in the current scanner data.
          </p>
          <Link href="/findings" className="text-sm text-orange hover:underline">
            Back to Findings
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={finding.title}
        breadcrumbs={[
          { label: 'Findings', href: '/findings' },
          { label: finding.cveId ?? finding.id },
        ]}
      />

      <div className="grid grid-cols-3 gap-6">
        {/* Left column */}
        <div className="col-span-2 flex flex-col gap-6">
          {/* Scanner report */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold text-navy">Scanner Report</h2>
            {finding.description && (
              <p className="mb-4 text-sm text-gray-text">{finding.description}</p>
            )}

            <div className="mb-4 grid grid-cols-2 gap-3">
              {finding.cveId && (
                <div className="rounded-md border border-border p-3">
                  <p className="mb-0.5 text-[11px] uppercase tracking-wider text-gray-text">CVE</p>
                  <p className="text-sm font-medium text-navy">{finding.cveId}</p>
                </div>
              )}
              {finding.cweId && (
                <div className="rounded-md border border-border p-3">
                  <p className="mb-0.5 text-[11px] uppercase tracking-wider text-gray-text">CWE</p>
                  <p className="text-sm font-medium text-navy">{finding.cweId}</p>
                </div>
              )}
              {finding.cvssScore !== null && (
                <div className="rounded-md border border-border p-3">
                  <p className="mb-0.5 text-[11px] uppercase tracking-wider text-gray-text">
                    CVSS Score
                  </p>
                  <p className="text-sm font-medium text-navy">{finding.cvssScore}</p>
                </div>
              )}
              {finding.epssScore !== null && (
                <div className="rounded-md border border-border p-3">
                  <p className="mb-0.5 text-[11px] uppercase tracking-wider text-gray-text">
                    EPSS Score
                  </p>
                  <p className="text-sm font-medium text-navy">
                    {(finding.epssScore * 100).toFixed(0)}%
                  </p>
                </div>
              )}
            </div>

            {finding.filePath && (
              <div className="rounded-md border border-border bg-cream-warm px-3 py-2">
                <p className="text-[11px] uppercase tracking-wider text-gray-text">File</p>
                <p className="mt-0.5 font-mono text-xs text-navy">
                  {finding.filePath}
                  {finding.lineRange && (
                    <span className="text-gray-muted">
                      :{finding.lineRange[0]}-{finding.lineRange[1]}
                    </span>
                  )}
                </p>
              </div>
            )}
          </div>

          {/* Advisory remediation (container/OS package findings) */}
          {advisory && (
            <div className="rounded-lg border border-border bg-white p-5">
              <h2 className="mb-4 text-sm font-semibold text-navy">Advisory</h2>
              <p className="mb-4 text-sm text-gray-text">
                Container/OS package finding &mdash; no source code to patch. Rebuild the image
                with an updated base image, or upgrade to a published tag that ships the fixed
                package.
              </p>
              {remediation && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border border-border p-3">
                    <p className="mb-0.5 text-[11px] uppercase tracking-wider text-gray-text">
                      Image
                    </p>
                    <p className="font-mono text-sm font-medium text-navy">{remediation.image}</p>
                  </div>
                  {remediation.packageName && (
                    <div className="rounded-md border border-border p-3">
                      <p className="mb-0.5 text-[11px] uppercase tracking-wider text-gray-text">
                        Package
                      </p>
                      <p className="font-mono text-sm font-medium text-navy">
                        {remediation.packageName}
                      </p>
                    </div>
                  )}
                  {(remediation.fromVersion || remediation.toVersion) && (
                    <div className="rounded-md border border-border p-3">
                      <p className="mb-0.5 text-[11px] uppercase tracking-wider text-gray-text">
                        Version
                      </p>
                      <p className="font-mono text-sm font-medium text-navy">
                        {remediation.fromVersion ?? '?'} &rarr; {remediation.toVersion ?? '?'}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Verification gate verdict (read-only) */}
          <VerificationCard finding={finding} />

          {/* Agent activity log -- shows tool calls the AI made against the repo */}
          {(analyzing || toolCalls.length > 0) && toolCalls.length > 0 && (
            <div className="rounded-lg border border-border bg-cream-warm p-5">
              <h2 className="mb-3 text-sm font-semibold text-navy">Agent Activity</h2>
              <ul className="flex flex-col gap-1.5">
                {toolCalls.map((tc) => (
                  <li
                    key={tc.id}
                    className="flex items-center gap-2 font-mono text-xs text-navy"
                  >
                    {tc.status === 'pending' ? (
                      <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange" />
                    ) : tc.status === 'ok' ? (
                      <span className="text-status-success">&#10003;</span>
                    ) : (
                      <span className="text-status-failed">&#10007;</span>
                    )}
                    <span className={tc.status === 'error' ? 'text-status-failed' : undefined}>
                      {tc.summary}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Analysis progress card -- only shows while analyzing */}
          {analyzing && (
            <div className="rounded-lg border border-orange/30 bg-orange/5 p-5">
              <div className="mb-3 flex items-center gap-2">
                <div className="h-2 w-2 animate-pulse rounded-full bg-orange" />
                <h2 className="text-sm font-semibold text-navy">Analyzing vulnerability...</h2>
              </div>
              {/* Progress bar */}
              <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-orange/10">
                <div
                  className="h-full rounded-full bg-orange transition-all duration-700 ease-out"
                  style={{ width: `${Math.min(((activeStep + 1) / ANALYSIS_STEPS.length) * 100, 100)}%` }}
                />
              </div>
              {/* Steps */}
              <div className="flex flex-col gap-1.5">
                {ANALYSIS_STEPS.map((step, i) => (
                  <div key={step} className="flex items-center gap-2">
                    {i < activeStep ? (
                      <span className="text-xs text-status-success">&#10003;</span>
                    ) : i === activeStep ? (
                      <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange" />
                    ) : (
                      <div className="h-1.5 w-1.5 rounded-full bg-gray-200" />
                    )}
                    <span
                      className={`text-xs ${
                        i < activeStep
                          ? 'text-status-success'
                          : i === activeStep
                            ? 'font-medium text-navy'
                            : 'text-gray-muted'
                      }`}
                    >
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Risk Assessment */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-navy">Risk Assessment</h2>
            {analysis?.riskAssessment ? (
              <MarkdownContent content={analysis.riskAssessment} />
            ) : (
              <p className="text-sm text-gray-muted">
                {analyzing ? 'Analyzing...' : 'Click "Analyze" to get an AI risk assessment.'}
              </p>
            )}
          </div>

          {/* Root Cause */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-navy">Root Cause</h2>
            {analysis?.rootCause ? (
              <MarkdownContent content={analysis.rootCause} />
            ) : (
              <p className="text-sm text-gray-muted">
                {analyzing ? 'Analyzing...' : 'Click "Analyze" to identify the root cause.'}
              </p>
            )}
          </div>

          {/* Recommended Fix */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-navy">Recommended Fix</h2>
            {analysis?.recommendedFix ? (
              <MarkdownContent content={analysis.recommendedFix} />
            ) : (
              <p className="text-sm text-gray-muted">
                {analyzing ? 'Generating...' : 'Click "Analyze" to get a fix recommendation.'}
              </p>
            )}
          </div>

          {/* Proposed Diff */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-navy">Proposed Diff</h2>
            {analysis?.proposedDiff ? (
              <DiffViewer diff={analysis.proposedDiff} />
            ) : (
              <p className="text-sm text-gray-muted">
                {analyzing ? 'Generating diff...' : 'Click "Analyze" to generate a fix diff.'}
              </p>
            )}
          </div>

          {/* Validated Fix -- only renders when there are attempts or an error. */}
          <ValidatedFixPanel state={validatedFix} />

          {/* References */}
          {analysis?.references && (
            <div className="rounded-lg border border-border bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-navy">References</h2>
              <MarkdownContent content={analysis.references} />
            </div>
          )}

          {/* Guide the Fix */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-1 text-sm font-semibold text-navy">Guide the Fix</h2>
            <p className="mb-3 text-xs text-gray-text">
              Provide additional context or instructions to steer the AI&apos;s next fix attempt.
            </p>
            <textarea
              rows={3}
              disabled
              placeholder="Fix pipeline not connected yet"
              className="mb-3 w-full resize-none rounded-md border border-border bg-cream-warm px-3 py-2 text-sm text-navy placeholder:text-gray-muted opacity-50 cursor-not-allowed"
            />
            <div className="flex items-center gap-2">
              <button
                disabled
                className="rounded-md bg-orange px-4 py-2 text-sm font-semibold text-white opacity-50 cursor-not-allowed"
              >
                Retry with Prompt
              </button>
              <button
                disabled
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-navy opacity-50 cursor-not-allowed"
              >
                Modify Last Diff
              </button>
              <button
                disabled
                className="px-4 py-2 text-sm text-gray-text opacity-50 cursor-not-allowed"
              >
                Open PR As-Is
              </button>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="col-span-1 flex flex-col gap-6">
          {/* Status */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-navy">Status</h2>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-text">Severity</span>
                <SeverityBadge severity={finding.severity} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-text">Status</span>
                <StatusBadge status={finding.status} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-text">Scanner</span>
                <span className="text-xs text-navy">{finding.scannerSource}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-text">Repo</span>
                <span className="text-xs text-navy">{finding.repo}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-text">Detected</span>
                <span className="text-xs text-navy">{timeAgo(finding.ingestedAt)}</span>
              </div>
            </div>
          </div>

          {/* Token Cost */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-navy">Token Cost</h2>
            {tokenCost && tokenCost.calls > 0 ? (
              <>
                {tokenCost.lastRun && (
                  <div className="mb-3 border-b border-border pb-3">
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="text-xs text-gray-text">Last analysis</span>
                      <span className="font-mono text-lg font-semibold text-orange">
                        {formatUsd(tokenCost.lastRun.costUsd)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-text">Input tokens</span>
                        <span className="font-mono text-navy">
                          {formatTokens(tokenCost.lastRun.inputTokens)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-text">Output tokens</span>
                        <span className="font-mono text-navy">
                          {formatTokens(tokenCost.lastRun.outputTokens)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="text-xs text-gray-text">Total spent</span>
                  <span className="font-mono text-sm font-semibold text-navy">
                    {formatUsd(tokenCost.costUsd)}
                  </span>
                </div>
                <div className="mb-3 flex flex-col gap-1.5 border-b border-border pb-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-text">Analyses</span>
                    <span className="font-mono text-navy">{tokenCost.calls}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-text">Input tokens</span>
                    <span className="font-mono text-navy">{formatTokens(tokenCost.inputTokens)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-text">Output tokens</span>
                    <span className="font-mono text-navy">{formatTokens(tokenCost.outputTokens)}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  {tokenCost.byOperation.map((op) => (
                    <div key={op.operation} className="flex items-center justify-between text-xs">
                      <span className="text-gray-text">{operationLabel(op.operation)}</span>
                      <span className="font-mono text-navy">
                        {formatUsd(op.costUsd)}
                        <span className="ml-1 text-gray-muted">({op.calls})</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-muted">No token usage recorded yet.</p>
            )}
          </div>

          {/* Fix Attempts */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-navy">Fix Attempts</h2>
            <p className="text-sm text-gray-muted">No fix attempts yet.</p>
          </div>

          {/* Actions */}
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-navy">Actions</h2>
            <div className="flex flex-col gap-2">
              <button
                onClick={analyze}
                disabled={analyzing || !isAnalyzableRepo(finding.repo)}
                className="w-full rounded-md bg-orange px-4 py-2 text-sm font-semibold text-white hover:bg-orange/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {analyzing ? 'Analyzing...' : done ? 'Re-analyze' : 'Analyze'}
              </button>
              <button
                onClick={() => void handleValidatedFix()}
                disabled={
                  analyzing ||
                  validatedFix.busy ||
                  validatedFix.status?.running ||
                  !isAnalyzableRepo(finding.repo) ||
                  advisory
                }
                className="w-full rounded-md border border-orange bg-orange/10 px-4 py-2 text-sm font-semibold text-orange hover:bg-orange/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {validatedFix.status?.running
                  ? 'Running...'
                  : validatedFix.busy
                    ? 'Starting fix...'
                    : analyzing
                      ? 'Analyzing first...'
                      : validatedFix.hasAttempts
                        ? 'Retry Validated Fix'
                        : 'Generate Validated Fix'}
              </button>
              <button
                disabled
                className="w-full rounded-md border border-border px-4 py-2 text-sm font-medium text-gray-text opacity-50 cursor-not-allowed"
              >
                Mark as Won&apos;t Fix
              </button>
            </div>
            {advisory && (
              <p className="mt-2 text-xs text-gray-text">
                Advisory findings cannot be auto-fixed &mdash; see the remediation above.
              </p>
            )}
            {!advisory && !isAnalyzableRepo(finding.repo) && (
              <p className="mt-2 text-xs text-gray-text">
                This finding has no repository attached (scanner reported{' '}
                <code className="font-mono">{finding.repo || '(empty)'}</code>), so the AI agent
                has nothing to read. Analysis is disabled.
              </p>
            )}
            {error && (
              <p className="mt-2 text-xs text-status-failed">
                {error}
                {error.includes('Settings') && (
                  <>
                    {' '}
                    <Link href="/settings" className="underline hover:text-orange">
                      Open Settings
                    </Link>
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
