'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { GitHubConnection } from '@/components/settings/github-connection';
import { SnykConnection } from '@/components/settings/snyk-connection';
import { AikidoConnection } from '@/components/settings/aikido-connection';
import { AnthropicConnection } from '@/components/settings/anthropic-connection';

interface ScannerCard {
  id: string;
  name: string;
  description: string;
  status: 'connected' | 'disconnected' | 'coming_soon';
  icon: string;
}

const SCANNERS: ScannerCard[] = [
  {
    id: 'dependabot',
    name: 'Dependabot',
    description: 'GitHub automated dependency updates and security alerts',
    status: 'disconnected',
    icon: 'D',
  },
  {
    id: 'sonarqube',
    name: 'SonarQube',
    description: 'Continuous code quality and security inspection',
    status: 'coming_soon',
    icon: 'Q',
  },
];

const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;

export default function SettingsPage() {
  const [minSeverity, setMinSeverity] = useState<string>('high');
  const [autoMerge, setAutoMerge] = useState(false);
  const [targetBranch, setTargetBranch] = useState('main');
  const [branchNaming, setBranchNaming] = useState('sutura/fix-{finding-id}');
  const [reviewAssignment, setReviewAssignment] = useState('');

  const branchPreview = branchNaming.replace('{finding-id}', 'finding-abc123');

  return (
    <>
      <PageHeader title="Settings" subtitle="Configure AutoFix behavior and integrations" />

      <div className="space-y-6">
        {/* GitHub Connection */}
        <section className="rounded-lg border border-border bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-text">
            GitHub Connection
          </h2>
          <GitHubConnection />
        </section>

        {/* AutoFix Config */}
        <section className="rounded-lg border border-border bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-text">
            AutoFix Config
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-navy">Minimum Severity</label>
                <p className="text-xs text-gray-text">
                  Only trigger AutoFix for findings at or above this severity
                </p>
              </div>
              <select
                value={minSeverity}
                onChange={(e) => setMinSeverity(e.target.value)}
                className="rounded border border-border bg-white px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-orange"
              >
                {SEVERITY_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between border-t border-border-light pt-4">
              <div>
                <label className="text-sm font-medium text-navy">AutoMerge</label>
                <p className="text-xs text-gray-text">
                  Automatically merge PRs when tests pass (requires branch protection)
                </p>
              </div>
              <button
                onClick={() => setAutoMerge((v) => !v)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  autoMerge ? 'bg-orange' : 'bg-gray-200'
                }`}
                aria-pressed={autoMerge}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    autoMerge ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        {/* AI Provider */}
        <section className="rounded-lg border border-border bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-text">
            AI Provider
          </h2>
          <AnthropicConnection />
        </section>

        {/* Scanner Connections */}
        <section className="rounded-lg border border-border bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-text">
            Scanner Connections
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SnykConnection />
            <AikidoConnection />
            {SCANNERS.map((scanner) => (
              <div
                key={scanner.id}
                className="flex items-center justify-between rounded-md border border-border-light p-4"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-cream-warm text-sm font-bold text-navy">
                    {scanner.icon}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-navy">{scanner.name}</p>
                    <p className="text-xs text-gray-text">{scanner.description}</p>
                  </div>
                </div>
                <div className="ml-4 shrink-0">
                  {scanner.status === 'connected' && (
                    <span className="flex items-center gap-1 text-xs text-status-success">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-success" />
                      Connected
                    </span>
                  )}
                  {scanner.status === 'disconnected' && (
                    <button className="rounded border border-orange px-2.5 py-1 text-xs font-medium text-orange hover:bg-orange hover:text-white">
                      Connect
                    </button>
                  )}
                  {scanner.status === 'coming_soon' && (
                    <span className="rounded bg-cream-warm px-2 py-0.5 text-[10px] font-medium text-gray-muted">
                      Coming Soon
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Branch Strategy */}
        <section className="rounded-lg border border-border bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-text">
            Branch Strategy
          </h2>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Target Branch</label>
              <input
                type="text"
                value={targetBranch}
                onChange={(e) => setTargetBranch(e.target.value)}
                className="w-full max-w-xs rounded border border-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-orange"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">
                Branch Naming Convention
              </label>
              <input
                type="text"
                value={branchNaming}
                onChange={(e) => setBranchNaming(e.target.value)}
                className="w-full max-w-sm rounded border border-border px-3 py-1.5 font-mono text-sm text-navy focus:outline-none focus:ring-2 focus:ring-orange"
              />
              <p className="mt-1.5 text-xs text-gray-text">
                Preview:{' '}
                <code className="rounded bg-cream-warm px-1.5 py-0.5 font-mono text-[11px] text-navy">
                  {branchPreview}
                </code>
              </p>
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="rounded-lg border border-border bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-text">
            Notifications
          </h2>
          <p className="text-sm text-gray-text">
            Notification settings coming soon. Webhook and email delivery will be configurable here.
          </p>
        </section>

        {/* Review Assignment */}
        <section className="rounded-lg border border-border bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-text">
            Review Assignment
          </h2>
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">
              Default Reviewer (GitHub username or team slug)
            </label>
            <input
              type="text"
              value={reviewAssignment}
              onChange={(e) => setReviewAssignment(e.target.value)}
              placeholder="e.g. security-team or @alice"
              className="w-full max-w-sm rounded border border-border px-3 py-1.5 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </div>
        </section>
      </div>
    </>
  );
}
